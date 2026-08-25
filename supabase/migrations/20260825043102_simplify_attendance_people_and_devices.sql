-- The shared student/staff card trigger previously referenced NEW.staff_id on
-- student rows (and NEW.student_id on staff rows). Reading the person keys from
-- JSON keeps one trigger function safe for both table shapes.
create or replace function public.attendance_sync_credential_index()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_person_type text;
  v_student_id uuid;
  v_staff_id uuid;
  v_credential_type text;
  v_status text;
  v_last4 text;
  v_valid_from timestamptz;
  v_valid_until timestamptz;
  v_last_used_at timestamptz;
  v_metadata jsonb;
  v_legacy_hash text;
  v_new jsonb;
begin
  if tg_op = 'DELETE' then
    delete from public.attendance_credential_index
    where source_credential_id = old.id
      and person_type = case when tg_table_name = 'student_cards' then 'student' else 'staff' end;
    return old;
  end if;

  v_new := to_jsonb(new);
  v_person_type := case when tg_table_name = 'student_cards' then 'student' else 'staff' end;
  v_student_id := nullif(v_new ->> 'student_id', '')::uuid;
  v_staff_id := nullif(v_new ->> 'staff_id', '')::uuid;
  v_metadata := coalesce(new.metadata, '{}'::jsonb);
  v_legacy_hash := coalesce(nullif(v_metadata ->> 'raw_hash', ''), new.token_hash);
  v_credential_type := coalesce(nullif(v_metadata ->> 'credential_type', ''), new.card_type);
  v_status := case new.status
    when 'damaged' then 'suspended'
    when 'active' then 'active'
    when 'pending' then 'pending'
    when 'lost' then 'lost'
    when 'replaced' then 'replaced'
    when 'revoked' then 'revoked'
    when 'expired' then 'expired'
    else 'suspended'
  end;
  v_last4 := coalesce(new.token_last4, right(new.token_hash, 4));
  v_valid_from := coalesce(new.valid_from, new.issued_at, now());
  v_valid_until := new.valid_until;
  v_last_used_at := new.last_used_at;

  delete from public.attendance_credential_index
  where source_credential_id = new.id
    and person_type = v_person_type;

  insert into public.attendance_credential_index(
    credential_hash,
    legacy_hash,
    credential_last4,
    person_type,
    student_id,
    staff_id,
    source_credential_id,
    credential_type,
    external_user_id,
    status,
    valid_from,
    valid_until,
    issued_at,
    last_used_at,
    revoked_at,
    revocation_reason,
    replaced_by,
    metadata,
    created_at,
    updated_at
  ) values (
    new.token_hash,
    v_legacy_hash,
    v_last4,
    v_person_type,
    v_student_id,
    v_staff_id,
    new.id,
    v_credential_type,
    new.metadata ->> 'external_user_id',
    v_status,
    v_valid_from,
    v_valid_until,
    coalesce(new.issued_at, now()),
    v_last_used_at,
    case when v_status in ('revoked', 'replaced', 'lost') then coalesce(new.disabled_at, now()) end,
    new.disabled_reason,
    new.replaced_by_card_id,
    v_metadata,
    coalesce(new.created_at, now()),
    now()
  );
  return new;
end;
$$;

-- Give the ID-card workspace a permission-scoped people search instead of
-- routing credential managers through the legacy administrator roster APIs.
do $$
begin
  if to_regprocedure('public.attendance_universal_admin_read_api(text,text,text,jsonb)') is not null
     and to_regprocedure('public.attendance_universal_admin_read_api_core_v2(text,text,text,jsonb)') is null then
    alter function public.attendance_universal_admin_read_api(text,text,text,jsonb)
      rename to attendance_universal_admin_read_api_core_v2;
  end if;
end;
$$;

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
  v_person_type text;
  v_search text;
  v_people jsonb;
