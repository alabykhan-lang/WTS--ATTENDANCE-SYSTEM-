-- Correct report denominators and expose grouped period summaries.
-- Calendar policy is authoritative: holidays/closures and days that do not
-- require student attendance are excluded; missing register rows remain
-- incomplete possible sessions rather than being counted present.

create or replace function public.attendance_universal_report_api(
  p_client_code text,
  p_client_secret text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_client public.attendance_admin_clients%rowtype;
  v_permissions text[];
  v_config public.attendance_system_config%rowtype;
  v_session text;
  v_term text;
  v_from date;
  v_to date;
  v_class text;
  v_is_global boolean;
  v_result jsonb;
begin
  select * into v_client
  from public.attendance_admin_clients
  where client_code=trim(p_client_code) and status='active';
  if not found or encode(digest(p_client_secret,'sha256'),'hex')<>v_client.secret_hash then
    return jsonb_build_object('ok',false,'code','ADMIN_AUTH_FAILED');
  end if;
  if v_client.session_expires_at is not null and v_client.session_expires_at<=now() then
    return jsonb_build_object('ok',false,'code','ADMIN_SESSION_EXPIRED');
  end if;

  v_permissions:=public.attendance_admin_effective_permissions(v_client.id);
  v_is_global:='*'=any(v_permissions) or 'settings.manage'=any(v_permissions);
  if not (v_is_global or 'reports.read'=any(v_permissions)) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  end if;

  select * into v_config from public.attendance_system_config where singleton=true;
  v_session:=coalesce(nullif(p_payload->>'session',''),v_config.operational_session,public.attendance_operational_session());
  v_term:=coalesce(nullif(p_payload->>'term',''),v_config.operational_term,public.attendance_operational_term());
  v_class:=nullif(trim(p_payload->>'classKey'),'');
  if not v_is_global then
    if v_class is null or not exists(
      select 1
      from public.school_staff_class_allocations a
      where a.class_key=v_class
        and a.allocation_status='active'
        and (a.person_id=v_client.central_person_id or a.staff_id=v_client.central_person_id)
        and (a.academic_session=v_session or a.academic_session is null)
        and (a.term_name=v_term or a.term_name is null)
    ) then
      return jsonb_build_object('ok',false,'code','CLASS_SCOPE_DENIED');
    end if;
  end if;

  begin
    v_from:=coalesce(nullif(p_payload->>'from','')::date,current_date);
    v_to:=coalesce(nullif(p_payload->>'to','')::date,v_from);
  exception when others then
    return jsonb_build_object('ok',false,'code','INVALID_DATE_RANGE');
  end;
  if v_to < v_from or v_to-v_from > 366 then
    return jsonb_build_object('ok',false,'code','INVALID_DATE_RANGE');
  end if;

  update public.attendance_admin_clients set last_seen_at=now(),updated_at=now() where id=v_client.id;

  with calendar_days as (
    select d::date as day,c.day_type,c.attendance_required_for,c.id as calendar_id
    from generate_series(v_from,v_to,interval '1 day') d
    left join public.attendance_calendar_days c
      on c.academic_session=v_session
     and c.academic_term=v_term
     and c.calendar_date=d::date
    where (
      extract(isodow from d) between 1 and 5
      or (c.day_type='school_day' and 'student'=any(c.attendance_required_for))
    )
      and (
        c.id is null
        or (c.day_type not in ('holiday','closure') and 'student'=any(c.attendance_required_for))
      )
  ), days as (
    select day from calendar_days
  ), eligible as (
    select s.id,s.name,s.admno,s.class_key,days.day,slot.slot
    from public.students s
    cross join days
    cross join (values('morning'),('afternoon')) slot(slot)
    where s.archived=false
      and s.lifecycle_status='active'
      and (v_class is null or s.class_key=v_class)
      and (s.admission_date is null or s.admission_date<=days.day)
  ), rows as (
    select e.id,e.name,e.admno,e.class_key,e.day,e.slot,
      coalesce(r.status,'incomplete') as status,
      (coalesce(r.status,'incomplete') not in ('not_expected','school_closed')) as possible
    from eligible e
    left join public.attendance_student_session_records r
      on r.student_id=e.id
     and r.attendance_date=e.day
     and r.session_slot=e.slot
     and r.academic_session=v_session
     and r.academic_term=v_term
  ), aggregates as (
    select
      count(*) filter(where possible)::integer as possible_sessions,
      count(*) filter(where status in ('present','late','official_activity'))::integer as actual_sessions,
      count(*) filter(where status='late')::integer as late_sessions,
      count(*) filter(where status='absent')::integer as absent_sessions,
      count(*) filter(where status='excused')::integer as excused_sessions,
      count(*) filter(where status in ('not_expected','school_closed'))::integer as excluded_sessions,
      count(*) filter(where possible and status='incomplete')::integer as incomplete_sessions
    from rows
  )
  select jsonb_build_object(
    'ok',true,
    'from',v_from,
    'to',v_to,
    'session',v_session,
    'term',v_term,
    'class_key',v_class,
    'student_rows',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.class_key,x.name)
      from (
        select id as student_id,name,admno,class_key,
          count(*) filter(where possible)::integer as possible_sessions,
          count(*) filter(where status in ('present','late','official_activity'))::integer as actual_sessions,
          count(*) filter(where status='late')::integer as late_sessions,
          count(*) filter(where status='absent')::integer as absent_sessions,
          count(*) filter(where status='excused')::integer as excused_sessions,
          count(*) filter(where status in ('not_expected','school_closed'))::integer as excluded_sessions,
          count(*) filter(where possible and status='incomplete')::integer as incomplete_sessions,
          round((count(*) filter(where status in ('present','late','official_activity'))::numeric/nullif(count(*) filter(where possible),0))*100,2) as attendance_percentage
        from rows
        group by id,name,admno,class_key
      ) x
    ),'[]'::jsonb),
    'class_rows',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.class_key)
      from (
        select class_key,
          count(*) filter(where possible)::integer as possible_sessions,
          count(*) filter(where status in ('present','late','official_activity'))::integer as actual_sessions,
          count(*) filter(where status='late')::integer as late_sessions,
          count(*) filter(where status='absent')::integer as absent_sessions,
          count(*) filter(where status='excused')::integer as excused_sessions,
          count(*) filter(where status in ('not_expected','school_closed'))::integer as excluded_sessions,
          count(*) filter(where possible and status='incomplete')::integer as incomplete_sessions,
          round((count(*) filter(where status in ('present','late','official_activity'))::numeric/nullif(count(*) filter(where possible),0))*100,2) as attendance_percentage
        from rows
        group by class_key
      ) x
    ),'[]'::jsonb),
    'weekly_rows',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.week_start)
      from (
        select date_trunc('week',day)::date as week_start,
          count(distinct day) filter(where possible)::integer as school_days,
          count(*) filter(where possible)::integer as possible_sessions,
          count(*) filter(where status in ('present','late','official_activity'))::integer as actual_sessions,
          count(*) filter(where status='late')::integer as late_sessions,
          count(*) filter(where status='absent')::integer as absent_sessions,
          count(*) filter(where possible and status='incomplete')::integer as incomplete_sessions,
          round((count(*) filter(where status in ('present','late','official_activity'))::numeric/nullif(count(*) filter(where possible),0))*100,2) as attendance_percentage
        from rows
        group by date_trunc('week',day)::date
      ) x
    ),'[]'::jsonb),
    'monthly_rows',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.month_start)
      from (
        select date_trunc('month',day)::date as month_start,
          count(distinct day) filter(where possible)::integer as school_days,
          count(*) filter(where possible)::integer as possible_sessions,
          count(*) filter(where status in ('present','late','official_activity'))::integer as actual_sessions,
          count(*) filter(where status='late')::integer as late_sessions,
          count(*) filter(where status='absent')::integer as absent_sessions,
          count(*) filter(where possible and status='incomplete')::integer as incomplete_sessions,
          round((count(*) filter(where status in ('present','late','official_activity'))::numeric/nullif(count(*) filter(where possible),0))*100,2) as attendance_percentage
        from rows
        group by date_trunc('month',day)::date
      ) x
    ),'[]'::jsonb),
    'session_summary',coalesce((select to_jsonb(a) from aggregates a),'{}'::jsonb)
  ) into v_result;
  return v_result;
