-- Attendance integration boundary.
-- Attendance keeps its existing operational tables and history. This adds
-- protected Central Registry reads, a durable roster-sync audit, and the
-- read-only Workspace summary contract. It does not create attendance events.

alter table public.attendance_student_roster
  add column if not exists academic_term text;
alter table public.attendance_student_roster
  add column if not exists central_person_id uuid;
alter table public.attendance_student_roster
  add column if not exists pupil_status text;
alter table public.attendance_student_roster
  add column if not exists source_valid_from date;
alter table public.attendance_student_roster
  add column if not exists source_valid_until date;
alter table public.attendance_student_roster
  add column if not exists source_sync_run_id uuid;

create index if not exists attendance_student_roster_context_idx
  on public.attendance_student_roster (academic_session, academic_term, student_id, roster_status, valid_from);

create table if not exists public.attendance_staff_roster (
  id uuid primary key default gen_random_uuid(),
  academic_session text not null,
  academic_term text not null,
  person_id uuid not null,
  staff_id uuid not null,
  staff_number_snapshot text,
  full_name_snapshot text not null,
  employment_status text not null,
  attendance_required boolean not null default true,
  roster_status text not null default 'active',
  valid_from date not null,
  valid_until date,
  source_sync_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_staff_roster_status_chk check (roster_status in ('active','inactive')),
  constraint attendance_staff_roster_dates_chk check (valid_until is null or valid_until > valid_from),
  unique (academic_session, academic_term, person_id, valid_from)
);

create index if not exists attendance_staff_roster_context_idx
  on public.attendance_staff_roster (academic_session, academic_term, person_id, roster_status, valid_from);

create table if not exists public.attendance_roster_sync_runs (
  id uuid primary key default gen_random_uuid(),
  academic_session text not null,
  academic_term text not null,
  as_of_date date not null,
  status text not null,
  source_system text not null default 'central_registry',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  initiated_by_person_id uuid,
  retry_of uuid references public.attendance_roster_sync_runs(id),
  records_added integer not null default 0,
  records_updated integer not null default 0,
  records_deactivated integer not null default 0,
  unresolved_identities integer not null default 0,
  failed_mappings integer not null default 0,
  error_code text,
  error_message text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint attendance_roster_sync_runs_status_chk check (status in ('running','succeeded','failed'))
);

alter table public.attendance_staff_roster enable row level security;
alter table public.attendance_roster_sync_runs enable row level security;
revoke all on table public.attendance_staff_roster, public.attendance_roster_sync_runs from public, anon, authenticated;

create or replace function wts_internal.attendance_period_summary(
  p_staff_id uuid,
  p_from date,
  p_to date,
  p_academic_session text,
  p_academic_term text
)
returns jsonb
language sql
security definer
set search_path to 'pg_catalog', 'extensions', 'public'
as $function$
  with records as (
    select r.attendance_date, r.status
    from public.attendance_staff_session_records r
    where r.staff_id = p_staff_id
      and r.academic_session = p_academic_session
      and r.academic_term = p_academic_term
      and r.attendance_date >= p_from
      and r.attendance_date < p_to
    union all
    select d.attendance_date, d.daily_status
    from public.staff_attendance_daily d
    where d.staff_id = p_staff_id
      and d.academic_session = p_academic_session
      and d.academic_term = p_academic_term
      and d.attendance_date >= p_from
      and d.attendance_date < p_to
      and not exists (
        select 1 from public.attendance_staff_session_records r
        where r.staff_id = d.staff_id
          and r.attendance_date = d.attendance_date
          and r.academic_session = d.academic_session
          and r.academic_term = d.academic_term
      )
  )
  select jsonb_build_object(
    'available', count(*) > 0,
    'sessions_recorded', case when count(*) > 0 then count(*) else null end,
    'present_sessions', case when count(*) > 0 then count(*) filter (where lower(trim(coalesce(status,''))) in ('present','late','checked_in','official_activity')) else null end,
    'absent_sessions', case when count(*) > 0 then count(*) filter (where lower(trim(coalesce(status,''))) = 'absent') else null end,
    'percentage', case when count(*) > 0 then round((count(*) filter (where lower(trim(coalesce(status,''))) in ('present','late','checked_in','official_activity'))::numeric / nullif(count(*),0)) * 100, 2) else null end,
    'from', p_from,
    'to', p_to - 1
  )
  from records;
