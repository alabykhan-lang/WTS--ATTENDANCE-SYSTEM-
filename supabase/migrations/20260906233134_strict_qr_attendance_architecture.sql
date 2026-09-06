-- Strict five-area QR attendance architecture.
-- Historical raw attendance evidence remains intact. Legacy operator APIs are
-- made inaccessible and all new attendance writes enter through this contract.

create table if not exists public.attendance_qr_settings (
  singleton boolean primary key default true check (singleton),
  admin_password_hash text,
  scanner_password_hash text,
  scanner_password_version integer not null default 1 check (scanner_password_version > 0),
  closing_time time not null default time '15:30',
  location_label text,
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  permitted_radius_metres integer check (permitted_radius_metres is null or permitted_radius_metres between 10 and 10000),
  admin_password_set_at timestamptz,
  scanner_password_set_at timestamptz,
  updated_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.attendance_qr_settings(singleton) values (true)
on conflict (singleton) do nothing;

create table if not exists public.attendance_scanner_installations (
  id uuid primary key default gen_random_uuid(),
  installation_hash text not null unique,
  token_hash text not null,
  device_name text not null,
  password_version integer not null,
  status text not null default 'active' check (status in ('active','revoked')),
  first_registered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  last_location_at timestamptz,
  last_latitude double precision,
  last_longitude double precision,
  last_location_accuracy_metres double precision,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists attendance_scanner_installations_status_seen_idx
  on public.attendance_scanner_installations(status, last_seen_at desc);

alter table public.attendance_qr_settings enable row level security;
alter table public.attendance_scanner_installations enable row level security;
revoke all on public.attendance_qr_settings from public, anon, authenticated;
revoke all on public.attendance_scanner_installations from public, anon, authenticated;

create or replace function public.attendance_strict_client(
  p_client_code text,
  p_client_secret text,
  p_permission text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_client public.attendance_admin_clients%rowtype;
  v_permissions text[];
begin
  select * into v_client
  from public.attendance_admin_clients
  where client_code = trim(coalesce(p_client_code, '')) and status = 'active';

  if not found or p_client_secret is null
     or encode(digest(p_client_secret, 'sha256'), 'hex') <> coalesce(v_client.secret_hash, '') then
    return null;
  end if;
  if v_client.session_expires_at is not null and v_client.session_expires_at <= now() then
    return null;
  end if;

  v_permissions := coalesce(public.attendance_admin_effective_permissions(v_client.id), array[]::text[]);
  if p_permission is not null and not (
    '*' = any(v_permissions)
    or p_permission = any(v_permissions)
    or (p_permission = 'reports.read' and 'settings.manage' = any(v_permissions))
  ) then
    return null;
  end if;

  update public.attendance_admin_clients
  set last_seen_at = now(), updated_at = now()
  where id = v_client.id;
  return v_client.id;
end;
$$;

create or replace function public.attendance_admin_password_valid(p_password text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, extensions
as $$
  select coalesce(
    length(trim(p_password)) > 0
    and admin_password_hash is not null
    and crypt(p_password, admin_password_hash) = admin_password_hash,
    false
  )
  from public.attendance_qr_settings
  where singleton = true
$$;

create or replace function public.attendance_scanner_register_api(
  p_password text,
  p_installation_id text,
  p_device_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_settings public.attendance_qr_settings%rowtype;
  v_installation_hash text;
  v_token text;
  v_token_hash text;
  v_row public.attendance_scanner_installations%rowtype;
begin
  select * into v_settings from public.attendance_qr_settings where singleton = true;
  if v_settings.scanner_password_hash is null then
    return jsonb_build_object('ok', false, 'code', 'SCANNER_PASSWORD_NOT_SET');
  end if;
  if p_password is null or crypt(p_password, v_settings.scanner_password_hash) <> v_settings.scanner_password_hash then
    return jsonb_build_object('ok', false, 'code', 'SCANNER_PASSWORD_INVALID');
  end if;
  if length(trim(coalesce(p_installation_id, ''))) < 16 then
    return jsonb_build_object('ok', false, 'code', 'INSTALLATION_ID_REQUIRED');
  end if;

  v_installation_hash := encode(digest(trim(p_installation_id), 'sha256'), 'hex');
  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

  insert into public.attendance_scanner_installations(
    installation_hash, token_hash, device_name, password_version, status,
    first_registered_at, last_seen_at, revoked_at, updated_at
  ) values (
    v_installation_hash, v_token_hash,
    left(coalesce(nullif(trim(p_device_name), ''), 'QR scanner'), 100),
    v_settings.scanner_password_version, 'active', now(), now(), null, now()
  )
  on conflict (installation_hash) do update set
    token_hash = excluded.token_hash,
    device_name = excluded.device_name,
    password_version = excluded.password_version,
    status = 'active', revoked_at = null, last_seen_at = now(), updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'ok', true, 'code', 'SCANNER_REGISTERED', 'installationId', v_row.id,
    'installationToken', v_token, 'deviceName', v_row.device_name
  );
end;
$$;

create or replace function public.attendance_scanner_validate_api(
  p_installation_id uuid,
  p_token text,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_accuracy double precision default null,
  p_is_sync boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_row public.attendance_scanner_installations%rowtype;
  v_settings public.attendance_qr_settings%rowtype;
begin
  select * into v_settings from public.attendance_qr_settings where singleton = true;
  select * into v_row from public.attendance_scanner_installations where id = p_installation_id;
  if not found or v_row.status <> 'active'
     or v_row.password_version <> v_settings.scanner_password_version
     or p_token is null
     or encode(digest(p_token, 'sha256'), 'hex') <> v_row.token_hash then
    return jsonb_build_object('ok', false, 'code', 'SCANNER_REGISTRATION_INVALID');
  end if;

  update public.attendance_scanner_installations set
    last_seen_at = now(),
    last_sync_at = case when p_is_sync then now() else last_sync_at end,
    last_location_at = case when p_latitude is not null and p_longitude is not null then now() else last_location_at end,
    last_latitude = coalesce(p_latitude, last_latitude),
    last_longitude = coalesce(p_longitude, last_longitude),
    last_location_accuracy_metres = coalesce(p_accuracy, last_location_accuracy_metres),
    updated_at = now()
  where id = v_row.id;

  return jsonb_build_object('ok', true, 'installationId', v_row.id, 'deviceName', v_row.device_name);
end;
$$;

create or replace function public.attendance_strict_intake(
  p_token_hash text,
  p_installation_id uuid default null,
  p_client_event_id uuid default gen_random_uuid(),
  p_event_type text default 'check_in',
  p_source text default 'qr',
  p_event_time timestamptz default now(),
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_admin_client_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_credential public.attendance_credential_index%rowtype;
  v_rule public.attendance_rules%rowtype;
  v_settings public.attendance_qr_settings%rowtype;
  v_event_time timestamptz := coalesce(p_event_time, now());
  v_tz text := 'Africa/Lagos';
  v_date date;
  v_time time;
  v_slot text;
  v_session text := public.attendance_operational_session();
  v_term text := public.attendance_operational_term();
  v_status text := 'on_time';
  v_session_status text := 'present';
  v_late_minutes integer := 0;
  v_raw_id uuid;
  v_event_id uuid;
  v_name text;
  v_class text;
  v_dedupe text;
begin
  if lower(coalesce(p_source, '')) not in ('qr', 'offline_sync') then
    return jsonb_build_object('ok', false, 'code', 'QR_SOURCE_REQUIRED');
  end if;
  if p_event_type not in ('check_in', 'check_out') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_EVENT_TYPE');
  end if;
  if p_token_hash is null or length(trim(p_token_hash)) < 16 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CREDENTIAL');
  end if;
  if v_event_time > now() + interval '10 minutes' then
    return jsonb_build_object('ok', false, 'code', 'EVENT_TIME_IN_FUTURE');
  end if;
  if p_installation_id is null and p_admin_client_id is null then
    return jsonb_build_object('ok', false, 'code', 'SCANNER_REGISTRATION_REQUIRED');
  end if;

  select * into v_credential
  from public.attendance_credential_index c
  where (c.credential_hash = trim(p_token_hash) or c.legacy_hash = trim(p_token_hash))
    and c.status = 'active'
    and c.credential_type in ('qr_token', 'qr', 'virtual')
    and c.valid_from <= v_event_time
    and (c.valid_until is null or c.valid_until >= v_event_time)
  order by c.created_at desc limit 1;

  v_dedupe := coalesce(p_client_event_id::text, encode(digest(trim(p_token_hash) || v_event_time::text, 'sha256'), 'hex'));
  if not found then
    insert into public.attendance_raw_events(
      event_id, source_event_id, credential_hash, credential_last4, event_time,
      source_time_zone, direction, event_type, credential_method,
      verification_state, processing_state, deduplication_key, rejection_code, metadata
    ) values (
      v_dedupe, v_dedupe, trim(p_token_hash), right(trim(p_token_hash), 4), v_event_time,
      v_tz, case when p_event_type = 'check_in' then 'IN' else 'OUT' end,
      p_event_type, 'qr', 'unresolved', 'unresolved', v_dedupe, 'UNKNOWN_CREDENTIAL',
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('installation_id', p_installation_id)
    ) on conflict (deduplication_key) do nothing returning id into v_raw_id;
    return jsonb_build_object('ok', false, 'code', 'UNRECOGNISED_QR', 'raw_event_id', v_raw_id);
  end if;

  v_date := (v_event_time at time zone v_tz)::date;
  v_time := (v_event_time at time zone v_tz)::time;
  v_slot := case when p_event_type = 'check_in' then 'morning' else 'afternoon' end;
  perform pg_advisory_xact_lock(hashtextextended(
    coalesce(v_credential.student_id, v_credential.staff_id)::text || '|' || v_date || '|' || v_slot || '|' || v_session || '|' || v_term,
    0
  ));

  if (v_credential.person_type = 'student' and exists (
      select 1 from public.attendance_student_session_records r
      where r.student_id = v_credential.student_id and r.attendance_date = v_date
        and r.session_slot = v_slot and r.academic_session = v_session and r.academic_term = v_term
    )) or (v_credential.person_type = 'staff' and exists (
      select 1 from public.attendance_staff_session_records r
      where r.staff_id = v_credential.staff_id and r.attendance_date = v_date
        and r.session_slot = v_slot and r.academic_session = v_session and r.academic_term = v_term
    )) then
    return jsonb_build_object('ok', true, 'code', 'DUPLICATE_IGNORED', 'duplicate', true,
      'person_type', v_credential.person_type, 'session_slot', v_slot);
  end if;

  select * into v_settings from public.attendance_qr_settings where singleton = true;
  if p_event_type = 'check_out' and v_time < coalesce(v_settings.closing_time, time '15:30')
     and length(trim(coalesce(p_note, ''))) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EARLY_CLOSING_REASON_REQUIRED');
  end if;

  select * into v_rule from public.attendance_rules where is_active = true order by updated_at desc limit 1;
  if p_event_type = 'check_in' and v_rule.id is not null and v_rule.on_time_until is not null and v_time > v_rule.on_time_until then
    v_status := 'late';
    v_session_status := 'late';
    v_late_minutes := greatest(0, floor(extract(epoch from (v_time - v_rule.on_time_until)) / 60)::integer);
  elsif p_event_type = 'check_out' and v_time < coalesce(v_settings.closing_time, time '15:30') then
    v_session_status := 'early_departure';
  end if;

  insert into public.attendance_raw_events(
    event_id, source_event_id, credential_hash, credential_last4, person_type,
    student_id, staff_id, event_time, source_time_zone, direction, event_type,
    credential_method, verification_state, processing_state, deduplication_key, metadata
  ) values (
    v_dedupe, v_dedupe, v_credential.credential_hash, v_credential.credential_last4,
    v_credential.person_type, v_credential.student_id, v_credential.staff_id, v_event_time,
    v_tz, case when p_event_type = 'check_in' then 'IN' else 'OUT' end, p_event_type,
    'qr', 'verified', 'received', v_dedupe,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('installation_id', p_installation_id, 'strict_qr', true)
  ) returning id into v_raw_id;

  if v_credential.person_type = 'student' then
    select name, class_key into v_name, v_class from public.students where id = v_credential.student_id;
    insert into public.attendance_events(
      client_event_id, student_id, card_id, event_type, event_time, attendance_status,
      source, local_recorded_at, sync_received_at, academic_session, academic_term,
      reader_reference, modality_metadata, note
    ) values (
      coalesce(p_client_event_id, gen_random_uuid()), v_credential.student_id,
      v_credential.source_credential_id, p_event_type, v_event_time, v_status,
      lower(p_source), v_event_time, now(), v_session, v_term, v_dedupe,
      jsonb_build_object('strict_qr', true, 'raw_event_id', v_raw_id, 'installation_id', p_installation_id), p_note
    ) returning id into v_event_id;

    insert into public.attendance_daily(
      student_id, attendance_date, first_check_in, last_check_out, daily_status,
      late_minutes, rule_id, note, academic_session, academic_term
    ) values (
      v_credential.student_id, v_date,
      case when p_event_type = 'check_in' then v_event_time end,
      case when p_event_type = 'check_out' then v_event_time end,
      case when v_status = 'late' then 'late' else 'present' end,
      v_late_minutes, v_rule.id, p_note, v_session, v_term
    ) on conflict (student_id, attendance_date, academic_session) do update set
      first_check_in = coalesce(public.attendance_daily.first_check_in, excluded.first_check_in),
      last_check_out = coalesce(excluded.last_check_out, public.attendance_daily.last_check_out),
      daily_status = case when excluded.daily_status = 'late' then 'late' else public.attendance_daily.daily_status end,
      late_minutes = greatest(public.attendance_daily.late_minutes, excluded.late_minutes),
      note = coalesce(excluded.note, public.attendance_daily.note), updated_at = now();

    insert into public.attendance_student_session_records(
      student_id, attendance_date, session_slot, status, source, first_event_time,
      last_event_time, raw_event_id, academic_session, academic_term, class_key_snapshot, note
    ) values (
      v_credential.student_id, v_date, v_slot, v_session_status, lower(p_source),
      v_event_time, v_event_time, v_raw_id, v_session, v_term, v_class, p_note
    );
  else
    select full_name into v_name from public.staff_attendance_profiles where id = v_credential.staff_id;
    insert into public.staff_attendance_events(
      client_event_id, staff_id, card_id, event_type, event_time, attendance_status,
      source, local_recorded_at, sync_received_at, academic_session, academic_term,
      reader_reference, modality_metadata, note
    ) values (
      coalesce(p_client_event_id, gen_random_uuid()), v_credential.staff_id,
      v_credential.source_credential_id, p_event_type, v_event_time, v_status,
      lower(p_source), v_event_time, now(), v_session, v_term, v_dedupe,
      jsonb_build_object('strict_qr', true, 'raw_event_id', v_raw_id, 'installation_id', p_installation_id), p_note
    ) returning id into v_event_id;

    insert into public.staff_attendance_daily(
      staff_id, attendance_date, academic_session, academic_term, first_check_in,
      last_check_out, daily_status, late_minutes, rule_id, note
    ) values (
      v_credential.staff_id, v_date, v_session, v_term,
      case when p_event_type = 'check_in' then v_event_time end,
      case when p_event_type = 'check_out' then v_event_time end,
      case when v_status = 'late' then 'late' else 'present' end,
      v_late_minutes, v_rule.id, p_note
    ) on conflict (staff_id, attendance_date, academic_session) do update set
      first_check_in = coalesce(public.staff_attendance_daily.first_check_in, excluded.first_check_in),
      last_check_out = coalesce(excluded.last_check_out, public.staff_attendance_daily.last_check_out),
      daily_status = case when excluded.daily_status = 'late' then 'late' else public.staff_attendance_daily.daily_status end,
      late_minutes = greatest(public.staff_attendance_daily.late_minutes, excluded.late_minutes),
      note = coalesce(excluded.note, public.staff_attendance_daily.note), updated_at = now();

    insert into public.attendance_staff_session_records(
      staff_id, attendance_date, session_slot, status, source, first_event_time,
      last_event_time, raw_event_id, academic_session, academic_term, note
    ) values (
      v_credential.staff_id, v_date, v_slot, v_session_status, lower(p_source),
      v_event_time, v_event_time, v_raw_id, v_session, v_term, p_note
    );
  end if;

  update public.attendance_raw_events set processing_state = 'processed', updated_at = now() where id = v_raw_id;
  update public.attendance_credential_index set last_used_at = greatest(coalesce(last_used_at, v_event_time), v_event_time), updated_at = now() where id = v_credential.id;
  return jsonb_build_object(
    'ok', true, 'code', 'ATTENDANCE_RECORDED', 'event_id', v_event_id,
    'raw_event_id', v_raw_id, 'person_type', v_credential.person_type,
    'person_id', coalesce(v_credential.student_id, v_credential.staff_id),
    'person_name', v_name, 'class_key', v_class, 'session_slot', v_slot,
    'attendance_status', v_session_status, 'event_time', v_event_time
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'code', 'DUPLICATE_IGNORED', 'duplicate', true);
  when others then
    if v_raw_id is not null then
      update public.attendance_raw_events set processing_state = 'rejected', verification_state = 'rejected', rejection_code = sqlstate, updated_at = now() where id = v_raw_id;
    end if;
    return jsonb_build_object('ok', false, 'code', 'ATTENDANCE_PROCESSING_FAILED', 'detail', left(sqlerrm, 180));
end;
$$;

create or replace function public.attendance_strict_read_api(
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
  v_client_id uuid;
  v_config public.attendance_system_config%rowtype;
  v_date date;
  v_period text;
  v_start date;
  v_end date;
  v_person_type text;
  v_mode text;
  v_person_id uuid;
  v_class text;
  v_rows jsonb := '[]'::jsonb;
  v_people jsonb := '[]'::jsonb;
begin
  v_client_id := public.attendance_strict_client(p_client_code, p_client_secret,
    case when p_action = 'setup' then 'settings.manage' else 'reports.read' end);
  if v_client_id is null then return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_OR_PERMISSION_FAILED'); end if;
  select * into v_config from public.attendance_system_config where singleton = true;

  if p_action = 'dashboard' then
    begin v_date := coalesce(nullif(p_payload->>'date','')::date, (now() at time zone 'Africa/Lagos')::date); exception when others then return jsonb_build_object('ok',false,'code','INVALID_DATE'); end;
    return jsonb_build_object(
      'ok', true, 'date', v_date, 'session', v_config.operational_session, 'term', v_config.operational_term,
      'morning', jsonb_build_object(
        'students', (select count(*) from public.attendance_student_session_records where attendance_date=v_date and academic_session=v_config.operational_session and academic_term=v_config.operational_term and session_slot='morning'),
        'staff', (select count(*) from public.attendance_staff_session_records where attendance_date=v_date and academic_session=v_config.operational_session and academic_term=v_config.operational_term and session_slot='morning')
      ),
      'afternoon', jsonb_build_object(
        'students', (select count(*) from public.attendance_student_session_records where attendance_date=v_date and academic_session=v_config.operational_session and academic_term=v_config.operational_term and session_slot='afternoon'),
        'staff', (select count(*) from public.attendance_staff_session_records where attendance_date=v_date and academic_session=v_config.operational_session and academic_term=v_config.operational_term and session_slot='afternoon')
      )
    );
  elsif p_action = 'people' then
    v_person_type := lower(coalesce(p_payload->>'personType','student'));
    if v_person_type = 'student' then
      select coalesce(jsonb_agg(to_jsonb(x) order by x.display_name), '[]'::jsonb) into v_people from (
        select id, 'student'::text person_type, name display_name, admno reference, class_key group_name, photo
        from public.students where archived=false and lifecycle_status='active'
          and (coalesce(p_payload->>'search','')='' or name ilike '%'||(p_payload->>'search')||'%' or coalesce(admno,'') ilike '%'||(p_payload->>'search')||'%')
        limit 500
      ) x;
    elsif v_person_type = 'staff' then
      select coalesce(jsonb_agg(to_jsonb(x) order by x.display_name), '[]'::jsonb) into v_people from (
        select id, 'staff'::text person_type, full_name display_name, staff_number reference, coalesce(designation,department) group_name, photo
        from public.staff_attendance_profiles where archived_at is null and employment_status='active' and registration_status='active'
          and (coalesce(p_payload->>'search','')='' or full_name ilike '%'||(p_payload->>'search')||'%' or coalesce(staff_number,'') ilike '%'||(p_payload->>'search')||'%')
        limit 500
      ) x;
    else return jsonb_build_object('ok',false,'code','PERSON_TYPE_REQUIRED'); end if;
    return jsonb_build_object('ok',true,'people',v_people);
  elsif p_action = 'setup' then
    return jsonb_build_object(
      'ok', true,
      'settings', (select jsonb_build_object(
        'adminPasswordSet', admin_password_hash is not null,
        'scannerPasswordSet', scanner_password_hash is not null,
        'closingTime', closing_time, 'locationLabel', location_label,
        'latitude', latitude, 'longitude', longitude, 'radiusMetres', permitted_radius_metres,
        'scannerPasswordVersion', scanner_password_version
      ) from public.attendance_qr_settings where singleton=true),
      'installations', (select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,'deviceName',device_name,'status',status,'firstRegisteredAt',first_registered_at,
        'lastSeenAt',last_seen_at,'lastSyncAt',last_sync_at,'lastLatitude',last_latitude,'lastLongitude',last_longitude
      ) order by last_seen_at desc nulls last, device_name), '[]'::jsonb) from public.attendance_scanner_installations)
    );
  elsif p_action <> 'analysis' then
    return jsonb_build_object('ok', false, 'code', 'STRICT_ACTION_NOT_ALLOWED');
  end if;

  v_person_type := lower(coalesce(p_payload->>'personType',''));
  v_mode := lower(coalesce(p_payload->>'mode',''));
  v_period := lower(coalesce(p_payload->>'period','day'));
  begin
    v_date := coalesce(nullif(p_payload->>'anchorDate','')::date, (now() at time zone 'Africa/Lagos')::date);
    v_person_id := nullif(p_payload->>'personId','')::uuid;
  exception when others then return jsonb_build_object('ok',false,'code','INVALID_ANALYSIS_FILTER'); end;
  v_class := nullif(trim(p_payload->>'classKey'),'');
  if v_person_type not in ('student','staff') or v_mode not in ('individual','general') or v_period not in ('day','week','month','term') then
    return jsonb_build_object('ok',false,'code','INVALID_ANALYSIS_FILTER');
  end if;
  if v_mode='individual' and v_person_id is null then return jsonb_build_object('ok',false,'code','PERSON_REQUIRED'); end if;
  if v_person_type='student' and v_mode='general' and v_class is null then return jsonb_build_object('ok',false,'code','CLASS_REQUIRED'); end if;

  v_start := case v_period
    when 'day' then v_date
    when 'week' then date_trunc('week',v_date)::date
    when 'month' then date_trunc('month',v_date)::date
    else coalesce(v_config.operational_start_date, date_trunc('year',v_date)::date)
  end;
  v_end := case v_period
    when 'day' then v_date
    when 'week' then v_start + 6
    when 'month' then (v_start + interval '1 month - 1 day')::date
    else coalesce(v_config.operational_end_date, v_date)
  end;

  if v_person_type='student' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.attendance_date, x.arrival nulls last, x.name), '[]'::jsonb) into v_rows from (
      select s.id person_id, s.name, s.admno reference, s.class_key group_name, coalesce(d.attendance_date,v_date) attendance_date,
        d.first_check_in arrival, d.last_check_out closing, d.daily_status status, d.late_minutes,
        coalesce(out_record.status, in_record.status, 'not_recorded') session_status,
        coalesce(out_record.note, in_record.note, d.note) note
      from public.students s
      left join public.attendance_daily d on d.student_id=s.id and d.attendance_date between v_start and v_end and d.academic_session=v_config.operational_session
      left join public.attendance_student_session_records in_record on in_record.student_id=s.id and in_record.attendance_date=d.attendance_date and in_record.session_slot='morning' and in_record.academic_session=v_config.operational_session and in_record.academic_term=v_config.operational_term
      left join public.attendance_student_session_records out_record on out_record.student_id=s.id and out_record.attendance_date=d.attendance_date and out_record.session_slot='afternoon' and out_record.academic_session=v_config.operational_session and out_record.academic_term=v_config.operational_term
      where s.archived=false and s.lifecycle_status='active'
        and (v_mode='individual' and s.id=v_person_id or v_mode='general' and s.class_key=v_class)
        and (v_period='day' or d.attendance_date is not null)
      order by d.attendance_date, d.first_check_in nulls last, s.name
    ) x;
  else
    select coalesce(jsonb_agg(to_jsonb(x) order by x.attendance_date, x.arrival nulls last, x.name), '[]'::jsonb) into v_rows from (
      select s.id person_id, s.full_name name, s.staff_number reference, coalesce(s.designation,s.department) group_name,
        coalesce(d.attendance_date,v_date) attendance_date, d.first_check_in arrival, d.last_check_out closing, d.daily_status status, d.late_minutes,
        coalesce(out_record.status, in_record.status, 'not_recorded') session_status,
        coalesce(out_record.note, in_record.note, d.note) note,
        nullif(s.metadata->>'official_signature','') official_signature
      from public.staff_attendance_profiles s
      left join public.staff_attendance_daily d on d.staff_id=s.id and d.attendance_date between v_start and v_end and d.academic_session=v_config.operational_session
      left join public.attendance_staff_session_records in_record on in_record.staff_id=s.id and in_record.attendance_date=d.attendance_date and in_record.session_slot='morning' and in_record.academic_session=v_config.operational_session and in_record.academic_term=v_config.operational_term
      left join public.attendance_staff_session_records out_record on out_record.staff_id=s.id and out_record.attendance_date=d.attendance_date and out_record.session_slot='afternoon' and out_record.academic_session=v_config.operational_session and out_record.academic_term=v_config.operational_term
      where s.archived_at is null and s.employment_status='active' and s.registration_status='active' and s.attendance_required=true
        and (v_mode='general' or s.id=v_person_id)
        and (v_period='day' or d.attendance_date is not null)
      order by d.attendance_date, d.first_check_in nulls last, s.full_name
    ) x;
  end if;

  return jsonb_build_object(
    'ok',true,'personType',v_person_type,'mode',v_mode,'period',v_period,
    'startDate',v_start,'endDate',v_end,'session',v_config.operational_session,'term',v_config.operational_term,
    'rows',v_rows
  );
end;
$$;

create or replace function public.attendance_strict_write_api(
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
  v_client_id uuid;
  v_password text;
  v_row jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_event_id uuid;
  v_source_time timestamptz;
begin
  v_client_id := public.attendance_strict_client(p_client_code,p_client_secret,'settings.manage');
  if v_client_id is null then return jsonb_build_object('ok',false,'code','ADMIN_AUTH_OR_PERMISSION_FAILED'); end if;
  v_password := coalesce(p_payload->>'adminPassword','');

  if p_action='setAdminPassword' then
    if length(coalesce(p_payload->>'newPassword','')) < 8 then return jsonb_build_object('ok',false,'code','PASSWORD_TOO_SHORT'); end if;
    update public.attendance_qr_settings set admin_password_hash=crypt(p_payload->>'newPassword',gen_salt('bf',12)), admin_password_set_at=now(), updated_by_admin_client_id=v_client_id, updated_at=now() where singleton=true;
    return jsonb_build_object('ok',true,'code','ADMIN_PASSWORD_SAVED');
  end if;

  if not public.attendance_admin_password_valid(v_password) then
    return jsonb_build_object('ok',false,'code','ADMIN_PASSWORD_INVALID');
  end if;

  if p_action='setScannerPassword' then
    if length(coalesce(p_payload->>'newPassword','')) < 6 then return jsonb_build_object('ok',false,'code','PASSWORD_TOO_SHORT'); end if;
    update public.attendance_qr_settings set scanner_password_hash=crypt(p_payload->>'newPassword',gen_salt('bf',12)), scanner_password_version=scanner_password_version+1, scanner_password_set_at=now(), updated_by_admin_client_id=v_client_id, updated_at=now() where singleton=true;
    update public.attendance_scanner_installations set status='revoked',revoked_at=now(),updated_at=now() where status='active';
    return jsonb_build_object('ok',true,'code','SCANNER_PASSWORD_SAVED','allDevicesRequireRegistration',true);
  elsif p_action='setLocation' then
    update public.attendance_qr_settings set
      location_label=nullif(trim(p_payload->>'locationLabel'),''),
      latitude=nullif(p_payload->>'latitude','')::double precision,
      longitude=nullif(p_payload->>'longitude','')::double precision,
      permitted_radius_metres=nullif(p_payload->>'radiusMetres','')::integer,
      updated_by_admin_client_id=v_client_id,updated_at=now()
    where singleton=true;
    return jsonb_build_object('ok',true,'code','LOCATION_SAVED');
  elsif p_action='revokeInstallation' then
    update public.attendance_scanner_installations set status='revoked',revoked_at=now(),updated_at=now()
    where id=nullif(p_payload->>'installationId','')::uuid;
    return jsonb_build_object('ok',true,'code','SCANNER_REVOKED');
  elsif p_action='importRows' then
    if jsonb_typeof(p_payload->'rows') <> 'array' or jsonb_array_length(p_payload->'rows') > 500 then return jsonb_build_object('ok',false,'code','IMPORT_ROWS_REQUIRED'); end if;
    for v_row in select value from jsonb_array_elements(p_payload->'rows') loop
      begin
        v_event_id := coalesce(nullif(v_row->>'clientEventId','')::uuid,gen_random_uuid());
        v_source_time := (v_row->>'recordedAt')::timestamptz;
        v_result := public.attendance_strict_intake(
          encode(digest(trim(v_row->>'credential'),'sha256'),'hex'),null,v_event_id,
          case when lower(coalesce(v_row->>'eventType',''))='check_out' then 'check_out' else 'check_in' end,
          'offline_sync',v_source_time,nullif(trim(v_row->>'reason'),''),
          jsonb_build_object('portal_import',true,'file_name',left(coalesce(p_payload->>'fileName',''),180)),v_client_id
        );
      exception when others then
        v_result := jsonb_build_object('ok',false,'code','INVALID_IMPORT_ROW');
      end;
      v_results := v_results || jsonb_build_array(v_result);
    end loop;
    return jsonb_build_object('ok',true,'code','OFFLINE_IMPORT_PROCESSED','results',v_results);
  end if;
  return jsonb_build_object('ok',false,'code','STRICT_ACTION_NOT_ALLOWED');
end;
$$;

-- QR is the only active capture method. Existing attendance evidence is not deleted.
update public.attendance_system_config set enabled_modalities=array['qr']::text[], updated_at=now() where singleton=true;
delete from public.attendance_credential_index
where credential_type not in ('qr_token','qr','virtual');

alter table public.attendance_credential_index drop constraint if exists attendance_credential_index_credential_type_check;
alter table public.attendance_credential_index add constraint attendance_credential_index_credential_type_check
  check (credential_type in ('qr_token','qr','virtual')) not valid;
alter table public.attendance_credential_index validate constraint attendance_credential_index_credential_type_check;

alter table public.attendance_events drop constraint if exists attendance_events_source_check;
alter table public.attendance_events add constraint attendance_events_source_check
  check (source in ('qr','offline_sync')) not valid;
alter table public.attendance_events validate constraint attendance_events_source_check;

alter table public.staff_attendance_events drop constraint if exists staff_attendance_events_source_check;
alter table public.staff_attendance_events add constraint staff_attendance_events_source_check
  check (source in ('qr','offline_sync')) not valid;
alter table public.staff_attendance_events validate constraint staff_attendance_events_source_check;

alter table public.attendance_student_session_records drop constraint if exists attendance_student_session_records_source_check;
alter table public.attendance_student_session_records add constraint attendance_student_session_records_source_check
  check (source in ('qr','offline_sync')) not valid;
alter table public.attendance_student_session_records validate constraint attendance_student_session_records_source_check;

alter table public.attendance_staff_session_records drop constraint if exists attendance_staff_session_records_source_check;
alter table public.attendance_staff_session_records add constraint attendance_staff_session_records_source_check
  check (source in ('qr','offline_sync')) not valid;
alter table public.attendance_staff_session_records validate constraint attendance_staff_session_records_source_check;

drop function if exists public.attendance_notebook_write_api(text,text,text,jsonb);

revoke all on function public.attendance_universal_intake(text,uuid,uuid,text,text,timestamptz,timestamptz,text,uuid,text,jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.attendance_universal_admin_read_api(text,text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.attendance_universal_admin_write_api(text,text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.attendance_notebook_read_api(text,text,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.attendance_universal_report_api(text,text,jsonb) from public,anon,authenticated,service_role;

revoke all on function public.attendance_strict_client(text,text,text) from public,anon,authenticated;
revoke all on function public.attendance_admin_password_valid(text) from public,anon,authenticated;
revoke all on function public.attendance_scanner_register_api(text,text,text) from public,anon,authenticated;
revoke all on function public.attendance_scanner_validate_api(uuid,text,double precision,double precision,double precision,boolean) from public,anon,authenticated;
revoke all on function public.attendance_strict_intake(text,uuid,uuid,text,text,timestamptz,text,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.attendance_strict_read_api(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.attendance_strict_write_api(text,text,text,jsonb) from public,anon,authenticated;

grant execute on function public.attendance_scanner_register_api(text,text,text) to service_role;
grant execute on function public.attendance_scanner_validate_api(uuid,text,double precision,double precision,double precision,boolean) to service_role;
grant execute on function public.attendance_admin_password_valid(text) to service_role;
grant execute on function public.attendance_strict_intake(text,uuid,uuid,text,text,timestamptz,text,jsonb,uuid) to service_role;
grant execute on function public.attendance_strict_read_api(text,text,text,jsonb) to anon,authenticated;
grant execute on function public.attendance_strict_write_api(text,text,text,jsonb) to anon,authenticated;

create index if not exists attendance_student_arrival_book_idx
  on public.attendance_daily(academic_session, attendance_date, first_check_in, student_id);
create index if not exists attendance_staff_arrival_book_idx
  on public.staff_attendance_daily(academic_session, attendance_date, first_check_in, staff_id);