exception
  when invalid_text_representation or datetime_field_overflow then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT_FORMAT');
end;
$$;

revoke all on function public.attendance_universal_report_api(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.attendance_universal_report_api(text,text,jsonb) to anon,authenticated;

-- Keep the existing read surface stable while routing reports through the
-- corrected contract. Other actions retain the guarded implementation.
create or replace function public.attendance_universal_admin_read_api(
  p_client_code text,
  p_client_secret text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_client public.attendance_admin_clients%rowtype;
  v_permissions text[];
  v_is_global boolean;
begin
  if p_action='report' then
    return public.attendance_universal_report_api(p_client_code,p_client_secret,p_payload);
  end if;

  select * into v_client
  from public.attendance_admin_clients
  where client_code=trim(p_client_code) and status='active';
  if not found or encode(digest(p_client_secret,'sha256'),'hex')<>v_client.secret_hash then
    return jsonb_build_object('ok',false,'code','ADMIN_AUTH_FAILED');
  end if;
  if v_client.session_expires_at is not null and v_client.session_expires_at<=now() then
    return jsonb_build_object('ok',false,'code','ADMIN_SESSION_EXPIRED');
  end if;
  v_permissions:=public.attendance_admin_effective_permissions(v_client.id);
  v_is_global:='*'=any(v_permissions) or 'settings.manage'=any(v_permissions);

  if p_action='corrections' and not (v_is_global or 'corrections.review'=any(v_permissions)) then
    if not ('corrections.create'=any(v_permissions)) then
      return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
    end if;
    return jsonb_build_object(
      'ok',true,
      'register_corrections',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from public.attendance_register_correction_requests c where c.status='pending' and c.requested_by_admin_client_id=v_client.id),'[]'::jsonb),
      'daily_corrections',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from public.attendance_correction_requests c where c.status='pending' and c.requested_by_admin_client_id=v_client.id),'[]'::jsonb)
    );
  end if;
  return public.attendance_universal_admin_read_api_scoped_v1(p_client_code,p_client_secret,p_action,p_payload);
end;
$$;

revoke all on function public.attendance_universal_admin_read_api(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.attendance_universal_admin_read_api(text,text,text,jsonb) to anon,authenticated;