$function$;

revoke all on function wts_internal.attendance_period_summary(uuid,date,date,text,text) from public, anon, authenticated;

create or replace function public.attendance_workspace_read_session_api(
  p_session_id uuid,
  p_session_secret text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'extensions', 'public'
as $function$
declare
  v_session jsonb;
  v_authority jsonb;
  v_person_id uuid;
  v_staff public.staff_attendance_profiles%rowtype;
  v_context jsonb;
  v_academic_session text;
  v_term text;
  v_today jsonb;
  v_weekly jsonb;
  v_monthly jsonb;
  v_term_summary jsonb;
  v_staff_records jsonb;
  v_class_teacher_assignments jsonb;
  v_management jsonb;
  v_roster_sync jsonb;
  v_is_management boolean := false;
  v_attendance_required boolean := true;
  v_date date := current_date;
begin
  v_session := public.school_identity_session_validate(p_session_id, p_session_secret, 'attendance');
  if coalesce((v_session ->> 'ok')::boolean, false) is not true then return v_session; end if;
  v_person_id := (v_session ->> 'person_id')::uuid;
  v_authority := coalesce(v_session -> 'institutional_authority', '{}'::jsonb);
  v_context := public.school_academic_current();
  v_academic_session := v_context ->> 'academic_session';
  v_term := v_context ->> 'term';

  select * into v_staff
  from public.staff_attendance_profiles s
  where s.central_person_id = v_person_id
    and s.registration_status = 'active'
    and s.employment_status = 'active'
  order by s.created_at
  limit 1;
  if not found then return jsonb_build_object('ok', false, 'code', 'STAFF_IDENTITY_NOT_ACTIVE'); end if;
  select coalesce(p.personal_attendance_required, v_staff.attendance_required)
    into v_attendance_required
  from public.school_people p where p.id = v_person_id;

  v_today := (
    with records as (
      select r.status, r.first_event_time as check_in_time, r.last_event_time as check_out_time
      from public.attendance_staff_session_records r
      where r.staff_id = v_staff.id and r.attendance_date = v_date and r.academic_session = v_academic_session and r.academic_term = v_term
      union all
      select d.daily_status, d.first_check_in, d.last_check_out
      from public.staff_attendance_daily d
      where d.staff_id = v_staff.id and d.attendance_date = v_date and d.academic_session = v_academic_session and d.academic_term = v_term
        and not exists (select 1 from public.attendance_staff_session_records r where r.staff_id=d.staff_id and r.attendance_date=d.attendance_date and r.academic_session=d.academic_session and r.academic_term=d.academic_term)
    )
    select jsonb_build_object(
      'available', count(*) > 0,
      'status', case when count(*) = 0 then null when count(*) filter (where lower(trim(coalesce(status,''))) in ('present','late','checked_in','official_activity')) > 0 then (array_agg(status order by check_in_time nulls last))[1] else (array_agg(status order by check_in_time nulls last))[1] end,
      'check_in_time', min(check_in_time),
      'check_out_time', max(check_out_time),
      'records', count(*)
    ) from records
  );

  v_weekly := wts_internal.attendance_period_summary(v_staff.id, date_trunc('week', v_date)::date, date_trunc('week', v_date)::date + 7, v_academic_session, v_term);
  v_monthly := wts_internal.attendance_period_summary(v_staff.id, date_trunc('month', v_date)::date, (date_trunc('month', v_date) + interval '1 month')::date, v_academic_session, v_term);
  select wts_internal.attendance_period_summary(v_staff.id, coalesce(t.starts_on, date '1900-01-01'), coalesce(t.ends_on + 1, v_date + 1), v_academic_session, v_term)
    into v_term_summary
  from public.school_academic_terms t
  where t.academic_session = v_academic_session and t.term_name = v_term
  limit 1;

  select jsonb_build_object(
    'available', count(*) > 0,
    'days_recorded', case when count(*) > 0 then count(distinct attendance_date) else null end,
    'present_days', case when count(*) > 0 then count(distinct attendance_date) filter (where lower(trim(coalesce(status,''))) in ('present','late','checked_in','official_activity')) else null end,
    'absent_days', case when count(*) > 0 then count(distinct attendance_date) filter (where lower(trim(coalesce(status,''))) = 'absent') else null end
  ) into v_staff_records
  from (
    select r.attendance_date,r.status from public.attendance_staff_session_records r where r.staff_id=v_staff.id and r.academic_session=v_academic_session and r.academic_term=v_term
    union all
    select d.attendance_date,d.daily_status from public.staff_attendance_daily d where d.staff_id=v_staff.id and d.academic_session=v_academic_session and d.academic_term=v_term and not exists(select 1 from public.attendance_staff_session_records r where r.staff_id=d.staff_id and r.attendance_date=d.attendance_date and r.academic_session=d.academic_session and r.academic_term=d.academic_term)
  ) rows;

  v_is_management := (v_authority ->> 'classification') in ('system_owner','proprietor') or coalesce(v_session -> 'permissions', '[]'::jsonb) ?| array['*','settings.manage','staff.read','reports.read','devices.read','devices.manage'];

  select coalesce(jsonb_agg(jsonb_build_object(
    'class_key', a.class_key,
    'class_name', c.display_name,
    'responsibility', a.responsibility,
    'morning_register_status', coalesce((select l.status from public.attendance_register_locks l where l.academic_session=v_academic_session and l.academic_term=v_term and l.attendance_date=v_date and l.class_key=a.class_key and l.session_slot='morning' order by l.updated_at desc limit 1),'not_started'),
    'afternoon_register_status', coalesce((select l.status from public.attendance_register_locks l where l.academic_session=v_academic_session and l.academic_term=v_term and l.attendance_date=v_date and l.class_key=a.class_key and l.session_slot='afternoon' order by l.updated_at desc limit 1),'not_started'),
    'pupils_present_today', case when exists(select 1 from public.attendance_student_session_records r where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term and r.class_key_snapshot=a.class_key) then (select count(distinct r.student_id)::integer from public.attendance_student_session_records r where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term and r.class_key_snapshot=a.class_key and lower(trim(r.status)) in ('present','late','official_activity')) else null end,
    'pupils_absent_today', case when exists(select 1 from public.attendance_student_session_records r where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term and r.class_key_snapshot=a.class_key) then (select count(distinct r.student_id)::integer from public.attendance_student_session_records r where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term and r.class_key_snapshot=a.class_key and lower(trim(r.status))='absent') else null end,
    'weekly_percentage', (select round((count(*) filter(where lower(trim(r.status)) in ('present','late','official_activity'))::numeric/nullif(count(*),0))*100,2) from public.attendance_student_session_records r where r.academic_session=v_academic_session and r.academic_term=v_term and r.class_key_snapshot=a.class_key and r.attendance_date>=date_trunc('week',v_date)::date and r.attendance_date<date_trunc('week',v_date)::date+7),
    'incomplete_register_alerts', (select count(*)::integer from public.attendance_register_locks l where l.academic_session=v_academic_session and l.academic_term=v_term and l.attendance_date=v_date and l.class_key=a.class_key and l.status not in ('confirmed','closed')),
    'repeated_absence_alert_count', (select count(*)::integer from (select r.student_id from public.attendance_student_session_records r where r.academic_session=v_academic_session and r.academic_term=v_term and r.class_key_snapshot=a.class_key and r.attendance_date>=v_date-30 and r.attendance_date<=v_date and lower(trim(r.status))='absent' group by r.student_id having count(*)>=3) repeated),
    'attendance_available', exists(select 1 from public.attendance_student_session_records r where r.academic_session=v_academic_session and r.academic_term=v_term and r.attendance_date=v_date and r.class_key_snapshot=a.class_key)
  ) order by c.sort_order,c.display_name,a.responsibility),'[]'::jsonb) into v_class_teacher_assignments
  from public.school_staff_class_allocations a
  join public.school_classes c on c.class_key=a.class_key and c.is_active
  where (a.person_id=v_person_id or a.staff_id=v_person_id)
    and a.responsibility in ('class_teacher','assistant_class_teacher')
    and a.allocation_status='active'
    and a.effective_from<=now()
    and (a.effective_until is null or a.effective_until>now())
    and (a.academic_session=v_academic_session or a.academic_session is null)
    and (a.term_name=v_term or a.term_name is null);

  if v_is_management then
    v_management := jsonb_build_object(
      'available', true,
      'staff_present_today', (select case when count(*)>0 then count(*) filter(where lower(trim(status)) in ('present','late','checked_in','official_activity')) else null end from (select r.status from public.attendance_staff_session_records r join public.staff_attendance_profiles s on s.id=r.staff_id join public.school_people p on p.id=s.central_person_id where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term and coalesce(p.personal_attendance_required,s.attendance_required) union all select d.daily_status from public.staff_attendance_daily d join public.staff_attendance_profiles s on s.id=d.staff_id join public.school_people p on p.id=s.central_person_id where d.attendance_date=v_date and d.academic_session=v_academic_session and d.academic_term=v_term and coalesce(p.personal_attendance_required,s.attendance_required) and not exists(select 1 from public.attendance_staff_session_records r where r.staff_id=d.staff_id and r.attendance_date=d.attendance_date and r.academic_session=d.academic_session and r.academic_term=d.academic_term)) staff_rows),
      'staff_absent_today', (select case when count(*)>0 then count(*) filter(where lower(trim(status))='absent') else null end from (select r.status from public.attendance_staff_session_records r join public.staff_attendance_profiles s on s.id=r.staff_id join public.school_people p on p.id=s.central_person_id where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term and coalesce(p.personal_attendance_required,s.attendance_required) union all select d.daily_status from public.staff_attendance_daily d join public.staff_attendance_profiles s on s.id=d.staff_id join public.school_people p on p.id=s.central_person_id where d.attendance_date=v_date and d.academic_session=v_academic_session and d.academic_term=v_term and coalesce(p.personal_attendance_required,s.attendance_required) and not exists(select 1 from public.attendance_staff_session_records r where r.staff_id=d.staff_id and r.attendance_date=d.attendance_date and r.academic_session=d.academic_session and r.academic_term=d.academic_term)) staff_rows),
      'staff_late_today', (select case when count(*)>0 then count(*) filter(where lower(trim(status))='late') else null end from (select r.status from public.attendance_staff_session_records r where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term union all select d.daily_status from public.staff_attendance_daily d where d.attendance_date=v_date and d.academic_session=v_academic_session and d.academic_term=v_term and not exists(select 1 from public.attendance_staff_session_records r where r.staff_id=d.staff_id and r.attendance_date=d.attendance_date and r.academic_session=d.academic_session and r.academic_term=d.academic_term)) staff_rows),
      'pupils_present_today', (select case when count(*)>0 then count(distinct student_id) filter(where lower(trim(status)) in ('present','late','official_activity')) else null end from public.attendance_student_session_records where attendance_date=v_date and academic_session=v_academic_session and academic_term=v_term),
      'pupils_absent_today', (select case when count(*)>0 then count(distinct student_id) filter(where lower(trim(status))='absent') else null end from public.attendance_student_session_records where attendance_date=v_date and academic_session=v_academic_session and academic_term=v_term),
      'classes_with_incomplete_registers', (select case when count(*)>0 then count(distinct class_key) filter(where status not in ('confirmed','closed')) else null end from public.attendance_register_locks where attendance_date=v_date and academic_session=v_academic_session and academic_term=v_term),
      'device_import_health', jsonb_build_object('available',true,'registered_devices',(select count(*) from public.attendance_devices),'healthy_devices',(select count(*) from public.attendance_devices where status='active' and health_status in ('healthy','online','ready')),'pending_imports',(select count(*) from public.attendance_import_batches where status in ('uploaded','preview','pending','processing'))),
      'message', case when exists(select 1 from public.attendance_student_session_records where attendance_date=v_date and academic_session=v_academic_session and academic_term=v_term) or exists(select 1 from public.attendance_staff_session_records where attendance_date=v_date and academic_session=v_academic_session and academic_term=v_term) or exists(select 1 from public.attendance_daily where attendance_date=v_date and academic_session=v_academic_session and academic_term=v_term) or exists(select 1 from public.staff_attendance_daily where attendance_date=v_date and academic_session=v_academic_session and academic_term=v_term) then null else 'No attendance records have been recorded for the current date.' end
    );
  else
    v_management := jsonb_build_object('available',false,'message','School-wide attendance summaries require an authorised management identity.');
  end if;

  select coalesce((select jsonb_build_object('last_successful_sync',r.completed_at,'academic_session',r.academic_session,'academic_term',r.academic_term,'records_added',r.records_added,'records_updated',r.records_updated,'records_deactivated',r.records_deactivated,'unresolved_identities',r.unresolved_identities,'failed_mappings',r.failed_mappings,'retry_available',true) from public.attendance_roster_sync_runs r where r.status='succeeded' order by r.completed_at desc limit 1),'{}'::jsonb) into v_roster_sync;

  return jsonb_build_object(
    'ok',true,
    'code','ATTENDANCE_WORKSPACE_SUMMARY_READ',
    'person',jsonb_build_object('person_id',v_person_id,'staff_id',v_staff.id,'staff_number',v_staff.staff_number,'full_name',v_staff.full_name,'employment_status',v_staff.employment_status),
    'institutional_authority',v_authority,
    'academic_context',jsonb_build_object('session',v_academic_session,'term',v_term,'source','central_registry'),
    'personal',jsonb_build_object('attendance_required',v_attendance_required,'today',case when v_attendance_required then v_today else jsonb_build_object('available',true,'status','not_required') end,'weekly',case when v_attendance_required then v_weekly else jsonb_build_object('available',true,'percentage',null,'status','not_required') end,'monthly',case when v_attendance_required then v_monthly else jsonb_build_object('available',true,'percentage',null,'status','not_required') end,'term',case when v_attendance_required then v_term_summary else jsonb_build_object('available',true,'percentage',null,'status','not_required') end,'unresolved_correction_count',(select count(*)::integer from public.attendance_register_correction_requests c join public.attendance_admin_clients ac on ac.id=c.requested_by_admin_client_id where c.status='pending' and ac.central_person_id=v_person_id)+(select count(*)::integer from public.attendance_correction_requests c join public.staff_attendance_daily d on d.id=c.staff_daily_id where c.status='pending' and d.staff_id=v_staff.id)),
    'class_teacher',jsonb_build_object('available',jsonb_array_length(v_class_teacher_assignments)>0,'assignments',v_class_teacher_assignments,'message',case when jsonb_array_length(v_class_teacher_assignments)>0 then null else 'No active class-teacher or assistant class-teacher assignment is recorded.' end),
    'management',v_management,
    'roster_sync',v_roster_sync
  );
end;
$function$;

revoke all on function public.attendance_workspace_read_session_api(uuid,text) from public, authenticated;
grant execute on function public.attendance_workspace_read_session_api(uuid,text) to anon;

create table if not exists public.attendance_roster_sync_service_guard (
  singleton boolean primary key default true,
  note text not null default 'Service-only roster sync boundary'
);
alter table public.attendance_roster_sync_service_guard enable row level security;
revoke all on table public.attendance_roster_sync_service_guard from public, anon, authenticated;

create or replace function wts_internal.attendance_apply_roster_snapshot(
  p_roster jsonb,
  p_academic_session text,
  p_academic_term text,
  p_as_of_date date,
  p_initiated_by_person_id uuid default null,
  p_retry_of uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'extensions', 'public'
as $function$
declare
  v_run_id uuid;
  v_row jsonb;
  v_student_id uuid;
  v_person_id uuid;
  v_staff_id uuid;
  v_valid_from date;
  v_entry_id uuid;
  v_staff_entry_id uuid;
  v_added integer := 0;
  v_updated integer := 0;
  v_deactivated integer := 0;
  v_staff_deactivated integer := 0;
  v_unresolved integer := 0;
  v_failed integer := 0;
begin
  insert into public.attendance_roster_sync_runs(academic_session,academic_term,as_of_date,status,initiated_by_person_id,retry_of,details)
  values(p_academic_session,p_academic_term,p_as_of_date,'running',p_initiated_by_person_id,p_retry_of,jsonb_build_object('source','central_registry')) returning id into v_run_id;

  for v_row in select value from jsonb_array_elements(coalesce(p_roster -> 'pupils','[]'::jsonb)) loop
    begin v_student_id := nullif(v_row ->> 'student_id','')::uuid; v_person_id := nullif(v_row ->> 'person_id','')::uuid; v_valid_from := coalesce(nullif(v_row ->> 'valid_from','')::date,p_as_of_date); exception when others then v_student_id := null; v_person_id := null; end;
    if v_student_id is null or not exists(select 1 from public.students s where s.id=v_student_id) then v_failed := v_failed + 1; continue; end if;
    if v_person_id is null then v_unresolved := v_unresolved + 1; continue; end if;
    select id into v_entry_id from public.attendance_student_roster r where r.academic_session=p_academic_session and coalesce(r.academic_term,'')=coalesce(p_academic_term,'') and r.student_id=v_student_id and r.valid_from is not distinct from v_valid_from for update;
    if found then
      update public.attendance_student_roster set class_key=coalesce(v_row ->> 'class_key',class_key),full_name_snapshot=coalesce(v_row ->> 'full_name',full_name_snapshot),admission_number_snapshot=coalesce(v_row ->> 'admission_number',admission_number_snapshot),gender_snapshot=coalesce(v_row ->> 'gender',gender_snapshot),pupil_status=v_row ->> 'pupil_status',roster_status='active',valid_until=null,central_person_id=v_person_id,source_valid_from=v_valid_from,source_valid_until=null,source_sync_run_id=v_run_id,updated_at=now() where id=v_entry_id;
      v_updated := v_updated + 1;
    else
      insert into public.attendance_student_roster(academic_session,academic_term,student_id,class_key,roster_status,full_name_snapshot,admission_number_snapshot,gender_snapshot,valid_from,central_person_id,pupil_status,source_valid_from,source_sync_run_id)
      values(p_academic_session,p_academic_term,v_student_id,v_row ->> 'class_key','active',coalesce(v_row ->> 'full_name','Registry pupil'),v_row ->> 'admission_number',v_row ->> 'gender',v_valid_from,v_person_id,v_row ->> 'pupil_status',v_valid_from,v_run_id);
      v_added := v_added + 1;
    end if;
  end loop;

  update public.attendance_student_roster r
  set roster_status='inactive',valid_until=coalesce(r.valid_until,p_as_of_date),updated_at=now(),source_sync_run_id=v_run_id
  where r.academic_session=p_academic_session and coalesce(r.academic_term,'')=coalesce(p_academic_term,'') and r.roster_status='active' and not exists(select 1 from jsonb_array_elements(coalesce(p_roster -> 'pupils','[]'::jsonb)) x where (x ->> 'student_id')::uuid=r.student_id and coalesce(nullif(x ->> 'valid_from','')::date,p_as_of_date)=r.valid_from);
  get diagnostics v_deactivated = row_count;

  for v_row in select value from jsonb_array_elements(coalesce(p_roster -> 'staff','[]'::jsonb)) loop
    begin v_person_id := nullif(v_row ->> 'person_id','')::uuid; v_staff_id := nullif(v_row ->> 'staff_id','')::uuid; v_valid_from := coalesce(nullif(v_row ->> 'valid_from','')::date,p_as_of_date); exception when others then v_person_id := null; v_staff_id := null; end;
    if v_person_id is null or v_staff_id is null or not exists(select 1 from public.staff_attendance_profiles s where s.id=v_staff_id and s.central_person_id=v_person_id) then v_failed := v_failed + 1; continue; end if;
    select id into v_staff_entry_id from public.attendance_staff_roster r where r.academic_session=p_academic_session and r.academic_term=p_academic_term and r.person_id=v_person_id and r.valid_from=v_valid_from for update;
    if found then
      update public.attendance_staff_roster set staff_id=v_staff_id,staff_number_snapshot=v_row ->> 'staff_number',full_name_snapshot=coalesce(v_row ->> 'full_name',full_name_snapshot),employment_status=coalesce(v_row ->> 'employment_status',employment_status),attendance_required=coalesce((v_row ->> 'attendance_required')::boolean,attendance_required),roster_status='active',valid_until=null,source_sync_run_id=v_run_id,updated_at=now() where id=v_staff_entry_id;
    else
      insert into public.attendance_staff_roster(academic_session,academic_term,person_id,staff_id,staff_number_snapshot,full_name_snapshot,employment_status,attendance_required,valid_from,source_sync_run_id)
      values(p_academic_session,p_academic_term,v_person_id,v_staff_id,v_row ->> 'staff_number',coalesce(v_row ->> 'full_name','Registry staff'),coalesce(v_row ->> 'employment_status','active'),coalesce((v_row ->> 'attendance_required')::boolean,true),v_valid_from,v_run_id);
      v_added := v_added + 1;
    end if;
  end loop;

  update public.attendance_staff_roster r set roster_status='inactive',valid_until=coalesce(r.valid_until,p_as_of_date),updated_at=now(),source_sync_run_id=v_run_id where r.academic_session=p_academic_session and r.academic_term=p_academic_term and r.roster_status='active' and not exists(select 1 from jsonb_array_elements(coalesce(p_roster -> 'staff','[]'::jsonb)) x where (x ->> 'person_id')::uuid=r.person_id and coalesce(nullif(x ->> 'valid_from','')::date,p_as_of_date)=r.valid_from);
  get diagnostics v_staff_deactivated = row_count;
  v_deactivated := v_deactivated + v_staff_deactivated;

  update public.attendance_roster_sync_runs set status='succeeded',completed_at=now(),records_added=v_added,records_updated=v_updated,records_deactivated=v_deactivated,unresolved_identities=v_unresolved,failed_mappings=v_failed,details=jsonb_build_object('source','central_registry','pupil_count',jsonb_array_length(coalesce(p_roster -> 'pupils','[]'::jsonb)),'staff_count',jsonb_array_length(coalesce(p_roster -> 'staff','[]'::jsonb)),'class_count',jsonb_array_length(coalesce(p_roster -> 'classes','[]'::jsonb))) where id=v_run_id;
  return jsonb_build_object('ok',true,'code','ATTENDANCE_ROSTER_SYNC_SUCCEEDED','run_id',v_run_id,'academic_session',p_academic_session,'academic_term',p_academic_term,'records_added',v_added,'records_updated',v_updated,'records_deactivated',v_deactivated,'unresolved_identities',v_unresolved,'failed_mappings',v_failed,'last_successful_sync',now());
exception when others then
  if v_run_id is not null then update public.attendance_roster_sync_runs set status='failed',completed_at=now(),error_code='ROSTER_SYNC_FAILED',error_message=left(sqlerrm,240) where id=v_run_id; end if;
  return jsonb_build_object('ok',false,'code','ROSTER_SYNC_FAILED','run_id',v_run_id);
end;
$function$;

revoke all on function wts_internal.attendance_apply_roster_snapshot(jsonb,text,text,date,uuid,uuid) from public, anon, authenticated;

create or replace function public.attendance_roster_sync_api(
  p_session_id uuid,
  p_session_secret text,
  p_academic_session text default null,
  p_term text default null,
  p_as_of_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'extensions', 'public'
as $function$
declare
  v_session jsonb;
  v_roster jsonb;
  v_context jsonb;
  v_session_name text;
  v_term_name text;
  v_date date := coalesce(p_as_of_date,current_date);
begin
  v_session := public.school_identity_session_validate(p_session_id,p_session_secret,'attendance');
  if coalesce((v_session ->> 'ok')::boolean,false) is not true then return v_session; end if;
  v_context := public.school_academic_current();
  v_session_name := coalesce(nullif(trim(p_academic_session),''),v_context ->> 'academic_session');
  v_term_name := coalesce(nullif(trim(p_term),''),v_context ->> 'term');
  v_roster := public.school_attendance_registry_roster_read_api(p_session_id,p_session_secret,v_session_name,v_term_name,v_date);
  if coalesce((v_roster ->> 'ok')::boolean,false) is not true then return v_roster; end if;
  return wts_internal.attendance_apply_roster_snapshot(v_roster,v_session_name,v_term_name,v_date,(v_session ->> 'person_id')::uuid,null);
end;
$function$;

revoke all on function public.attendance_roster_sync_api(uuid,text,text,text,date) from public, authenticated;
grant execute on function public.attendance_roster_sync_api(uuid,text,text,text,date) to anon;

create or replace function public.attendance_roster_sync_service_api(
  p_roster jsonb,
  p_academic_session text,
  p_term text,
  p_as_of_date date default current_date
)
returns jsonb
language sql
security definer
set search_path to 'pg_catalog', 'extensions', 'public'
as $function$
  select wts_internal.attendance_apply_roster_snapshot(p_roster,p_academic_session,p_term,coalesce(p_as_of_date,current_date),null,null);
$function$;

revoke all on function public.attendance_roster_sync_service_api(jsonb,text,text,date) from public, anon, authenticated;
grant execute on function public.attendance_roster_sync_service_api(jsonb,text,text,date) to service_role;

create or replace function public.attendance_roster_sync_status_api(
  p_session_id uuid,
  p_session_secret text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'extensions', 'public'
as $function$
declare v_session jsonb; v_current jsonb;
begin
  v_session := public.school_identity_session_validate(p_session_id,p_session_secret,'attendance');
  if coalesce((v_session ->> 'ok')::boolean,false) is not true then return v_session; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc),'[]'::jsonb) into v_current from public.attendance_roster_sync_runs r where r.created_at >= now()-interval '90 days';
  return jsonb_build_object('ok',true,'code','ATTENDANCE_ROSTER_SYNC_STATUS','runs',v_current,'latest_success',coalesce((select to_jsonb(r) from public.attendance_roster_sync_runs r where r.status='succeeded' order by r.completed_at desc limit 1),'null'::jsonb),'retry_available',true);
end;
$function$;

revoke all on function public.attendance_roster_sync_status_api(uuid,text) from public, authenticated;
grant execute on function public.attendance_roster_sync_status_api(uuid,text) to anon;

create or replace function public.attendance_roster_sync_retry_api(
  p_session_id uuid,
  p_session_secret text,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'extensions', 'public'
as $function$
declare v_session jsonb; v_run public.attendance_roster_sync_runs%rowtype; v_roster jsonb;
begin
  v_session := public.school_identity_session_validate(p_session_id,p_session_secret,'attendance');
  if coalesce((v_session ->> 'ok')::boolean,false) is not true then return v_session; end if;
  select * into v_run from public.attendance_roster_sync_runs where id=p_run_id;
  if not found then return jsonb_build_object('ok',false,'code','ROSTER_SYNC_RUN_NOT_FOUND'); end if;
  v_roster := public.school_attendance_registry_roster_read_api(p_session_id,p_session_secret,v_run.academic_session,v_run.academic_term,v_run.as_of_date);
  if coalesce((v_roster ->> 'ok')::boolean,false) is not true then return v_roster; end if;
  return wts_internal.attendance_apply_roster_snapshot(v_roster,v_run.academic_session,v_run.academic_term,v_run.as_of_date,(v_session ->> 'person_id')::uuid,v_run.id);
end;
$function$;

revoke all on function public.attendance_roster_sync_retry_api(uuid,text,uuid) from public, authenticated;
grant execute on function public.attendance_roster_sync_retry_api(uuid,text,uuid) to anon;
