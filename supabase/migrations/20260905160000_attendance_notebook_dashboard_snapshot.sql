-- Notebook dashboard contract.
--
-- The existing Attendance snapshots are intentionally whole-day summaries. The
-- notebook workflow needs a real morning/afternoon switch, so this read-only
-- contract aggregates the authoritative session records for one slot. It does
-- not create, update, or delete attendance data.

create or replace function public.attendance_notebook_read_api(
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
  v_config public.attendance_system_config%rowtype;
  v_session text;
  v_term text;
  v_date date;
  v_slot text;
  v_class_keys text[] := array[]::text[];
  v_is_global boolean := false;
  v_student_expected integer := 0;
  v_student_present integer := 0;
  v_student_late integer := 0;
  v_student_absent integer := 0;
  v_student_excused integer := 0;
  v_student_incomplete integer := 0;
  v_unconfirmed_classes integer := 0;
  v_staff_expected integer := 0;
  v_staff_present integer := 0;
  v_staff_late integer := 0;
  v_staff_absent integer := 0;
  v_staff_excused integer := 0;
  v_staff_incomplete integer := 0;
  v_staff_checked_out integer := 0;
  v_class_summary jsonb := '[]'::jsonb;
  v_student_latest jsonb := '[]'::jsonb;
  v_staff_latest jsonb := '[]'::jsonb;
begin
  if p_action <> 'dashboard' then
    return jsonb_build_object('ok', false, 'code', 'NOTEBOOK_ACTION_NOT_ALLOWED');
  end if;

  select *
    into v_client
  from public.attendance_admin_clients
  where client_code = trim(coalesce(p_client_code, ''))
    and status = 'active';

  if not found
     or p_client_secret is null
     or encode(digest(p_client_secret, 'sha256'), 'hex') <> coalesce(v_client.secret_hash, '') then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_FAILED');
  end if;

  if v_client.session_expires_at is not null
     and v_client.session_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_SESSION_EXPIRED');
  end if;

  v_permissions := public.attendance_admin_effective_permissions(v_client.id);
  if not (
    '*' = any(coalesce(v_permissions, array[]::text[]))
    or 'dashboard.read' = any(coalesce(v_permissions, array[]::text[]))
    or 'reports.read' = any(coalesce(v_permissions, array[]::text[]))
    or 'settings.manage' = any(coalesce(v_permissions, array[]::text[]))
  ) then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_PERMISSION_DENIED');
  end if;

  select * into v_config
  from public.attendance_system_config
  where singleton = true;

  v_session := coalesce(
    nullif(p_payload ->> 'session', ''),
    v_config.operational_session,
    public.attendance_operational_session()
  );
  v_term := coalesce(
    nullif(p_payload ->> 'term', ''),
    v_config.operational_term,
    public.attendance_operational_term()
  );
  begin
    v_date := coalesce(
      nullif(p_payload ->> 'date', '')::date,
      (now() at time zone 'Africa/Lagos')::date
    );
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATE');
  end;
  v_slot := lower(trim(coalesce(p_payload ->> 'sessionSlot', 'morning')));
  if v_slot not in ('morning', 'afternoon') then
    return jsonb_build_object('ok', false, 'code', 'REGISTER_SCOPE_REQUIRED');
  end if;

  v_permissions := coalesce(v_permissions, array[]::text[]);
  v_is_global := '*' = any(v_permissions)
    or 'settings.manage' = any(v_permissions)
    or 'reports.read' = any(v_permissions);

  select coalesce(array_agg(distinct a.class_key), array[]::text[])
    into v_class_keys
  from public.school_staff_class_allocations a
  where a.allocation_status = 'active'
    and (a.person_id = v_client.central_person_id or a.staff_id = v_client.central_person_id)
    and (a.academic_session = v_session or a.academic_session is null)
    and (a.term_name = v_term or a.term_name is null);

  update public.attendance_admin_clients
  set last_seen_at = now(), updated_at = now()
  where id = v_client.id;

  select
    count(*),
    count(*) filter (where r.status in ('present', 'late', 'official_activity', 'half_day', 'school_activity', 'manual')),
    count(*) filter (where r.status = 'late'),
    count(*) filter (where r.status = 'absent'),
    count(*) filter (where r.status in ('excused', 'sick_leave')),
    count(*) filter (where r.id is null or r.status = 'incomplete')
  into v_student_expected, v_student_present, v_student_late, v_student_absent,
       v_student_excused, v_student_incomplete
  from public.students s
  left join public.attendance_student_session_records r
    on r.student_id = s.id
   and r.attendance_date = v_date
   and r.session_slot = v_slot
   and r.academic_session = v_session
   and r.academic_term = v_term
  where s.archived = false
    and s.lifecycle_status = 'active'
    and (v_is_global or s.class_key = any(v_class_keys));

  select coalesce(jsonb_agg(jsonb_build_object(
    'class_key', x.class_key,
    'expected', x.expected,
    'present', x.present,
    'late', x.late,
    'absent', x.absent,
    'excused', x.excused,
    'waiting', x.waiting,
    'register_status', x.register_status
  ) order by x.class_key), '[]'::jsonb)
    into v_class_summary
  from (
    select
      s.class_key,
      count(*)::integer as expected,
      count(*) filter (where r.status in ('present', 'late', 'official_activity', 'half_day', 'school_activity', 'manual'))::integer as present,
      count(*) filter (where r.status = 'late')::integer as late,
      count(*) filter (where r.status = 'absent')::integer as absent,
      count(*) filter (where r.status in ('excused', 'sick_leave'))::integer as excused,
      count(*) filter (where r.id is null or r.status = 'incomplete')::integer as waiting,
      coalesce(max(l.status) filter (where l.status is not null), 'not_started') as register_status
    from public.students s
    left join public.attendance_student_session_records r
      on r.student_id = s.id
     and r.attendance_date = v_date
     and r.session_slot = v_slot
     and r.academic_session = v_session
     and r.academic_term = v_term
    left join public.attendance_register_locks l
      on l.academic_session = v_session
     and l.academic_term = v_term
     and l.attendance_date = v_date
     and l.class_key = s.class_key
     and l.session_slot = v_slot
    where s.archived = false
      and s.lifecycle_status = 'active'
      and (v_is_global or s.class_key = any(v_class_keys))
    group by s.class_key
  ) x;

  select count(*) into v_unconfirmed_classes
  from jsonb_to_recordset(v_class_summary) as item(
    class_key text,
    expected integer,
    present integer,
    late integer,
    absent integer,
    excused integer,
    waiting integer,
    register_status text
  )
  where item.waiting > 0
     or item.register_status not in ('confirmed', 'closed');

  if v_is_global or 'staff.read' = any(v_permissions) then
    select
      count(*),
      count(*) filter (where r.status in ('present', 'late', 'official_activity', 'half_day', 'school_activity', 'manual')),
      count(*) filter (where r.status = 'late'),
      count(*) filter (where r.status = 'absent'),
      count(*) filter (where r.status in ('excused', 'sick_leave', 'leave')),
      count(*) filter (where r.id is null or r.status = 'incomplete')
    into v_staff_expected, v_staff_present, v_staff_late, v_staff_absent,
         v_staff_excused, v_staff_incomplete
    from public.staff_attendance_profiles s
    left join public.attendance_staff_session_records r
      on r.staff_id = s.id
     and r.attendance_date = v_date
     and r.session_slot = v_slot
     and r.academic_session = v_session
     and r.academic_term = v_term
    where s.employment_status = 'active'
      and s.registration_status = 'active'
      and s.attendance_required = true;

    select count(*) into v_staff_checked_out
    from public.staff_attendance_daily d
    join public.staff_attendance_profiles s on s.id = d.staff_id
    where d.attendance_date = v_date
      and d.academic_session = v_session
      and d.last_check_out is not null
      and s.employment_status = 'active'
      and s.registration_status = 'active'
      and s.attendance_required = true;
  end if;

  select coalesce(jsonb_agg(item order by event_time desc), '[]'::jsonb)
    into v_student_latest
  from (
    select item, event_time
    from (
      select jsonb_build_object(
        'student_id', s.id,
        'name', s.name,
        'class_key', s.class_key,
        'admno', s.admno,
        'photo', s.photo,
        'event_time', e.event_time,
        'event_type', e.event_type,
        'attendance_status', e.attendance_status,
        'source', e.source,
        'person_type', 'student'
      ) as item, e.event_time
      from public.attendance_events e
      join public.students s on s.id = e.student_id
      where e.academic_session = v_session
        and (e.event_time at time zone 'Africa/Lagos')::date = v_date
        and (case when extract(hour from (e.event_time at time zone 'Africa/Lagos')) < 12 then 'morning' else 'afternoon' end) = v_slot
        and (v_is_global or s.class_key = any(v_class_keys))
      order by e.event_time desc
      limit 20
    ) students_latest
  ) latest;

  if v_is_global or 'staff.read' = any(v_permissions) then
    select coalesce(jsonb_agg(item order by event_time desc), '[]'::jsonb)
      into v_staff_latest
    from (
      select item, event_time
      from (
        select jsonb_build_object(
          'staff_id', s.id,
          'name', s.full_name,
          'staff_number', s.staff_number,
          'designation', s.designation,
          'department', s.department,
          'photo', s.photo,
          'event_time', e.event_time,
          'event_type', e.event_type,
          'attendance_status', e.attendance_status,
          'source', e.source,
          'person_type', 'staff'
        ) as item, e.event_time
        from public.staff_attendance_events e
        join public.staff_attendance_profiles s on s.id = e.staff_id
        where e.academic_session = v_session
          and (e.event_time at time zone 'Africa/Lagos')::date = v_date
          and (case when extract(hour from (e.event_time at time zone 'Africa/Lagos')) < 12 then 'morning' else 'afternoon' end) = v_slot
          and s.employment_status = 'active'
          and s.registration_status = 'active'
        order by e.event_time desc
        limit 20
      ) staff_latest
    ) latest;
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'NOTEBOOK_DASHBOARD_READY',
    'attendance_date', v_date,
    'session_slot', v_slot,
    'academic_session', v_session,
    'academic_term', v_term,
    'student', jsonb_build_object(
      'expected', v_student_expected,
      'present', v_student_present,
      'late', v_student_late,
      'absent', v_student_absent,
      'excused', v_student_excused,
      'waiting', v_student_incomplete,
      'unconfirmed_classes', v_unconfirmed_classes,
      'class_summary', v_class_summary,
      'latest_events', v_student_latest
    ),
    'staff', jsonb_build_object(
      'expected', v_staff_expected,
      'present', v_staff_present,
      'late', v_staff_late,
      'absent', v_staff_absent,
      'excused', v_staff_excused,
      'waiting', v_staff_incomplete,
      'checked_out', v_staff_checked_out,
      'latest_events', v_staff_latest
    )
  );
exception
  when invalid_text_representation or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT_FORMAT');
  when others then
    return jsonb_build_object('ok', false, 'code', 'NOTEBOOK_DASHBOARD_FAILED');
end;
$$;

revoke all on function public.attendance_notebook_read_api(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.attendance_notebook_read_api(text, text, text, jsonb) to anon, authenticated;