begin
  if p_action <> 'people' then
    return public.attendance_universal_admin_read_api_core_v2(
      p_client_code,
      p_client_secret,
      p_action,
      coalesce(p_payload, '{}'::jsonb)
    );
  end if;

  select * into v_client
  from public.attendance_admin_clients
  where client_code = trim(p_client_code)
    and status = 'active';

  if not found
     or encode(digest(p_client_secret, 'sha256'), 'hex') <> v_client.secret_hash then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_FAILED');
  end if;
  if v_client.session_expires_at is not null and v_client.session_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_SESSION_EXPIRED');
  end if;

  v_permissions := public.attendance_admin_effective_permissions(v_client.id);
  if not (
    '*' = any(v_permissions)
    or 'settings.manage' = any(v_permissions)
    or 'credentials.manage' = any(v_permissions)
  ) then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_PERMISSION_DENIED');
  end if;

  v_person_type := lower(trim(coalesce(p_payload ->> 'personType', '')));
  v_search := left(trim(coalesce(p_payload ->> 'search', '')), 100);
  if v_person_type not in ('student', 'staff') then
    return jsonb_build_object('ok', false, 'code', 'PERSON_TYPE_REQUIRED');
  end if;

  if v_person_type = 'student' then
    select coalesce(jsonb_agg(to_jsonb(person_row)), '[]'::jsonb)
    into v_people
    from (
      select
        s.id,
        'student'::text as person_type,
        s.name as display_name,
        s.admno as reference,
        s.class_key as group_name,
        s.photo
      from public.students s
      where s.archived = false
        and s.lifecycle_status = 'active'
        and (
          v_search = ''
          or s.name ilike '%' || v_search || '%'
          or coalesce(s.admno, '') ilike '%' || v_search || '%'
          or coalesce(s.class_key, '') ilike '%' || v_search || '%'
        )
      order by s.name, s.admno
      limit 100
    ) person_row;
  else
    select coalesce(jsonb_agg(to_jsonb(person_row)), '[]'::jsonb)
    into v_people
    from (
      select
        s.id,
        'staff'::text as person_type,
        s.full_name as display_name,
        s.staff_number as reference,
        coalesce(nullif(s.designation, ''), nullif(s.department, ''), s.staff_category) as group_name,
        s.photo
      from public.staff_attendance_profiles s
      where s.archived_at is null
        and s.employment_status = 'active'
        and s.registration_status = 'active'
        and (
          v_search = ''
          or s.full_name ilike '%' || v_search || '%'
          or coalesce(s.staff_number, '') ilike '%' || v_search || '%'
          or coalesce(s.email, '') ilike '%' || v_search || '%'
          or coalesce(s.department, '') ilike '%' || v_search || '%'
        )
      order by s.full_name, s.staff_number
      limit 100
    ) person_row;
  end if;

  return jsonb_build_object('ok', true, 'people', v_people);
end;
$$;

