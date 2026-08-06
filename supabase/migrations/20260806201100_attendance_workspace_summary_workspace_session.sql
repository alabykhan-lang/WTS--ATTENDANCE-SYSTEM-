-- Allow the read-only WTS Workspace to consume the protected Attendance
-- summary contract with its own validated Workspace session.  Attendance
-- visits continue to use attendance_workspace_read_session_api.

create or replace function public.attendance_workspace_read_workspace_api(
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
  v_date date := current_date;
  v_attendance_required boolean := true;
  v_today jsonb;
  v_weekly jsonb;
  v_monthly jsonb;
  v_term_summary jsonb;
  v_records jsonb;
  v_class_teacher jsonb;
  v_management jsonb;
  v_roster_sync jsonb;
  v_has_attendance_access boolean := false;
  v_is_management boolean := false;
begin
  v_session := public.school_identity_session_validate(p_session_id, p_session_secret, 'staff_self_service');
  if coalesce((v_session ->> 'ok')::boolean, false) is not true then
    return v_session;
  end if;

  v_person_id := (v_session ->> 'person_id')::uuid;
  v_authority := coalesce(v_session -> 'institutional_authority', '{}'::jsonb);
  v_has_attendance_access := coalesce((v_authority ->> 'active')::boolean, false)
    or exists (
      select 1
      from public.school_access_grants g
      where g.person_id = v_person_id
        and g.app_code = 'attendance'
        and g.grant_status = 'active'
        and g.valid_from <= now()
        and (g.valid_until is null or g.valid_until > now())
    );
  if not v_has_attendance_access then
    return jsonb_build_object('ok', false, 'code', 'ATTENDANCE_ACCESS_NOT_GRANTED');
  end if;

  select * into v_staff
  from public.staff_attendance_profiles s
  where s.central_person_id = v_person_id
    and s.registration_status = 'active'
    and s.employment_status = 'active'
  order by s.created_at
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'STAFF_IDENTITY_NOT_ACTIVE');
  end if;

  select p.personal_attendance_required
    into v_attendance_required
  from public.school_people p
  where p.id = v_person_id;
  v_attendance_required := coalesce(v_attendance_required, v_staff.attendance_required, true);

  v_context := public.school_academic_current();
  v_academic_session := v_context ->> 'academic_session';
  v_term := v_context ->> 'term';

  v_today := (
    with records as (
      select r.status, r.first_event_time as check_in_time, r.last_event_time as check_out_time
      from public.attendance_staff_session_records r
      where r.staff_id = v_staff.id
        and r.attendance_date = v_date
        and r.academic_session = v_academic_session
        and r.academic_term = v_term
      union all
      select d.daily_status, d.first_check_in, d.last_check_out
      from public.staff_attendance_daily d
      where d.staff_id = v_staff.id
        and d.attendance_date = v_date
        and d.academic_session = v_academic_session
        and d.academic_term = v_term
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
      'status', case when count(*) > 0 then (array_agg(status order by check_in_time nulls last))[1] else null end,
      'check_in_time', min(check_in_time),
      'check_out_time', max(check_out_time),
      'records', count(*)
    )
    from records
  );

  v_weekly := wts_internal.attendance_period_summary(
    v_staff.id,
    date_trunc('week', v_date)::date,
    date_trunc('week', v_date)::date + 7,
    v_academic_session,
    v_term
  );
  v_monthly := wts_internal.attendance_period_summary(
    v_staff.id,
    date_trunc('month', v_date)::date,
    (date_trunc('month', v_date) + interval '1 month')::date,
    v_academic_session,
    v_term
  );
  select wts_internal.attendance_period_summary(
    v_staff.id,
    coalesce(t.starts_on, date '1900-01-01'),
    coalesce(t.ends_on + 1, v_date + 1),
    v_academic_session,
    v_term
  )
  into v_term_summary
  from public.school_academic_terms t
  where t.academic_session = v_academic_session
    and t.term_name = v_term
  limit 1;

  select jsonb_build_object(
    'available', count(*) > 0,
    'days_recorded', case when count(*) > 0 then count(distinct attendance_date) else null end,
    'present_days', case when count(*) > 0 then count(distinct attendance_date) filter (where lower(trim(coalesce(status, ''))) in ('present','late','checked_in','official_activity')) else null end,
    'absent_days', case when count(*) > 0 then count(distinct attendance_date) filter (where lower(trim(coalesce(status, ''))) = 'absent') else null end
  )
  into v_records
  from (
    select r.attendance_date, r.status
    from public.attendance_staff_session_records r
    where r.staff_id = v_staff.id
      and r.academic_session = v_academic_session
      and r.academic_term = v_term
    union all
    select d.attendance_date, d.daily_status
    from public.staff_attendance_daily d
    where d.staff_id = v_staff.id
      and d.academic_session = v_academic_session
      and d.academic_term = v_term
      and not exists (
        select 1 from public.attendance_staff_session_records r
        where r.staff_id = d.staff_id
          and r.attendance_date = d.attendance_date
          and r.academic_session = d.academic_session
          and r.academic_term = d.academic_term
      )
  ) rows;

  v_is_management := coalesce((v_authority ->> 'classification') in ('system_owner','proprietor'), false)
    or coalesce(v_session -> 'permissions', '[]'::jsonb) ?| array['*','settings.manage','staff.read','reports.read','devices.read','devices.manage'];

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
    'attendance_available', exists(select 1 from public.attendance_student_session_records r where r.attendance_date=v_date and r.academic_session=v_academic_session and r.academic_term=v_term and r.class_key_snapshot=a.class_key)
  ) order by c.sort_order,c.display_name,a.responsibility),'[]'::jsonb)
  into v_class_teacher
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

  select coalesce((select jsonb_build_object('last_successful_sync',r.completed_at,'academic_session',r.academic_session,'academic_term',r.academic_term,'records_added',r.records_added,'records_updated',r.records_updated,'records_deactivated',r.records_deactivated,'unresolved_identities',r.unresolved_identities,'failed_mappings',r.failed_mappings,'retry_available',true) from public.attendance_roster_sync_runs r where r.status='succeeded' order by r.completed_at desc limit 1),'{}'::jsonb)
    into v_roster_sync;

  return jsonb_build_object(
    'ok', true,
    'code', 'ATTENDANCE_WORKSPACE_SUMMARY_READ',
    'person', jsonb_build_object('person_id',v_person_id,'staff_id',v_staff.id,'staff_number',v_staff.staff_number,'full_name',v_staff.full_name,'employment_status',v_staff.employment_status),
    'institutional_authority', v_authority,
    'academic_context', jsonb_build_object('session',v_academic_session,'term',v_term,'source','central_registry'),
    'personal', jsonb_build_object('attendance_required',v_attendance_required,'today',v_today,'weekly',v_weekly,'monthly',v_monthly,'term',v_term_summary,'records',v_records,'unresolved_correction_count',(select count(*)::integer from public.attendance_correction_requests c where c.requested_by_person_id=v_person_id and c.status in ('pending','submitted','under_review'))),
    'class_teacher', jsonb_build_object('available',jsonb_array_length(v_class_teacher)>0,'assignments',v_class_teacher,'message',case when jsonb_array_length(v_class_teacher)>0 then null else 'No class-teacher assignment is currently active.' end),
    'management', v_management,
    'roster_sync', v_roster_sync
  );
end;
$function$;

revoke all on function public.attendance_workspace_read_workspace_api(uuid,text) from public, authenticated;
grant execute on function public.attendance_workspace_read_workspace_api(uuid,text) to anon;
