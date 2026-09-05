-- Controlled staff fallback for the notebook Take Attendance workflow.
-- It writes the existing staff event, daily and session records only after
-- Attendance permission and active Central Registry staff checks.

create or replace function public.attendance_notebook_write_api(
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
  v_staff public.staff_attendance_profiles%rowtype;
  v_daily public.staff_attendance_daily%rowtype;
  v_session_record public.attendance_staff_session_records%rowtype;
  v_rule public.staff_attendance_rules%rowtype;
  v_staff_id uuid;
  v_date date;
  v_slot text;
  v_event_type text;
  v_requested_status text;
  v_session_status text;
  v_daily_status text;
  v_note text;
  v_clock time;
  v_event_time timestamptz;
  v_session text;
  v_term text;
  v_event_status text;
  v_direction text;
  v_late_minutes integer := 0;
  v_early_departure integer := 0;
  v_worked_minutes integer := 0;
  v_overtime_minutes integer := 0;
  v_raw_id uuid;
  v_event_id uuid;
  v_request_id uuid := gen_random_uuid();
  v_previous_status text;
begin
  if p_action <> 'manualStaffAttendance' then
    return jsonb_build_object('ok', false, 'code', 'NOTEBOOK_ACTION_NOT_ALLOWED');
  end if;

  select * into v_client
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
    or 'manual_entries.create' = any(coalesce(v_permissions, array[]::text[]))
    or 'staff.manage' = any(coalesce(v_permissions, array[]::text[]))
  ) then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_PERMISSION_DENIED');
  end if;

  begin
    v_staff_id := nullif(p_payload ->> 'staffId', '')::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STAFF_ID');
  end;
  if v_staff_id is null then
    return jsonb_build_object('ok', false, 'code', 'STAFF_REQUIRED');
  end if;

  select * into v_staff
  from public.staff_attendance_profiles
  where id = v_staff_id
    and employment_status = 'active'
    and registration_status = 'active'
    and attendance_required = true;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'STAFF_INACTIVE');
  end if;

  select * into v_config
  from public.attendance_system_config
  where singleton = true;
  v_session := coalesce(v_config.operational_session, public.attendance_operational_session());
  v_term := coalesce(v_config.operational_term, public.attendance_operational_term());

  begin
    v_date := nullif(p_payload ->> 'attendanceDate', '')::date;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATE');
  end;
  if v_date is null then
    return jsonb_build_object('ok', false, 'code', 'DATE_REQUIRED');
  end if;

  v_event_type := lower(trim(coalesce(p_payload ->> 'eventType', 'check_in')));
  if v_event_type not in ('check_in', 'check_out') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_EVENT_TYPE');
  end if;
  v_slot := lower(trim(coalesce(p_payload ->> 'sessionSlot', case when v_event_type = 'check_in' then 'morning' else 'afternoon' end)));
  if v_slot not in ('morning', 'afternoon') then
    return jsonb_build_object('ok', false, 'code', 'REGISTER_SCOPE_REQUIRED');
  end if;

  v_requested_status := lower(trim(coalesce(nullif(p_payload ->> 'status', ''), 'auto')));
  if v_requested_status not in ('auto','present','late','absent','excused','leave','official_assignment','sick_leave','early_departure','half_day','not_expected','school_closed') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_STAFF_STATUS');
  end if;
  v_note := nullif(trim(coalesce(p_payload ->> 'note', '')), '');

  begin
    v_clock := nullif(trim(coalesce(p_payload ->> 'eventClock', '')), '')::time;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_EVENT_TIME');
  end;

  if v_clock is not null then
    v_event_time := ((v_date + v_clock) at time zone 'Africa/Lagos');
    if v_event_time > now() + interval '10 minutes' then
      return jsonb_build_object('ok', false, 'code', 'EVENT_TIME_IN_FUTURE');
    end if;
  end if;

  select r.* into v_rule
  from public.staff_attendance_rules r
  where r.is_active = true
    and r.academic_session = v_session
    and (r.term_scope = 'All Terms' or r.term_scope = v_term)
    and v_staff.staff_category = any(r.applies_to_categories)
  order by r.updated_at desc
  limit 1;

  if v_requested_status = 'auto' then
    if v_event_time is null then
      return jsonb_build_object('ok', false, 'code', 'STAFF_EVENT_TIME_REQUIRED');
    end if;
    if v_event_type = 'check_in' then
      if v_rule.id is not null and v_rule.on_time_until is not null and v_clock > v_rule.on_time_until then
        v_session_status := 'late';
        v_event_status := 'late';
        v_late_minutes := greatest(0, floor(extract(epoch from (v_clock - v_rule.on_time_until)) / 60)::integer);
      else
        v_session_status := 'present';
        v_event_status := 'on_time';
      end if;
    else
      if v_rule.id is not null and v_rule.expected_end is not null and v_clock < v_rule.expected_end then
        v_session_status := 'early_departure';
        v_event_status := 'early_departure';
        v_early_departure := greatest(0, floor(extract(epoch from (v_rule.expected_end - v_clock)) / 60)::integer);
      else
        v_session_status := 'present';
        v_event_status := 'checkout';
      end if;
    end if;
  else
    v_session_status := case when v_requested_status = 'leave' then 'excused' else v_requested_status end;
    if v_session_status in ('absent','excused','official_assignment','sick_leave','half_day','not_expected','school_closed') then
      v_event_time := null;
      v_event_status := 'manual';
    elsif v_event_time is null then
      return jsonb_build_object('ok', false, 'code', 'STAFF_EVENT_TIME_REQUIRED');
    elsif v_event_type = 'check_in' then
      v_event_status := case when v_session_status = 'late' then 'late' else 'manual' end;
    else
      v_event_status := case when v_session_status = 'early_departure' then 'early_departure' else 'checkout' end;
    end if;
  end if;

  v_daily_status := case
    when v_requested_status = 'leave' then 'leave'
    when v_session_status in ('sick_leave','not_expected','school_closed') then 'excused'
    when v_session_status in ('present','late','absent','excused','official_assignment','half_day') then v_session_status
    when v_event_type = 'check_in' and v_event_status = 'late' then 'late'
    when v_event_type = 'check_in' then 'present'
    else 'manual'
  end;
  v_direction := case when v_event_type = 'check_in' then 'IN' else 'OUT' end;

  perform pg_advisory_xact_lock(hashtextextended(v_staff_id::text || ':' || v_session || ':' || v_term || ':' || v_date::text, 0));

  select * into v_session_record
  from public.attendance_staff_session_records
  where staff_id = v_staff_id
    and attendance_date = v_date
    and session_slot = v_slot
    and academic_session = v_session
    and academic_term = v_term
  for update;
  if found then
    v_previous_status := v_session_record.status;
    if v_session_record.locked_at is not null then
      return jsonb_build_object('ok', false, 'code', 'REGISTER_LOCKED');
    end if;
  end if;

  if v_event_time is not null then
    insert into public.attendance_raw_events(
      event_id, source_event_id, person_type, staff_id, event_time, source_time_zone,
      direction, event_type, credential_method, raw_source_reference,
      verification_state, processing_state, deduplication_key, metadata
    ) values (
      v_request_id::text, 'manual:' || v_request_id::text, 'staff', v_staff_id,
      v_event_time, 'Africa/Lagos', v_direction, v_event_type, 'manual',
      'manual_staff_entry', 'verified', 'processed', 'manual:' || v_request_id::text,
      jsonb_build_object('manual', true, 'admin_client_id', v_client.id, 'attendance_date', v_date, 'session_slot', v_slot)
    ) returning id into v_raw_id;

    insert into public.staff_attendance_events(
      client_event_id, staff_id, event_type, event_time, attendance_status, source,
      local_recorded_at, sync_received_at, academic_session, academic_term,
      modality_metadata, note
    ) values (
      v_request_id, v_staff_id, v_event_type, v_event_time, v_event_status, 'manual',
      v_event_time, now(), v_session, v_term,
      jsonb_build_object('manual', true, 'raw_event_id', v_raw_id, 'admin_client_id', v_client.id), v_note
    ) returning id into v_event_id;
  end if;

  select * into v_daily
  from public.staff_attendance_daily
  where staff_id = v_staff_id
    and attendance_date = v_date
    and academic_session = v_session
  for update;

  if not found then
    insert into public.staff_attendance_daily(
      staff_id, attendance_date, academic_session, academic_term,
      first_check_in, last_check_out, daily_status, late_minutes,
      early_departure_minutes, worked_minutes, overtime_minutes, rule_id, note
    ) values (
      v_staff_id, v_date, v_session, v_term,
      case when v_event_type = 'check_in' then v_event_time end,
      case when v_event_type = 'check_out' then v_event_time end,
      case when v_event_time is null then v_daily_status when v_event_type = 'check_in' then v_daily_status else 'manual' end,
      v_late_minutes, v_early_departure, 0, 0, v_rule.id, v_note
    ) returning * into v_daily;
  else
    if v_event_time is null then
      update public.staff_attendance_daily
      set daily_status = v_daily_status,
          academic_term = v_term,
          rule_id = coalesce(v_rule.id, rule_id),
          note = coalesce(v_note, note),
          updated_at = now()
      where id = v_daily.id
      returning * into v_daily;
    elsif v_event_type = 'check_in' then
      update public.staff_attendance_daily
      set first_check_in = least(coalesce(first_check_in, v_event_time), v_event_time),
          academic_term = v_term,
          daily_status = case when v_event_status = 'late' then 'late' when daily_status in ('absent','manual') then 'present' else daily_status end,
          late_minutes = greatest(late_minutes, v_late_minutes),
          rule_id = coalesce(v_rule.id, rule_id),
          note = coalesce(v_note, note),
          updated_at = now()
      where id = v_daily.id
      returning * into v_daily;
    else
      v_worked_minutes := case when v_daily.first_check_in is not null then greatest(0, floor(extract(epoch from (v_event_time - v_daily.first_check_in)) / 60)::integer) else 0 end;
      v_overtime_minutes := case when v_rule.id is not null and v_rule.expected_end is not null and v_clock > v_rule.expected_end then greatest(0, floor(extract(epoch from (v_clock - v_rule.expected_end)) / 60)::integer) else 0 end;
      update public.staff_attendance_daily
      set last_check_out = greatest(coalesce(last_check_out, v_event_time), v_event_time),
          academic_term = v_term,
          early_departure_minutes = greatest(early_departure_minutes, v_early_departure),
          worked_minutes = v_worked_minutes,
          overtime_minutes = v_overtime_minutes,
          note = coalesce(v_note, note),
          updated_at = now()
      where id = v_daily.id
      returning * into v_daily;
    end if;
  end if;

  insert into public.attendance_staff_session_records(
    staff_id, attendance_date, session_slot, status, source,
    first_event_time, last_event_time, raw_event_id,
    academic_session, academic_term, note
  ) values (
    v_staff_id, v_date, v_slot, v_session_status, 'manual',
    case when v_event_type = 'check_in' then v_event_time end,
    case when v_event_type = 'check_out' then v_event_time end,
    v_raw_id, v_session, v_term, v_note
  )
  on conflict (staff_id, attendance_date, session_slot, academic_session, academic_term)
  do update set
    status = excluded.status,
    source = 'manual',
    first_event_time = case when excluded.first_event_time is null then public.attendance_staff_session_records.first_event_time else least(coalesce(public.attendance_staff_session_records.first_event_time, excluded.first_event_time), excluded.first_event_time) end,
    last_event_time = case when excluded.last_event_time is null then public.attendance_staff_session_records.last_event_time else greatest(coalesce(public.attendance_staff_session_records.last_event_time, excluded.last_event_time), excluded.last_event_time) end,
    raw_event_id = coalesce(excluded.raw_event_id, public.attendance_staff_session_records.raw_event_id),
    academic_term = excluded.academic_term,
    note = coalesce(excluded.note, public.attendance_staff_session_records.note),
    updated_at = now()
  returning * into v_session_record;

  perform public.attendance_emit_outbox_event(
    'attendance_recorded',
    'staff',
    v_staff_id::text,
    jsonb_build_object(
      'event_id', v_event_id,
      'raw_event_id', v_raw_id,
      'attendance_date', v_date,
      'session_slot', v_slot,
      'source', 'manual',
      'manual', true
    )
  );

  insert into public.attendance_admin_audit(
    admin_client_id, action, entity_type, entity_id, request_id, details
  ) values (
    v_client.id, 'staff.attendance.manual', 'staff_attendance_session',
    v_staff_id::text, v_request_id,
    jsonb_build_object(
      'staff_id', v_staff_id,
      'attendance_date', v_date,
      'session_slot', v_slot,
      'event_type', v_event_type,
      'previous_status', v_previous_status,
      'resulting_status', v_session_record.status,
      'event_time', v_event_time,
      'note', v_note
    )
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'MANUAL_STAFF_ATTENDANCE_RECORDED',
    'request_id', v_request_id,
    'staff', jsonb_build_object(
      'id', v_staff.id,
      'name', v_staff.full_name,
      'staff_number', v_staff.staff_number,
      'designation', v_staff.designation,
      'department', v_staff.department,
      'photo', v_staff.photo
    ),
    'attendance', jsonb_build_object(
      'date', v_date,
      'session_slot', v_slot,
      'event_type', v_event_type,
      'status', v_session_record.status,
      'event_time', v_event_time,
      'daily_status', v_daily.daily_status
    )
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_RECORD');
  when invalid_text_representation or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INPUT_FORMAT');
  when others then
    return jsonb_build_object('ok', false, 'code', 'ATTENDANCE_WRITE_FAILED');
end;
$$;

revoke all on function public.attendance_notebook_write_api(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.attendance_notebook_write_api(text, text, text, jsonb) to anon, authenticated;