revoke all on function public.attendance_universal_admin_read_api_core_v2(text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.attendance_universal_admin_read_api(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.attendance_universal_admin_read_api(text,text,text,jsonb) to anon, authenticated;

-- Add the missing device-registration action without changing the established
-- universal write contract. The secret is stored only as a SHA-256 hash and is
-- returned once alongside the generated device code.
do $$
begin
  if to_regprocedure('public.attendance_universal_admin_write_api(text,text,text,jsonb)') is not null
     and to_regprocedure('public.attendance_universal_admin_write_api_core_v1(text,text,text,jsonb)') is null then
    alter function public.attendance_universal_admin_write_api(text,text,text,jsonb)
      rename to attendance_universal_admin_write_api_core_v1;
  end if;
end;
$$;

create or replace function public.attendance_universal_admin_write_api(
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
  v_device public.attendance_devices%rowtype;
  v_code text;
  v_name text;
  v_modality text;
  v_device_type text;
  v_connection text;
  v_deployment text;
  v_sources text[];
  v_offline boolean;
  v_raw_secret text;
  v_result jsonb;
  v_request_id uuid := gen_random_uuid();
begin
  if p_action in ('issueQr', 'issueCredential') then
    v_raw_secret := 'WTSQR1-' || encode(gen_random_bytes(24), 'hex');
    v_result := public.attendance_universal_admin_write_api_core_v1(
      p_client_code,
      p_client_secret,
      'assignCredential',
      jsonb_build_object(
        'studentId', p_payload ->> 'studentId',
        'staffId', p_payload ->> 'staffId',
        'credentialType', 'qr_token',
        'rawIdentifier', v_raw_secret,
        'label', coalesce(nullif(p_payload ->> 'label', ''), 'WTS QR ID card'),
        'metadata', coalesce(p_payload -> 'metadata', '{}'::jsonb) || jsonb_build_object('issued_as', 'qr_pass')
      )
    );
    if coalesce((v_result ->> 'ok')::boolean, false) = false then
      return v_result;
    end if;
    return v_result || jsonb_build_object(
      'code', 'QR_CREDENTIAL_ISSUED',
      'credential', jsonb_build_object(
        'id', v_result ->> 'credential_id',
        'credential_type', 'qr_token',
        'token_last4', v_result ->> 'token_last4',
        'raw_token', v_raw_secret
      )
    );
  end if;

  if p_action <> 'registerDevice' then
    return public.attendance_universal_admin_write_api_core_v1(
      p_client_code,
      p_client_secret,
      p_action,
      coalesce(p_payload, '{}'::jsonb)
    );
  end if;

  select * into v_client
  from public.attendance_admin_clients
  where client_code = trim(p_client_code)
    and status = 'active';

  if not found
     or encode(digest(p_client_secret, 'sha256'), 'hex') <> v_client.secret_hash then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_AUTH_FAILED');
  end if;
  if v_client.session_expires_at is not null and v_client.session_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_SESSION_EXPIRED');
  end if;

  v_permissions := public.attendance_admin_effective_permissions(v_client.id);
  if not (
    '*' = any(v_permissions)
    or 'settings.manage' = any(v_permissions)
    or 'devices.manage' = any(v_permissions)
  ) then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_PERMISSION_DENIED');
  end if;

  v_code := upper(trim(coalesce(
    nullif(p_payload ->> 'deviceCode', ''),
    'WTS-' || substr(encode(gen_random_bytes(6), 'hex'), 1, 10)
  )));
  v_name := left(trim(coalesce(p_payload ->> 'deviceName', '')), 100);
  v_modality := lower(trim(coalesce(p_payload ->> 'modality', 'both')));

  if v_code !~ '^[A-Z0-9][A-Z0-9-]{5,39}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_CODE');
  end if;
  if length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NAME_REQUIRED');
  end if;
  if v_modality not in ('qr', 'nfc', 'both') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_METHOD');
  end if;

  v_sources := case v_modality
    when 'qr' then array['qr']::text[]
    when 'nfc' then array['nfc']::text[]
    else array['qr', 'nfc']::text[]
  end;
  v_device_type := case v_modality
    when 'qr' then 'web_scanner'
    when 'nfc' then 'usb_hid_reader'
    else 'android_scanner'
  end;
  v_connection := lower(trim(coalesce(p_payload ->> 'connectionType', 'wifi')));
  v_connection := case v_connection
    when 'mobile' then 'cellular'
    when 'bluetooth' then 'usb'
    else v_connection
  end;
  if v_connection not in ('wifi', 'ethernet', 'cellular', 'usb', 'mixed', 'offline') then
    v_connection := 'wifi';
  end if;
  v_deployment := lower(trim(coalesce(p_payload ->> 'deploymentMode', 'gate_fixed')));
  if v_deployment not in ('gate_fixed', 'reception_fixed', 'mobile_admin', 'standalone_terminal', 'development') then
    v_deployment := 'gate_fixed';
  end if;
  v_offline := lower(coalesce(p_payload ->> 'offlineEnabled', 'false')) in ('true', '1', 'yes', 'on');
  v_raw_secret := encode(gen_random_bytes(24), 'hex');

  begin
    insert into public.attendance_devices(
      device_code,
      device_name,
      assigned_gate,
      secret_hash,
      status,
      device_type,
      supported_sources,
      connection_type,
      offline_enabled,
      deployment_mode,
      metadata
    ) values (
      v_code,
      v_name,
      nullif(left(trim(coalesce(p_payload ->> 'assignedGate', '')), 100), ''),
      encode(digest(v_raw_secret, 'sha256'), 'hex'),
      'active',
      v_device_type,
      v_sources,
      v_connection,
      v_offline,
      v_deployment,
      jsonb_build_object(
        'registered_by_admin_client_id', v_client.id,
        'registration_source', 'attendance_workspace',
        'modality', v_modality
      )
    )
    returning * into v_device;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_CODE_EXISTS');
  end;

  insert into public.attendance_admin_audit(
    admin_client_id,
    action,
    entity_type,
    entity_id,
    request_id,
    details
  ) values (
    v_client.id,
    'device.register',
    'attendance_device',
    v_device.id::text,
    v_request_id,
    jsonb_build_object(
      'device_code', v_device.device_code,
      'device_name', v_device.device_name,
      'modality', v_modality,
      'connection_type', v_device.connection_type
    )
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_REGISTERED',
    'request_id', v_request_id,
    'device', to_jsonb(v_device) || jsonb_build_object('raw_secret', v_raw_secret)
  );
end;
$$;

revoke all on function public.attendance_universal_admin_write_api_core_v1(text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.attendance_universal_admin_write_api(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.attendance_universal_admin_write_api(text,text,text,jsonb) to anon, authenticated;
