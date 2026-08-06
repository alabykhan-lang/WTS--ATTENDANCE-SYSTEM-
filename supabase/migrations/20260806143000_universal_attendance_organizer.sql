-- WTS Attendance System: additive universal attendance organizer
-- This migration does not create people, classes, devices or attendance facts.
-- It adds the durable intake, register, import and audit boundaries used by the
-- Attendance application. Central Registry remains the identity authority.

create table if not exists public.attendance_credential_index (
  id uuid primary key default gen_random_uuid(),
  credential_hash text not null,
  legacy_hash text,
  credential_last4 text,
  person_type text not null check (person_type in ('student','staff')),
  student_id uuid references public.students(id) on delete restrict,
  staff_id uuid references public.staff_attendance_profiles(id) on delete restrict,
  source_credential_id uuid,
  credential_type text not null check (credential_type in (
    'qr_token','nfc_uid','mifare_uid','rfid_uid','generic_card_uid',
    'fingerprint_device_user_id','face_device_user_id','pin',
    'external_device_user_id','barcode','temporary_pass','qr','nfc','rfid','hybrid','virtual'
  )),
  external_user_id text,
  device_id uuid references public.attendance_devices(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','active','lost','suspended','revoked','expired','replaced')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  issued_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  replaced_by uuid references public.attendance_credential_index(id) on delete set null,
  created_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((student_id is not null and staff_id is null) or (student_id is null and staff_id is not null)),
  check (valid_until is null or valid_until > valid_from)
);

create unique index if not exists attendance_credential_index_active_hash_uq
  on public.attendance_credential_index(credential_hash)
  where status in ('pending','active');
create unique index if not exists attendance_credential_index_active_legacy_hash_uq
  on public.attendance_credential_index(legacy_hash)
  where legacy_hash is not null and status in ('pending','active');
create unique index if not exists attendance_credential_index_source_uq
  on public.attendance_credential_index(person_type, source_credential_id)
  where source_credential_id is not null;
create index if not exists attendance_credential_index_person_idx
  on public.attendance_credential_index(person_type, student_id, staff_id, status);

create table if not exists public.attendance_import_batches (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references public.attendance_devices(id) on delete set null,
  source_type text not null check (source_type in ('csv','xlsx','text','google_sheets','manual','vendor_export')),
  file_name text,
  checksum_sha256 text,
  adapter_code text not null default 'generic_delimited',
  uploaded_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  original_row_count integer not null default 0,
  accepted_count integer not null default 0,
  duplicate_count integer not null default 0,
  rejected_count integer not null default 0,
  unresolved_count integer not null default 0,
  status text not null default 'uploaded' check (status in ('uploaded','previewed','confirmed','completed','completed_with_errors','rejected','cancelled')),
  error_summary jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists attendance_import_batches_checksum_uq
  on public.attendance_import_batches(device_id, checksum_sha256)
  where checksum_sha256 is not null;
create unique index if not exists attendance_import_batches_checksum_global_uq
  on public.attendance_import_batches(checksum_sha256)
  where checksum_sha256 is not null;

create table if not exists public.attendance_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.attendance_import_batches(id) on delete cascade,
  row_number integer not null,
  raw_record jsonb not null default '{}'::jsonb,
  raw_identifier text,
  normalized_identifier text,
  credential_hash text,
  external_user_id text,
  event_time timestamptz,
  source_time_zone text,
  direction text check (direction is null or direction in ('IN','OUT','UNSPECIFIED','check_in','check_out')),
  event_type text check (event_type is null or event_type in ('check_in','check_out')),
  credential_method text,
  source_event_id text,
  resolved_person_type text check (resolved_person_type is null or resolved_person_type in ('student','staff')),
  resolved_student_id uuid references public.students(id) on delete set null,
  resolved_staff_id uuid references public.staff_attendance_profiles(id) on delete set null,
  validation_status text not null default 'pending' check (validation_status in ('pending','ready','duplicate','unknown_identity','invalid_date_time','invalid_credential','already_processed','outside_period','device_not_authorised','processed','rejected')),
  validation_code text,
  validation_reason text,
  duplicate_of uuid,
  created_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id, row_number)
);
create index if not exists attendance_import_rows_batch_status_idx
  on public.attendance_import_rows(batch_id, validation_status);

create table if not exists public.attendance_raw_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  source_event_id text,
  device_id uuid references public.attendance_devices(id) on delete set null,
  import_batch_id uuid references public.attendance_import_batches(id) on delete set null,
  credential_hash text,
  credential_last4 text,
  person_type text check (person_type is null or person_type in ('student','staff')),
  student_id uuid references public.students(id) on delete set null,
  staff_id uuid references public.staff_attendance_profiles(id) on delete set null,
  event_time timestamptz not null,
  received_at timestamptz not null default now(),
  source_time_zone text,
  direction text not null default 'UNSPECIFIED' check (direction in ('IN','OUT','UNSPECIFIED')),
  event_type text not null check (event_type in ('check_in','check_out')),
  credential_method text,
  physical_location text,
  raw_source_reference text,
  verification_state text not null default 'unresolved' check (verification_state in ('verified','unresolved','rejected','duplicate')),
  processing_state text not null default 'received' check (processing_state in ('received','processed','unresolved','rejected','duplicate')),
  deduplication_key text not null unique,
  duplicate_of uuid references public.attendance_raw_events(id) on delete set null,
  rejection_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists attendance_raw_events_person_time_idx
  on public.attendance_raw_events(student_id, staff_id, event_time desc);
create index if not exists attendance_raw_events_device_time_idx
  on public.attendance_raw_events(device_id, event_time desc);

create table if not exists public.attendance_student_session_records (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  attendance_date date not null,
  session_slot text not null check (session_slot in ('morning','afternoon')),
  status text not null default 'incomplete' check (status in ('present','absent','late','excused','official_activity','sick_leave','early_departure','half_day','school_activity','not_expected','school_closed','incomplete')),
  source text not null default 'manual' check (source in ('manual','qr','nfc','mifare','rfid','card','fingerprint','face','pin','import','google_sheets','correction','device','usb_hid','usb_ccid','standalone_terminal','offline_sync')),
  first_event_time timestamptz,
  last_event_time timestamptz,
  raw_event_id uuid references public.attendance_raw_events(id) on delete set null,
  academic_session text not null,
  academic_term text not null,
  class_key_snapshot text,
  confirmed_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  confirmed_at timestamptz,
  locked_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(student_id, attendance_date, session_slot, academic_session, academic_term)
);
create index if not exists attendance_student_session_report_idx
  on public.attendance_student_session_records(academic_session, academic_term, attendance_date, class_key_snapshot, session_slot);

create table if not exists public.attendance_staff_session_records (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_attendance_profiles(id) on delete restrict,
  attendance_date date not null,
  session_slot text not null check (session_slot in ('morning','afternoon')),
  status text not null default 'incomplete' check (status in ('present','absent','late','excused','official_assignment','sick_leave','early_departure','half_day','not_expected','school_closed','incomplete')),
  source text not null default 'manual' check (source in ('manual','qr','nfc','mifare','rfid','card','fingerprint','face','pin','import','google_sheets','correction','device','usb_hid','usb_ccid','standalone_terminal','offline_sync')),
  first_event_time timestamptz,
  last_event_time timestamptz,
  raw_event_id uuid references public.attendance_raw_events(id) on delete set null,
  academic_session text not null,
  academic_term text not null,
  confirmed_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  confirmed_at timestamptz,
  locked_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(staff_id, attendance_date, session_slot, academic_session, academic_term)
);
create index if not exists attendance_staff_session_report_idx
  on public.attendance_staff_session_records(academic_session, academic_term, attendance_date, session_slot);

create table if not exists public.attendance_register_locks (
  id uuid primary key default gen_random_uuid(),
  academic_session text not null,
  academic_term text not null,
  attendance_date date not null,
  class_key text not null,
  session_slot text not null check (session_slot in ('morning','afternoon')),
  status text not null default 'open' check (status in ('open','confirmed','closed','reopened','archived')),
  confirmed_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  confirmed_at timestamptz,
  closed_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  closed_at timestamptz,
  reopened_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(academic_session, academic_term, attendance_date, class_key, session_slot)
);

create table if not exists public.attendance_register_correction_requests (
  id uuid primary key default gen_random_uuid(),
  person_type text not null check (person_type in ('student','staff')),
  student_session_id uuid references public.attendance_student_session_records(id) on delete restrict,
  staff_session_id uuid references public.attendance_staff_session_records(id) on delete restrict,
  requested_status text not null,
  requested_note text,
  reason text not null,
  evidence_note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  requested_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  reviewed_by_admin_client_id uuid references public.attendance_admin_clients(id) on delete set null,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  applied_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((person_type='student' and student_session_id is not null and staff_session_id is null) or (person_type='staff' and staff_session_id is not null and student_session_id is null))
);

create table if not exists public.attendance_outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text,
  aggregate_id text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','claimed','delivered','failed','cancelled')),
  occurred_at timestamptz not null default now(),
  delivered_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists attendance_outbox_events_pending_idx on public.attendance_outbox_events(status, occurred_at);

-- Existing card tables predate the universal credential vocabulary. Expand only
-- their allowed status/type vocabulary; historical rows are not changed.
alter table public.student_cards drop constraint if exists student_cards_card_type_check;
alter table public.student_cards add constraint student_cards_card_type_check check (card_type = any (array[
  'qr','nfc','rfid','hybrid','virtual','mifare','generic_card','fingerprint_device_user_id',
  'face_device_user_id','pin','external_device_user_id','barcode','temporary_pass'
]::text[]));
alter table public.student_cards drop constraint if exists student_cards_status_check;
alter table public.student_cards add constraint student_cards_status_check check (status = any (array[
  'active','pending','lost','damaged','replaced','suspended','revoked','expired'
]::text[]));
alter table public.staff_cards drop constraint if exists staff_cards_card_type_check;
alter table public.staff_cards add constraint staff_cards_card_type_check check (card_type = any (array[
  'qr','nfc','rfid','hybrid','virtual','mifare','generic_card','fingerprint_device_user_id',
  'face_device_user_id','pin','external_device_user_id','barcode','temporary_pass'
]::text[]));
alter table public.staff_cards drop constraint if exists staff_cards_status_check;
alter table public.staff_cards add constraint staff_cards_status_check check (status = any (array[
  'active','pending','lost','damaged','replaced','suspended','revoked','expired'
]::text[]));

create or replace function public.attendance_normalize_identifier(p_raw text, p_type text default 'generic_card_uid')
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select case
    when lower(coalesce(p_type,'')) in ('qr','qr_token','barcode','temporary_pass','pin') then trim(coalesce(p_raw,''))
    else upper(regexp_replace(trim(coalesce(p_raw,'')), '[^A-Za-z0-9_-]+', '', 'g'))
  end
$$;

create or replace function public.attendance_hash_identifier(p_raw text, p_type text default 'generic_card_uid')
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select encode(digest(public.attendance_normalize_identifier(p_raw,p_type),'sha256'),'hex')
$$;

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
begin
  if tg_op = 'DELETE' then
    delete from public.attendance_credential_index
    where source_credential_id = old.id
      and person_type = case when tg_table_name='student_cards' then 'student' else 'staff' end;
    return old;
  end if;

  v_person_type := case when tg_table_name='student_cards' then 'student' else 'staff' end;
  v_student_id := case when v_person_type='student' then new.student_id end;
  v_staff_id := case when v_person_type='staff' then new.staff_id end;
  v_metadata := coalesce(new.metadata,'{}'::jsonb);
  v_legacy_hash := coalesce(nullif(v_metadata->>'raw_hash',''),new.token_hash);
  v_credential_type := coalesce(nullif(v_metadata->>'credential_type',''), new.card_type);
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
  v_last4 := coalesce(new.token_last4, right(new.token_hash,4));
  v_valid_from := coalesce(new.valid_from,new.issued_at,now());
  v_valid_until := new.valid_until;
  v_last_used_at := new.last_used_at;

  delete from public.attendance_credential_index
  where source_credential_id = new.id and person_type = v_person_type;
  insert into public.attendance_credential_index(
    credential_hash,legacy_hash,credential_last4,person_type,student_id,staff_id,
    source_credential_id,credential_type,external_user_id,status,valid_from,valid_until,
    issued_at,last_used_at,revoked_at,revocation_reason,replaced_by,metadata,created_at,updated_at
  ) values (
    new.token_hash,v_legacy_hash,v_last4,v_person_type,v_student_id,v_staff_id,
    new.id,v_credential_type,new.metadata->>'external_user_id',v_status,v_valid_from,v_valid_until,
    coalesce(new.issued_at,now()),v_last_used_at,
    case when v_status in ('revoked','replaced','lost') then coalesce(new.disabled_at,now()) end,
    new.disabled_reason,new.replaced_by_card_id,v_metadata,coalesce(new.created_at,now()),now()
  );
  return new;
end;
$$;

drop trigger if exists attendance_sync_student_credential_index on public.student_cards;
create trigger attendance_sync_student_credential_index
after insert or update or delete on public.student_cards
for each row execute function public.attendance_sync_credential_index();
drop trigger if exists attendance_sync_staff_credential_index on public.staff_cards;
create trigger attendance_sync_staff_credential_index
after insert or update or delete on public.staff_cards
for each row execute function public.attendance_sync_credential_index();

insert into public.attendance_credential_index(
  credential_hash,legacy_hash,credential_last4,person_type,student_id,source_credential_id,
  credential_type,status,valid_from,valid_until,issued_at,last_used_at,revoked_at,
  revocation_reason,replaced_by,metadata,created_at,updated_at
)
select c.token_hash,c.token_hash,coalesce(c.token_last4,right(c.token_hash,4)),'student',c.student_id,c.id,
  coalesce(nullif(c.metadata->>'credential_type',''),c.card_type),
  case c.status when 'active' then 'active' when 'pending' then 'pending' when 'lost' then 'lost'
    when 'replaced' then 'replaced' when 'revoked' then 'revoked' when 'expired' then 'expired' else 'suspended' end,
  coalesce(c.valid_from,c.issued_at,now()),c.valid_until,c.issued_at,c.last_used_at,
  case when c.status in ('revoked','replaced','lost') then coalesce(c.disabled_at,now()) end,
  c.disabled_reason,c.replaced_by_card_id,coalesce(c.metadata,'{}'::jsonb),c.created_at,now()
from public.student_cards c
where not exists (select 1 from public.attendance_credential_index i where i.source_credential_id=c.id and i.person_type='student');

insert into public.attendance_credential_index(
  credential_hash,legacy_hash,credential_last4,person_type,staff_id,source_credential_id,
  credential_type,status,valid_from,valid_until,issued_at,last_used_at,revoked_at,
  revocation_reason,replaced_by,metadata,created_at,updated_at
)
select c.token_hash,c.token_hash,coalesce(c.token_last4,right(c.token_hash,4)),'staff',c.staff_id,c.id,
  coalesce(nullif(c.metadata->>'credential_type',''),c.card_type),
  case c.status when 'active' then 'active' when 'pending' then 'pending' when 'lost' then 'lost'
    when 'replaced' then 'replaced' when 'revoked' then 'revoked' when 'expired' then 'expired' else 'suspended' end,
  coalesce(c.valid_from,c.issued_at,now()),c.valid_until,c.issued_at,c.last_used_at,
  case when c.status in ('revoked','replaced','lost') then coalesce(c.disabled_at,now()) end,
  c.disabled_reason,c.replaced_by_card_id,coalesce(c.metadata,'{}'::jsonb),c.created_at,now()
from public.staff_cards c
where not exists (select 1 from public.attendance_credential_index i where i.source_credential_id=c.id and i.person_type='staff');

-- The role catalogue is configuration, not an assignment. No person receives a
-- role here; assignments remain an Attendance administrator decision.
insert into public.attendance_admin_roles(role_code,role_name,description,permissions,is_system)
values
  ('personal_attendance_viewer','Personal Attendance Viewer','Read only the signed-in person attendance summary.',array['dashboard.read','personal.attendance.read','corrections.create'],true),
  ('class_attendance_recorder','Class Attendance Recorder','Record and confirm morning and afternoon registers for assigned classes.',array['dashboard.read','class.attendance.read','class.attendance.write','attendance.register.confirm','corrections.create'],true),
  ('class_attendance_viewer','Class Attendance Viewer','Read assigned class registers and reports.',array['dashboard.read','class.attendance.read','reports.read'],true),
  ('staff_attendance_viewer','Staff Attendance Viewer','Read staff attendance reports within assigned scope.',array['dashboard.read','staff.read','personal.attendance.read'],true),
  ('attendance_supervisor','Attendance Supervisor','Review incomplete registers and corrections.',array['dashboard.read','class.attendance.read','staff.read','reports.read','corrections.review','manual_entries.review'],true),
  ('attendance_administrator','Attendance Administrator','Operate Attendance records, imports, corrections and reports.',array['dashboard.read','class.attendance.read','class.attendance.write','attendance.register.confirm','staff.read','reports.read','credentials.manage','imports.manage','corrections.create','corrections.review','manual_entries.create','manual_entries.review','settings.manage'],true),
  ('device_administrator','Device Administrator','Register, suspend and inspect Attendance devices.',array['dashboard.read','devices.read','devices.manage','imports.read'],true),
  ('import_administrator','Import Administrator','Preview, map and confirm terminal imports.',array['dashboard.read','imports.read','imports.manage','credentials.manage','reports.read'],true),
  ('report_viewer','Report Viewer','Read approved student and staff reports.',array['dashboard.read','reports.read'],true),
  ('super_administrator','Super Administrator','All Attendance actions, subject to central module access.',array['*'],true)
on conflict (role_code) do nothing;

create or replace function public.attendance_emit_outbox_event(
  p_event_type text, p_aggregate_type text, p_aggregate_id text, p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare v_id uuid;
begin
  insert into public.attendance_outbox_events(event_type,aggregate_type,aggregate_id,payload)
  values(p_event_type,p_aggregate_type,p_aggregate_id,coalesce(p_payload,'{}'::jsonb)) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.attendance_universal_intake(
  p_token_hash text,
  p_device_id uuid default null,
  p_client_event_id uuid default gen_random_uuid(),
  p_event_type text default 'check_in',
  p_source text default 'import',
  p_event_time timestamptz default now(),
  p_local_recorded_at timestamptz default null,
  p_source_event_id text default null,
  p_import_batch_id uuid default null,
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
  v_raw_id uuid;
  v_event_id uuid;
  v_student_daily public.attendance_daily%rowtype;
  v_staff_daily public.staff_attendance_daily%rowtype;
  v_student_event_id uuid;
  v_staff_event_id uuid;
  v_session text := coalesce(nullif(p_metadata->>'academic_session',''),public.attendance_operational_session());
  v_term text := coalesce(nullif(p_metadata->>'academic_term',''),public.attendance_operational_term());
  v_tz text := coalesce(nullif(p_metadata->>'source_time_zone',''),'Africa/Lagos');
  v_event_time timestamptz := coalesce(p_event_time,now());
  v_date date;
  v_slot text;
  v_status text;
  v_daily_status text;
  v_source text := lower(coalesce(p_source,'import'));
  v_direction text;
  v_dedupe text;
  v_existing public.attendance_raw_events%rowtype;
  v_rule public.attendance_rules%rowtype;
  v_late_minutes integer := 0;
  v_local_time time;
  v_outbox_id uuid;
begin
  if p_token_hash is null or length(trim(p_token_hash)) < 16 then
    return jsonb_build_object('ok',false,'code','INVALID_CREDENTIAL');
  end if;
  if p_event_type not in ('check_in','check_out') then
    return jsonb_build_object('ok',false,'code','INVALID_EVENT_TYPE');
  end if;
  if v_event_time > now() + interval '10 minutes' then
    return jsonb_build_object('ok',false,'code','EVENT_TIME_IN_FUTURE');
  end if;
  if p_admin_client_id is null then
    if p_device_id is null or not exists (
      select 1 from public.attendance_devices d
      where d.id=p_device_id and d.status='active' and d.scan_enabled=true
    ) then
      return jsonb_build_object('ok',false,'code','DEVICE_AUTH_FAILED');
    end if;
  end if;

  v_direction := case when p_event_type='check_in' then 'IN' else 'OUT' end;
  v_dedupe := coalesce(nullif(trim(p_source_event_id),''),p_client_event_id::text,
    md5(coalesce(p_token_hash,'')||'|'||to_char(v_event_time,'YYYY-MM-DD"T"HH24:MI:SS.MS TZH:TZM')||'|'||coalesce(p_device_id::text,'')));
  select * into v_existing from public.attendance_raw_events where deduplication_key=v_dedupe limit 1;
  if found then
    return jsonb_build_object('ok',true,'code','DUPLICATE_IGNORED','duplicate',true,'raw_event_id',v_existing.id);
  end if;

  select * into v_credential
  from public.attendance_credential_index i
  where (i.credential_hash=trim(p_token_hash) or i.legacy_hash=trim(p_token_hash))
    and i.status='active'
    and i.valid_from <= v_event_time
    and (i.valid_until is null or i.valid_until >= v_event_time)
  order by i.created_at desc limit 1;

  if not found then
    insert into public.attendance_raw_events(
      event_id,source_event_id,device_id,import_batch_id,credential_hash,credential_last4,event_time,
      source_time_zone,direction,event_type,credential_method,raw_source_reference,
      verification_state,processing_state,deduplication_key,rejection_code,metadata
    ) values(
      coalesce(p_client_event_id::text,v_dedupe),nullif(p_source_event_id,''),p_device_id,p_import_batch_id,
      trim(p_token_hash),right(trim(p_token_hash),4),v_event_time,v_tz,v_direction,p_event_type,
      nullif(p_metadata->>'credential_method',''),nullif(p_metadata->>'raw_source_reference',''),
      'unresolved','unresolved',v_dedupe,'UNKNOWN_CREDENTIAL',coalesce(p_metadata,'{}'::jsonb)
    ) returning id into v_raw_id;
    perform public.attendance_emit_outbox_event('unknown_credential_detected','attendance_raw_event',v_raw_id::text,
      jsonb_build_object('device_id',p_device_id,'source',v_source,'credential_last4',right(trim(p_token_hash),4),'event_time',v_event_time));
    return jsonb_build_object('ok',false,'code','UNRECOGNISED_CREDENTIAL','raw_event_id',v_raw_id);
  end if;

  v_date := (v_event_time at time zone v_tz)::date;
  v_local_time := (v_event_time at time zone v_tz)::time;
  v_slot := case when extract(hour from v_local_time) < 12 then 'morning' else 'afternoon' end;
  select * into v_rule from public.attendance_rules r where r.is_active=true order by r.updated_at desc limit 1;
  if v_rule.id is not null and v_slot='morning' and v_rule.on_time_until is not null and v_local_time > v_rule.on_time_until then
    v_status := 'late';
    v_late_minutes := greatest(0,floor(extract(epoch from (v_local_time-v_rule.on_time_until))/60)::integer);
  else
    v_status := 'on_time';
  end if;
  v_daily_status := case when v_status='late' then 'late' else 'present' end;

  insert into public.attendance_raw_events(
    event_id,source_event_id,device_id,import_batch_id,credential_hash,credential_last4,person_type,
    student_id,staff_id,event_time,source_time_zone,direction,event_type,credential_method,
    physical_location,raw_source_reference,verification_state,processing_state,deduplication_key,metadata
  ) values(
    coalesce(p_client_event_id::text,v_dedupe),nullif(p_source_event_id,''),p_device_id,p_import_batch_id,
    v_credential.credential_hash,v_credential.credential_last4,v_credential.person_type,v_credential.student_id,
    v_credential.staff_id,v_event_time,v_tz,v_direction,p_event_type,
    coalesce(nullif(p_metadata->>'credential_method',''),v_credential.credential_type),
    nullif(p_metadata->>'physical_location',''),nullif(p_metadata->>'raw_source_reference',''),
    'verified','received',v_dedupe,coalesce(p_metadata,'{}'::jsonb)
  ) returning id into v_raw_id;

  if v_credential.person_type='student' then
    insert into public.attendance_events(
      client_event_id,student_id,card_id,device_id,event_type,event_time,attendance_status,source,
      local_recorded_at,sync_received_at,academic_session,academic_term,reader_reference,modality_metadata,note
    ) values(
      coalesce(p_client_event_id,gen_random_uuid()),v_credential.student_id,
      case when v_credential.source_credential_id is not null then v_credential.source_credential_id end,
      p_device_id,p_event_type,v_event_time,v_status,
      case when v_source in ('qr','nfc','rfid','usb_hid','usb_ccid','standalone_terminal','offline_sync','manual','import') then v_source else 'import' end,
      p_local_recorded_at,now(),v_session,v_term,p_source_event_id,
      jsonb_build_object('universal_intake',true,'raw_event_id',v_raw_id,'credential_type',v_credential.credential_type),p_note
    ) returning id into v_student_event_id;

    select * into v_student_daily from public.attendance_daily d
    where d.student_id=v_credential.student_id and d.attendance_date=v_date and d.academic_session=v_session;
    if not found then
      insert into public.attendance_daily(student_id,attendance_date,first_check_in,last_check_out,daily_status,late_minutes,rule_id,note,academic_session,academic_term)
      values(v_credential.student_id,v_date,case when p_event_type='check_in' then v_event_time end,case when p_event_type='check_out' then v_event_time end,v_daily_status,v_late_minutes,v_rule.id,p_note,v_session,v_term)
      returning * into v_student_daily;
    else
      update public.attendance_daily
      set first_check_in=case when p_event_type='check_in' then least(coalesce(first_check_in,v_event_time),v_event_time) else first_check_in end,
          last_check_out=case when p_event_type='check_out' then greatest(coalesce(last_check_out,v_event_time),v_event_time) else last_check_out end,
          daily_status=case when daily_status in ('absent','manual') or v_daily_status='late' then v_daily_status else daily_status end,
          late_minutes=greatest(late_minutes,v_late_minutes),updated_at=now(),note=coalesce(p_note,note)
      where id=v_student_daily.id returning * into v_student_daily;
    end if;

    insert into public.attendance_student_session_records(
      student_id,attendance_date,session_slot,status,source,first_event_time,last_event_time,raw_event_id,
      academic_session,academic_term,class_key_snapshot,note
    ) values(
      v_credential.student_id,v_date,v_slot,case when v_status='late' then 'late' else 'present' end,
      case when v_source in ('qr','nfc','rfid','manual','import') then v_source else 'device' end,v_event_time,v_event_time,v_raw_id,v_session,v_term,
      (select s.class_key from public.students s where s.id=v_credential.student_id),p_note
    ) on conflict(student_id,attendance_date,session_slot,academic_session,academic_term)
    do update set status=case when excluded.status='late' then 'late' else public.attendance_student_session_records.status end,
      first_event_time=least(coalesce(public.attendance_student_session_records.first_event_time,excluded.first_event_time),excluded.first_event_time),
      last_event_time=greatest(coalesce(public.attendance_student_session_records.last_event_time,excluded.last_event_time),excluded.last_event_time),
      raw_event_id=coalesce(excluded.raw_event_id,public.attendance_student_session_records.raw_event_id),updated_at=now();
  else
    insert into public.staff_attendance_events(
      client_event_id,staff_id,card_id,device_id,event_type,event_time,attendance_status,source,
      local_recorded_at,sync_received_at,academic_session,academic_term,reader_reference,modality_metadata,note
    ) values(
      coalesce(p_client_event_id,gen_random_uuid()),v_credential.staff_id,v_credential.source_credential_id,p_device_id,
      p_event_type,v_event_time,case when v_status='late' then 'late' else 'on_time' end,
      case when v_source in ('qr','nfc','rfid','usb_hid','usb_ccid','standalone_terminal','offline_sync','manual','import') then v_source else 'import' end,
      p_local_recorded_at,now(),v_session,v_term,p_source_event_id,
      jsonb_build_object('universal_intake',true,'raw_event_id',v_raw_id,'credential_type',v_credential.credential_type),p_note
    ) returning id into v_staff_event_id;

    select * into v_staff_daily from public.staff_attendance_daily d
    where d.staff_id=v_credential.staff_id and d.attendance_date=v_date and d.academic_session=v_session;
    if not found then
      insert into public.staff_attendance_daily(staff_id,attendance_date,first_check_in,last_check_out,daily_status,late_minutes,academic_session,academic_term,rule_id,note)
      values(v_credential.staff_id,v_date,case when p_event_type='check_in' then v_event_time end,case when p_event_type='check_out' then v_event_time end,v_daily_status,v_late_minutes,v_session,v_term,v_rule.id,p_note)
      returning * into v_staff_daily;
    else
      update public.staff_attendance_daily
      set first_check_in=case when p_event_type='check_in' then least(coalesce(first_check_in,v_event_time),v_event_time) else first_check_in end,
          last_check_out=case when p_event_type='check_out' then greatest(coalesce(last_check_out,v_event_time),v_event_time) else last_check_out end,
          daily_status=case when daily_status in ('absent','manual') or v_daily_status='late' then v_daily_status else daily_status end,
          late_minutes=greatest(late_minutes,v_late_minutes),updated_at=now(),note=coalesce(p_note,note)
      where id=v_staff_daily.id returning * into v_staff_daily;
    end if;

    insert into public.attendance_staff_session_records(
      staff_id,attendance_date,session_slot,status,source,first_event_time,last_event_time,raw_event_id,academic_session,academic_term,note
    ) values(
      v_credential.staff_id,v_date,v_slot,case when v_status='late' then 'late' else 'present' end,
      case when v_source in ('qr','nfc','rfid','manual','import') then v_source else 'device' end,v_event_time,v_event_time,v_raw_id,v_session,v_term,p_note
    ) on conflict(staff_id,attendance_date,session_slot,academic_session,academic_term)
    do update set status=case when excluded.status='late' then 'late' else public.attendance_staff_session_records.status end,
      first_event_time=least(coalesce(public.attendance_staff_session_records.first_event_time,excluded.first_event_time),excluded.first_event_time),
      last_event_time=greatest(coalesce(public.attendance_staff_session_records.last_event_time,excluded.last_event_time),excluded.last_event_time),
      raw_event_id=coalesce(excluded.raw_event_id,public.attendance_staff_session_records.raw_event_id),updated_at=now();
  end if;

  update public.attendance_raw_events set processing_state='processed',updated_at=now() where id=v_raw_id;
  update public.attendance_credential_index set last_used_at=greatest(coalesce(last_used_at,v_event_time),v_event_time),updated_at=now() where id=v_credential.id;
  if p_device_id is not null then update public.attendance_devices set last_seen_at=now(),last_sync_at=case when v_source in ('import','offline_sync') then now() else last_sync_at end,updated_at=now() where id=p_device_id; end if;
  v_event_id := coalesce(v_student_event_id,v_staff_event_id);
  v_outbox_id := public.attendance_emit_outbox_event('attendance_recorded',case when v_credential.person_type='student' then 'student' else 'staff' end,coalesce(v_credential.student_id,v_credential.staff_id)::text,jsonb_build_object('event_id',v_event_id,'raw_event_id',v_raw_id,'attendance_date',v_date,'session_slot',v_slot,'source',v_source));
  return jsonb_build_object('ok',true,'code','ATTENDANCE_RECORDED','event_id',v_event_id,'raw_event_id',v_raw_id,'person_type',v_credential.person_type,'person_id',coalesce(v_credential.student_id,v_credential.staff_id),'session_slot',v_slot,'attendance_status',v_daily_status,'event_time',v_event_time,'outbox_id',v_outbox_id);
exception
  when unique_violation then
    if v_raw_id is not null then update public.attendance_raw_events set processing_state='duplicate',verification_state='duplicate',updated_at=now() where id=v_raw_id; end if;
    return jsonb_build_object('ok',true,'code','DUPLICATE_IGNORED','duplicate',true,'raw_event_id',v_raw_id);
  when others then
    if v_raw_id is not null then update public.attendance_raw_events set processing_state='rejected',verification_state='rejected',rejection_code=sqlstate,updated_at=now() where id=v_raw_id; end if;
    return jsonb_build_object('ok',false,'code','ATTENDANCE_PROCESSING_FAILED','detail',left(sqlerrm,180),'raw_event_id',v_raw_id);
end;
$$;

create or replace function public.attendance_universal_admin_read_api(
  p_client_code text, p_client_secret text, p_action text, p_payload jsonb default '{}'::jsonb
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
  v_from date;
  v_to date;
  v_slot text;
  v_class text;
  v_person_type text;
  v_search text := trim(coalesce(p_payload->>'search',''));
  v_result jsonb;
  v_class_keys text[] := array[]::text[];
  v_is_global boolean := false;
begin
  select * into v_client from public.attendance_admin_clients where client_code=trim(p_client_code) and status='active';
  if not found or encode(digest(p_client_secret,'sha256'),'hex')<>v_client.secret_hash then return jsonb_build_object('ok',false,'code','ADMIN_AUTH_FAILED'); end if;
  if v_client.session_expires_at is not null and v_client.session_expires_at <= now() then return jsonb_build_object('ok',false,'code','ADMIN_SESSION_EXPIRED'); end if;
  v_permissions := public.attendance_admin_effective_permissions(v_client.id);
  v_is_global := '*'=any(v_permissions) or 'settings.manage'=any(v_permissions) or 'reports.read'=any(v_permissions);
  select * into v_config from public.attendance_system_config where singleton=true;
  v_session := coalesce(nullif(p_payload->>'session',''),v_config.operational_session,public.attendance_operational_session());
  v_term := coalesce(nullif(p_payload->>'term',''),v_config.operational_term,public.attendance_operational_term());
  select coalesce(array_agg(distinct a.class_key),array[]::text[]) into v_class_keys
  from public.school_staff_class_allocations a
  where a.allocation_status='active' and (a.person_id=v_client.central_person_id or a.staff_id=v_client.central_person_id)
    and (a.academic_session=v_session or a.academic_session is null)
    and (a.term_name=v_term or a.term_name is null);
  update public.attendance_admin_clients set last_seen_at=now(),updated_at=now() where id=v_client.id;

  if p_action='context' then
    select jsonb_build_object('ok',true,'config',to_jsonb(v_config),'session',v_session,'term',v_term,
      'permissions',to_jsonb(v_permissions),'class_scope',to_jsonb(v_class_keys),
      'classes',coalesce((select jsonb_agg(jsonb_build_object('class_key',s.class_key,'display_name',s.class_key) order by s.class_key) from (select distinct class_key from public.students where archived=false) s),'[]'::jsonb),
      'adapters',jsonb_build_array(
        jsonb_build_object('code','manual','name','Manual Entry','available',true),
        jsonb_build_object('code','qr','name','QR Scanner','available',true),
        jsonb_build_object('code','generic_card','name','Generic Card / UID','available',true),
        jsonb_build_object('code','generic_csv','name','Generic CSV','available',true),
        jsonb_build_object('code','generic_xlsx','name','Generic XLSX','available',true),
        jsonb_build_object('code','generic_text','name','Delimited Text','available',true),
        jsonb_build_object('code','google_sheets','name','Google Sheets (read-only input)','available',true),
        jsonb_build_object('code','wts_live_device','name','WTS Live Device API','available',true)
      )) into v_result;
    return v_result;
  end if;

  if p_action='summary' then
    return public.attendance_dashboard_snapshot(nullif(p_payload->>'date','')::date,v_session)||jsonb_build_object('staff',public.staff_attendance_dashboard_snapshot(nullif(p_payload->>'date','')::date,v_session),'session',v_session,'term',v_term);
  end if;

  if p_action='register' then
    begin v_date:=coalesce(nullif(p_payload->>'date','')::date,current_date); exception when others then return jsonb_build_object('ok',false,'code','INVALID_DATE'); end;
    v_slot:=lower(coalesce(nullif(p_payload->>'sessionSlot',''), 'morning'));
    v_class:=trim(coalesce(p_payload->>'classKey',''));
    if v_slot not in ('morning','afternoon') or v_class='' then return jsonb_build_object('ok',false,'code','REGISTER_SCOPE_REQUIRED'); end if;
    if not v_is_global and not (v_class=any(v_class_keys)) then return jsonb_build_object('ok',false,'code','CLASS_SCOPE_DENIED'); end if;
    select jsonb_build_object('ok',true,'date',v_date,'session_slot',v_slot,'class_key',v_class,'session',v_session,'term',v_term,
      'lock',coalesce((select to_jsonb(l) from public.attendance_register_locks l where l.academic_session=v_session and l.academic_term=v_term and l.attendance_date=v_date and l.class_key=v_class and l.session_slot=v_slot),'{}'::jsonb),
      'students',coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'admno',s.admno,'gender',s.gender,'class_key',s.class_key,'photo',s.photo,'status',coalesce(r.status,'incomplete'),'note',r.note,'record_id',r.id,'locked_at',r.locked_at) order by s.name),'[]'::jsonb))
    into v_result
    from public.students s left join public.attendance_student_session_records r
      on r.student_id=s.id and r.attendance_date=v_date and r.session_slot=v_slot and r.academic_session=v_session and r.academic_term=v_term
    where s.archived=false and s.lifecycle_status='active' and s.class_key=v_class;
    return v_result;
  end if;

  if p_action='staff_logbook' then
    begin v_date:=coalesce(nullif(p_payload->>'date','')::date,current_date); exception when others then return jsonb_build_object('ok',false,'code','INVALID_DATE'); end;
    if not ('staff.read'=any(v_permissions) or v_is_global or 'personal.attendance.read'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    select jsonb_build_object('ok',true,'date',v_date,'session',v_session,'term',v_term,
      'staff',coalesce(jsonb_agg(jsonb_build_object('id',s.id,'full_name',s.full_name,'staff_number',s.staff_number,'designation',s.designation,'department',s.department,'photo',s.photo,'status',coalesce(d.daily_status,'incomplete'),'arrival',d.first_check_in,'departure',d.last_check_out,'late_minutes',coalesce(d.late_minutes,0),'worked_minutes',coalesce(d.worked_minutes,0),'method',coalesce((select e.source from public.staff_attendance_events e where e.staff_id=s.id and e.event_time::date=v_date and e.academic_session=v_session order by e.event_time limit 1),'manual')) order by s.full_name),'[]'::jsonb))
    into v_result
    from public.staff_attendance_profiles s left join public.staff_attendance_daily d on d.staff_id=s.id and d.attendance_date=v_date and d.academic_session=v_session
    where s.employment_status='active' and s.attendance_required=true and (v_is_global or s.central_person_id=v_client.central_person_id or 'staff.read'=any(v_permissions));
    return v_result;
  end if;

  if p_action='credentials' then
    v_person_type:=nullif(p_payload->>'personType','');
    select jsonb_build_object('ok',true,'credentials',coalesce(jsonb_agg(jsonb_build_object(
      'id',i.id,'credential_id',i.source_credential_id,'person_type',i.person_type,'student_id',i.student_id,'staff_id',i.staff_id,
      'credential_type',i.credential_type,'credential_label',i.metadata->>'label','token_last4',i.credential_last4,'external_user_id',i.external_user_id,
      'status',i.status,'issued_at',i.issued_at,'valid_from',i.valid_from,'valid_until',i.valid_until,'last_used_at',i.last_used_at,'device_id',i.device_id
    ) order by i.created_at desc),'[]'::jsonb)) into v_result
    from public.attendance_credential_index i
    where (v_person_type is null or i.person_type=v_person_type)
      and (nullif(p_payload->>'personId','') is null or i.student_id=nullif(p_payload->>'personId','')::uuid or i.staff_id=nullif(p_payload->>'personId','')::uuid);
    return v_result;
  end if;

  if p_action='devices' then
    select jsonb_build_object('ok',true,'devices',coalesce(jsonb_agg(to_jsonb(d) order by d.device_name),'[]'::jsonb)) into v_result from public.attendance_device_status d; return v_result;
  end if;
  if p_action='imports' then
    select jsonb_build_object('ok',true,'batches',coalesce(jsonb_agg(to_jsonb(b) order by b.uploaded_at desc),'[]'::jsonb)) into v_result from (select * from public.attendance_import_batches order by uploaded_at desc limit 100) b; return v_result;
  end if;
  if p_action='import_rows' then
    select jsonb_build_object('ok',true,'rows',coalesce(jsonb_agg(to_jsonb(r) order by r.row_number),'[]'::jsonb)) into v_result from public.attendance_import_rows r where r.batch_id=nullif(p_payload->>'batchId','')::uuid; return v_result;
  end if;
  if p_action='corrections' then
    select jsonb_build_object('ok',true,'register_corrections',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from public.attendance_register_correction_requests c where c.status='pending'),'[]'::jsonb),'daily_corrections',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from public.attendance_correction_requests c where c.status='pending'),'[]'::jsonb)) into v_result; return v_result;
  end if;
  if p_action='report' then
    begin
      v_from:=coalesce(nullif(p_payload->>'from','')::date,current_date);
      v_to:=coalesce(nullif(p_payload->>'to','')::date,v_from);
    exception when others then return jsonb_build_object('ok',false,'code','INVALID_DATE_RANGE'); end;
    if v_to < v_from or v_to-v_from > 366 then return jsonb_build_object('ok',false,'code','INVALID_DATE_RANGE'); end if;
    v_class:=nullif(trim(p_payload->>'classKey'),'');
    with days as (
      select d::date as day from generate_series(v_from,v_to,interval '1 day') d
      where extract(isodow from d) between 1 and 5
        and not exists (select 1 from public.attendance_calendar_days c where c.academic_session=v_session and c.academic_term=v_term and c.calendar_date=d::date and c.day_type in ('holiday','school_closed','cancelled'))
    ), eligible as (
      select s.id,s.name,s.admno,s.class_key,days.day,slot.slot from public.students s cross join days cross join (values('morning'),('afternoon')) slot(slot)
      where s.archived=false and s.lifecycle_status='active' and (v_class is null or s.class_key=v_class)
        and (s.admission_date is null or s.admission_date<=days.day)
    ), rows as (
      select e.id,e.name,e.admno,e.class_key,e.day,e.slot,r.status
      from eligible e left join public.attendance_student_session_records r on r.student_id=e.id and r.attendance_date=e.day and r.session_slot=e.slot and r.academic_session=v_session and r.academic_term=v_term
    )
    select jsonb_build_object('ok',true,'from',v_from,'to',v_to,'session',v_session,'term',v_term,
      'student_rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.class_key,x.name) from (select id as student_id,name,admno,class_key,count(*)::integer as possible_sessions,count(*) filter(where status in ('present','late','official_activity'))::integer as actual_sessions,count(*) filter(where status='late')::integer as late_sessions,count(*) filter(where status='absent')::integer as absent_sessions,count(*) filter(where status is null or status='incomplete')::integer as incomplete_sessions,round((count(*) filter(where status in ('present','late','official_activity'))::numeric/nullif(count(*),0))*100,2) as attendance_percentage from rows group by id,name,admno,class_key) x),'[]'::jsonb),
      'class_rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.class_key) from (select class_key,count(*)::integer as possible_sessions,count(*) filter(where status in ('present','late','official_activity'))::integer as actual_sessions,count(*) filter(where status='late')::integer as late_sessions,count(*) filter(where status='absent')::integer as absent_sessions,count(*) filter(where status is null or status='incomplete')::integer as incomplete_sessions,round((count(*) filter(where status in ('present','late','official_activity'))::numeric/nullif(count(*),0))*100,2) as attendance_percentage from rows group by class_key) x),'[]'::jsonb)) into v_result;
    return v_result;
  end if;
  return jsonb_build_object('ok',false,'code','UNKNOWN_ACTION');
exception when invalid_text_representation or datetime_field_overflow then return jsonb_build_object('ok',false,'code','INVALID_INPUT_FORMAT');
end;
$$;

create or replace function public.attendance_universal_admin_write_api(
  p_client_code text, p_client_secret text, p_action text, p_payload jsonb default '{}'::jsonb
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
  v_id uuid;
  v_student_id uuid;
  v_staff_id uuid;
  v_type text;
  v_raw text;
  v_hash text;
  v_norm text;
  v_card_type text;
  v_label text;
  v_metadata jsonb;
  v_source_id uuid;
  v_result jsonb;
  v_date date;
  v_slot text;
  v_class text;
  v_lock public.attendance_register_locks%rowtype;
  v_row jsonb;
  v_status text;
  v_count integer := 0;
  v_request_id uuid := gen_random_uuid();
  v_batch_id uuid;
  v_checksum text;
  v_raw_identifier text;
  v_event_time timestamptz;
  v_event_type text;
  v_credential public.attendance_credential_index%rowtype;
  v_import_row public.attendance_import_rows%rowtype;
begin
  select * into v_client from public.attendance_admin_clients where client_code=trim(p_client_code) and status='active';
  if not found or encode(digest(p_client_secret,'sha256'),'hex')<>v_client.secret_hash then return jsonb_build_object('ok',false,'code','ADMIN_AUTH_FAILED'); end if;
  if v_client.session_expires_at is not null and v_client.session_expires_at <= now() then return jsonb_build_object('ok',false,'code','ADMIN_SESSION_EXPIRED'); end if;
  v_permissions := public.attendance_admin_effective_permissions(v_client.id);
  select * into v_config from public.attendance_system_config where singleton=true;
  v_session:=coalesce(nullif(p_payload->>'session',''),v_config.operational_session,public.attendance_operational_session());
  v_term:=coalesce(nullif(p_payload->>'term',''),v_config.operational_term,public.attendance_operational_term());

  if p_action='assignCredential' then
    if not ('*'=any(v_permissions) or 'credentials.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_type:=lower(trim(coalesce(p_payload->>'credentialType','generic_card_uid')));
    if v_type not in ('qr_token','nfc_uid','mifare_uid','rfid_uid','generic_card_uid','fingerprint_device_user_id','face_device_user_id','pin','external_device_user_id','barcode','temporary_pass','qr','nfc','rfid','hybrid','virtual') then return jsonb_build_object('ok',false,'code','INVALID_CREDENTIAL_TYPE'); end if;
    v_raw:=trim(coalesce(p_payload->>'rawIdentifier',''));
    if length(v_raw)<1 or length(v_raw)>512 then return jsonb_build_object('ok',false,'code','INVALID_CREDENTIAL'); end if;
    v_norm:=public.attendance_normalize_identifier(v_raw,v_type); v_hash:=encode(digest(v_norm,'sha256'),'hex');
    if exists(select 1 from public.attendance_credential_index where (credential_hash=v_hash or legacy_hash=v_hash) and status in ('active','pending')) then return jsonb_build_object('ok',false,'code','CREDENTIAL_ALREADY_ASSIGNED'); end if;
    begin v_student_id:=nullif(p_payload->>'studentId','')::uuid; v_staff_id:=nullif(p_payload->>'staffId','')::uuid; exception when others then return jsonb_build_object('ok',false,'code','INVALID_PERSON_ID'); end;
    if (v_student_id is null)=(v_staff_id is null) then return jsonb_build_object('ok',false,'code','ONE_PERSON_REQUIRED'); end if;
    if v_student_id is not null and not exists(select 1 from public.students s where s.id=v_student_id and s.archived=false and s.lifecycle_status='active') then return jsonb_build_object('ok',false,'code','STUDENT_NOT_ACTIVE'); end if;
    if v_staff_id is not null and not exists(select 1 from public.staff_attendance_profiles s where s.id=v_staff_id and s.employment_status='active' and s.registration_status='active') then return jsonb_build_object('ok',false,'code','STAFF_NOT_ACTIVE'); end if;
    v_label:=nullif(trim(p_payload->>'label'),'');
    v_metadata:=coalesce(p_payload->'metadata','{}'::jsonb)||jsonb_build_object('credential_type',v_type,'label',coalesce(v_label,''),'external_user_id',nullif(p_payload->>'externalUserId',''),'assigned_by_client_id',v_client.id);
    v_card_type:=case v_type when 'qr_token' then 'qr' when 'nfc_uid' then 'nfc' when 'mifare_uid' then 'mifare' when 'rfid_uid' then 'rfid' when 'generic_card_uid' then 'generic_card' when 'fingerprint_device_user_id' then 'fingerprint_device_user_id' when 'face_device_user_id' then 'face_device_user_id' when 'pin' then 'pin' when 'external_device_user_id' then 'external_device_user_id' when 'barcode' then 'barcode' when 'temporary_pass' then 'temporary_pass' else v_type end;
    if v_student_id is not null then
      insert into public.student_cards(student_id,token_hash,token_last4,card_type,status,credential_label,credential_version,valid_from,valid_until,presentation_modes,metadata)
      values(v_student_id,v_hash,right(v_norm,4),v_card_type,'active',v_label,1,coalesce(nullif(p_payload->>'validFrom','')::timestamptz,now()),nullif(p_payload->>'validUntil','')::timestamptz,array[v_type],v_metadata) returning id into v_source_id;
    else
      insert into public.staff_cards(staff_id,token_hash,token_last4,card_type,status,credential_label,credential_version,valid_from,valid_until,presentation_modes,metadata)
      values(v_staff_id,v_hash,right(v_norm,4),v_card_type,'active',v_label,1,coalesce(nullif(p_payload->>'validFrom','')::timestamptz,now()),nullif(p_payload->>'validUntil','')::timestamptz,array[v_type],v_metadata) returning id into v_source_id;
    end if;
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'credential.assign','attendance_credential',v_source_id::text,v_request_id,jsonb_build_object('person_type',case when v_student_id is not null then 'student' else 'staff' end,'student_id',v_student_id,'staff_id',v_staff_id,'credential_type',v_type,'last4',right(v_norm,4),'device_id',nullif(p_payload->>'deviceId','')));
    return jsonb_build_object('ok',true,'code','CREDENTIAL_ASSIGNED','credential_id',v_source_id,'credential_type',v_type,'token_last4',right(v_norm,4),'request_id',v_request_id);
  end if;

  if p_action in ('suspendCredential','revokeCredential','replaceCredential') then
    if not ('*'=any(v_permissions) or 'credentials.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    begin v_id:=nullif(p_payload->>'credentialId','')::uuid; exception when others then return jsonb_build_object('ok',false,'code','INVALID_CREDENTIAL_ID'); end;
    select * into v_credential from public.attendance_credential_index where id=v_id or source_credential_id=v_id limit 1;
    if not found then return jsonb_build_object('ok',false,'code','CREDENTIAL_NOT_FOUND'); end if;
    v_status:=case p_action when 'suspendCredential' then 'suspended' when 'revokeCredential' then 'revoked' else 'replaced' end;
    if v_credential.person_type='student' then update public.student_cards set status=v_status,disabled_at=now(),disabled_reason=coalesce(nullif(p_payload->>'reason',''),p_action),updated_at=now() where id=v_credential.source_credential_id; else update public.staff_cards set status=v_status,disabled_at=now(),disabled_reason=coalesce(nullif(p_payload->>'reason',''),p_action),updated_at=now() where id=v_credential.source_credential_id; end if;
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'credential.'||replace(p_action,'Credential',''), 'attendance_credential',v_credential.id::text,v_request_id,jsonb_build_object('reason',p_payload->>'reason','status',v_status));
    return jsonb_build_object('ok',true,'code','CREDENTIAL_STATUS_UPDATED','credential_id',v_credential.id,'status',v_status,'request_id',v_request_id);
  end if;

  if p_action='saveRegister' then
    if not ('*'=any(v_permissions) or 'class.attendance.write'=any(v_permissions) or 'manual_entries.create'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    begin v_date:=nullif(p_payload->>'date','')::date; exception when others then return jsonb_build_object('ok',false,'code','INVALID_DATE'); end;
    v_slot:=lower(trim(coalesce(p_payload->>'sessionSlot',''))); v_class:=trim(coalesce(p_payload->>'classKey',''));
    if v_date is null or v_slot not in ('morning','afternoon') or v_class='' then return jsonb_build_object('ok',false,'code','REGISTER_SCOPE_REQUIRED'); end if;
    if not ('*'=any(v_permissions) or 'settings.manage'=any(v_permissions) or 'reports.read'=any(v_permissions)) and not exists(select 1 from public.school_staff_class_allocations a where a.class_key=v_class and a.allocation_status='active' and (a.person_id=v_client.central_person_id or a.staff_id=v_client.central_person_id) and (a.academic_session=v_session or a.academic_session is null) and (a.term_name=v_term or a.term_name is null)) then return jsonb_build_object('ok',false,'code','CLASS_SCOPE_DENIED'); end if;
    select * into v_lock from public.attendance_register_locks where academic_session=v_session and academic_term=v_term and attendance_date=v_date and class_key=v_class and session_slot=v_slot;
    if found and v_lock.status in ('closed','archived') and not ('*'=any(v_permissions) or 'settings.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','REGISTER_LOCKED'); end if;
    for v_row in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb)) loop
      begin v_student_id:=nullif(v_row->>'studentId','')::uuid; exception when others then continue; end;
      v_status:=lower(trim(coalesce(v_row->>'status','incomplete')));
      if v_student_id is null or v_status not in ('present','absent','late','excused','official_activity','sick_leave','early_departure','half_day','school_activity','not_expected','school_closed','incomplete') then continue; end if;
      if not exists(select 1 from public.students s where s.id=v_student_id and s.archived=false and s.lifecycle_status='active' and s.class_key=v_class) then continue; end if;
      insert into public.attendance_student_session_records(student_id,attendance_date,session_slot,status,source,academic_session,academic_term,class_key_snapshot,note)
      values(v_student_id,v_date,v_slot,v_status,'manual',v_session,v_term,v_class,nullif(v_row->>'note',''))
      on conflict(student_id,attendance_date,session_slot,academic_session,academic_term) do update set status=excluded.status,source='manual',note=excluded.note,updated_at=now();
      v_count:=v_count+1;
    end loop;
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'register.save','attendance_student_register',v_class||':'||v_date||':'||v_slot,v_request_id,jsonb_build_object('session',v_session,'term',v_term,'updated_count',v_count));
    return jsonb_build_object('ok',true,'code','REGISTER_SAVED','updated_count',v_count,'request_id',v_request_id);
  end if;

  if p_action='confirmRegister' then
    if not ('*'=any(v_permissions) or 'attendance.register.confirm'=any(v_permissions) or 'manual_entries.review'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_date:=nullif(p_payload->>'date','')::date; v_slot:=lower(trim(p_payload->>'sessionSlot')); v_class:=trim(p_payload->>'classKey');
    if not ('*'=any(v_permissions) or 'settings.manage'=any(v_permissions) or 'reports.read'=any(v_permissions)) and not exists(select 1 from public.school_staff_class_allocations a where a.class_key=v_class and a.allocation_status='active' and (a.person_id=v_client.central_person_id or a.staff_id=v_client.central_person_id)) then return jsonb_build_object('ok',false,'code','CLASS_SCOPE_DENIED'); end if;
    insert into public.attendance_student_session_records(student_id,attendance_date,session_slot,status,source,academic_session,academic_term,class_key_snapshot,note)
    select s.id,v_date,v_slot,'incomplete','manual',v_session,v_term,s.class_key,null from public.students s where s.archived=false and s.lifecycle_status='active' and s.class_key=v_class
    on conflict(student_id,attendance_date,session_slot,academic_session,academic_term) do nothing;
    if exists(select 1 from public.attendance_student_session_records r join public.students s on s.id=r.student_id where r.attendance_date=v_date and r.session_slot=v_slot and r.academic_session=v_session and r.academic_term=v_term and s.class_key=v_class and r.status='incomplete') then return jsonb_build_object('ok',false,'code','REGISTER_INCOMPLETE'); end if;
    insert into public.attendance_register_locks(academic_session,academic_term,attendance_date,class_key,session_slot,status,confirmed_by_admin_client_id,confirmed_at)
    values(v_session,v_term,v_date,v_class,v_slot,'confirmed',v_client.id,now())
    on conflict(academic_session,academic_term,attendance_date,class_key,session_slot) do update set status='confirmed',confirmed_by_admin_client_id=v_client.id,confirmed_at=now(),updated_at=now();
    update public.attendance_student_session_records set confirmed_by_admin_client_id=v_client.id,confirmed_at=now(),locked_at=now() where attendance_date=v_date and session_slot=v_slot and academic_session=v_session and academic_term=v_term and class_key_snapshot=v_class;
    perform public.attendance_emit_outbox_event('class_register_confirmed','class_register',v_class||':'||v_date||':'||v_slot,jsonb_build_object('class_key',v_class,'attendance_date',v_date,'session_slot',v_slot,'session',v_session,'term',v_term));
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'register.confirm','attendance_register_lock',v_class||':'||v_date||':'||v_slot,v_request_id,jsonb_build_object('session',v_session,'term',v_term));
    return jsonb_build_object('ok',true,'code','REGISTER_CONFIRMED','request_id',v_request_id);
  end if;

  if p_action='reopenRegister' then
    if not ('*'=any(v_permissions) or 'settings.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_date:=nullif(p_payload->>'date','')::date; v_slot:=lower(trim(p_payload->>'sessionSlot')); v_class:=trim(p_payload->>'classKey');
    if trim(coalesce(p_payload->>'reason',''))='' then return jsonb_build_object('ok',false,'code','REOPEN_REASON_REQUIRED'); end if;
    update public.attendance_register_locks set status='reopened',reopened_by_admin_client_id=v_client.id,reopened_at=now(),reopen_reason=trim(p_payload->>'reason'),updated_at=now() where academic_session=v_session and academic_term=v_term and attendance_date=v_date and class_key=v_class and session_slot=v_slot;
    update public.attendance_student_session_records set locked_at=null where attendance_date=v_date and session_slot=v_slot and academic_session=v_session and academic_term=v_term and class_key_snapshot=v_class;
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'register.reopen','attendance_register_lock',v_class||':'||v_date||':'||v_slot,v_request_id,jsonb_build_object('reason',p_payload->>'reason'));
    return jsonb_build_object('ok',true,'code','REGISTER_REOPENED','request_id',v_request_id);
  end if;

  if p_action='previewImport' then
    if not ('*'=any(v_permissions) or 'imports.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_checksum:=nullif(trim(p_payload->>'checksumSha256'),'');
    select id into v_batch_id from public.attendance_import_batches where device_id=nullif(p_payload->>'deviceId','')::uuid and checksum_sha256=v_checksum limit 1;
    if v_batch_id is not null then return jsonb_build_object('ok',false,'code','IMPORT_ALREADY_UPLOADED','batch_id',v_batch_id); end if;
    insert into public.attendance_import_batches(device_id,source_type,file_name,checksum_sha256,adapter_code,uploaded_by_admin_client_id,original_row_count,status,metadata)
    values(nullif(p_payload->>'deviceId','')::uuid,coalesce(nullif(p_payload->>'sourceType',''),'vendor_export'),nullif(p_payload->>'fileName',''),v_checksum,coalesce(nullif(p_payload->>'adapterCode',''),'generic_delimited'),v_client.id,jsonb_array_length(coalesce(p_payload->'rows','[]'::jsonb)),'previewed',coalesce(p_payload->'metadata','{}'::jsonb)) returning id into v_batch_id;
    for v_row in select value from jsonb_array_elements(coalesce(p_payload->'rows','[]'::jsonb)) loop
      v_raw_identifier:=nullif(trim(coalesce(v_row->>'rawIdentifier',v_row->>'identifier',v_row->>'cardNumber',v_row->>'userId','')),'');
      v_type:=lower(coalesce(nullif(v_row->>'credentialType',''),nullif(v_row->>'credentialMethod',''),'generic_card_uid'));
      v_norm:=public.attendance_normalize_identifier(v_raw_identifier,v_type); v_hash:=case when v_norm='' then null else encode(digest(v_norm,'sha256'),'hex') end;
      v_event_type:=case when upper(coalesce(v_row->>'direction',''))='OUT' or lower(coalesce(v_row->>'eventType',''))='check_out' then 'check_out' else 'check_in' end;
      begin v_event_time:=nullif(coalesce(v_row->>'eventTime',v_row->>'timestamp',v_row->>'dateTime'),'')::timestamptz; exception when others then v_event_time:=null; end;
      v_credential := null;
      select * into v_credential from public.attendance_credential_index i where (i.credential_hash=v_hash or i.legacy_hash=v_hash) and i.status='active' limit 1;
      insert into public.attendance_import_rows(batch_id,row_number,raw_record,raw_identifier,normalized_identifier,credential_hash,external_user_id,event_time,source_time_zone,direction,event_type,credential_method,source_event_id,resolved_person_type,resolved_student_id,resolved_staff_id,validation_status,validation_code,validation_reason)
      values(v_batch_id,coalesce(nullif(v_row->>'rowNumber','')::integer,(select count(*)+1 from public.attendance_import_rows where batch_id=v_batch_id)),v_row,v_raw_identifier,v_norm,v_hash,nullif(v_row->>'externalUserId',''),v_event_time,nullif(v_row->>'sourceTimeZone',''),upper(coalesce(nullif(v_row->>'direction',''),'UNSPECIFIED')),v_event_type,v_type,nullif(v_row->>'sourceEventId',''),v_credential.person_type,v_credential.student_id,v_credential.staff_id,
        case when v_event_time is null then 'invalid_date_time' when v_credential.id is null then 'unknown_identity' when exists(select 1 from public.attendance_raw_events r where r.deduplication_key=coalesce(nullif(v_row->>'sourceEventId',''),md5(coalesce(v_hash,'')||'|'||v_event_time::text||'|'||coalesce(p_payload->>'deviceId','')))) then 'duplicate' else 'ready' end,
        case when v_event_time is null then 'INVALID_DATE_TIME' when v_credential.id is null then 'UNKNOWN_IDENTITY' else null end,
        case when v_event_time is null then 'Timestamp could not be parsed.' when v_credential.id is null then 'No active Attendance credential is mapped to this identifier.' else null end);
    end loop;
    update public.attendance_import_batches set accepted_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status='ready'),duplicate_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status='duplicate'),rejected_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status in ('invalid_date_time','invalid_credential','rejected')),unresolved_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status='unknown_identity'),updated_at=now() where id=v_batch_id;
    select jsonb_build_object('ok',true,'code','IMPORT_PREVIEW_READY','batch_id',v_batch_id,'summary',to_jsonb(b),'rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.row_number) from public.attendance_import_rows r where r.batch_id=v_batch_id),'[]'::jsonb)) into v_result from public.attendance_import_batches b where b.id=v_batch_id; return v_result;
  end if;

  if p_action='mapImportRow' then
    if not ('*'=any(v_permissions) or 'imports.manage'=any(v_permissions) or 'credentials.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_id:=nullif(p_payload->>'rowId','')::uuid;
    select * into v_import_row from public.attendance_import_rows where id=v_id;
    if not found then return jsonb_build_object('ok',false,'code','IMPORT_ROW_NOT_FOUND'); end if;
    v_result:=public.attendance_universal_admin_write_api(p_client_code,p_client_secret,'assignCredential',jsonb_build_object('studentId',p_payload->>'studentId','staffId',p_payload->>'staffId','credentialType',coalesce(p_payload->>'credentialType','external_device_user_id'),'rawIdentifier',coalesce(p_payload->>'rawIdentifier',v_import_row.raw_identifier),'externalUserId',coalesce(p_payload->>'externalUserId',v_import_row.external_user_id),'label',coalesce(p_payload->>'label','Imported device credential'),'deviceId',p_payload->>'deviceId'));
    if coalesce((v_result->>'ok')::boolean,false)=false then return v_result; end if;
    v_hash:=public.attendance_hash_identifier(coalesce(p_payload->>'rawIdentifier',v_import_row.raw_identifier),coalesce(p_payload->>'credentialType','external_device_user_id'));
    select * into v_credential from public.attendance_credential_index where credential_hash=v_hash and status='active' limit 1;
    update public.attendance_import_rows set credential_hash=v_hash,normalized_identifier=public.attendance_normalize_identifier(coalesce(p_payload->>'rawIdentifier',v_import_row.raw_identifier),coalesce(p_payload->>'credentialType','external_device_user_id')),resolved_person_type=v_credential.person_type,resolved_student_id=v_credential.student_id,resolved_staff_id=v_credential.staff_id,validation_status=case when event_time is null then 'invalid_date_time' else 'ready' end,validation_code=case when event_time is null then 'INVALID_DATE_TIME' end,validation_reason=case when event_time is null then 'Timestamp could not be parsed.' end,updated_at=now() where id=v_id;
    return jsonb_build_object('ok',true,'code','IMPORT_ROW_MAPPED','row_id',v_id,'credential_id',v_credential.id);
  end if;

  if p_action='confirmImport' then
    if not ('*'=any(v_permissions) or 'imports.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_batch_id:=nullif(p_payload->>'batchId','')::uuid;
    for v_import_row in select * from public.attendance_import_rows where batch_id=v_batch_id and validation_status='ready' order by row_number loop
      v_result:=public.attendance_universal_intake(v_import_row.credential_hash,(select device_id from public.attendance_import_batches where id=v_batch_id),gen_random_uuid(),coalesce(v_import_row.event_type,'check_in'), 'import',v_import_row.event_time,nullif(v_import_row.raw_record->>'localRecordedAt',''),v_import_row.source_event_id,v_batch_id,'Imported device attendance',jsonb_build_object('credential_method',v_import_row.credential_method,'source_time_zone',v_import_row.source_time_zone,'raw_source_reference',v_import_row.row_number,'academic_session',v_session,'academic_term',v_term,'adapter_code',(select adapter_code from public.attendance_import_batches where id=v_batch_id)),v_client.id);
      if (v_result->>'ok')::boolean then update public.attendance_import_rows set validation_status=case when v_result->>'code'='DUPLICATE_IGNORED' then 'duplicate' else 'processed' end,created_event_id=nullif(v_result->>'event_id','')::uuid,updated_at=now() where id=v_import_row.id; else update public.attendance_import_rows set validation_status='rejected',validation_code=v_result->>'code',validation_reason=v_result->>'detail',updated_at=now() where id=v_import_row.id; end if;
    end loop;
    update public.attendance_import_batches set status=case when exists(select 1 from public.attendance_import_rows where batch_id=v_batch_id and validation_status in ('rejected','unknown_identity','invalid_date_time')) then 'completed_with_errors' else 'completed' end,accepted_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status='processed'),duplicate_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status='duplicate'),rejected_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status in ('rejected','invalid_date_time')),unresolved_count=(select count(*) from public.attendance_import_rows where batch_id=v_batch_id and validation_status='unknown_identity'),completed_at=now(),updated_at=now() where id=v_batch_id;
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'import.confirm','attendance_import_batch',v_batch_id::text,v_request_id,jsonb_build_object('batch_id',v_batch_id));
    return jsonb_build_object('ok',true,'code','IMPORT_COMPLETED','batch_id',v_batch_id,'request_id',v_request_id);
  end if;

  if p_action='createRegisterCorrection' then
    if not ('*'=any(v_permissions) or 'corrections.create'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_id:=nullif(p_payload->>'recordId','')::uuid; v_status:=lower(trim(p_payload->>'requestedStatus'));
    if v_id is null or v_status='' or trim(coalesce(p_payload->>'reason',''))='' then return jsonb_build_object('ok',false,'code','CORRECTION_DATA_REQUIRED'); end if;
    if p_payload->>'personType'='staff' then insert into public.attendance_register_correction_requests(person_type,staff_session_id,requested_status,requested_note,reason,evidence_note,requested_by_admin_client_id) values('staff',v_id,v_status,nullif(p_payload->>'requestedNote',''),trim(p_payload->>'reason'),nullif(p_payload->>'evidenceNote',''),v_client.id) returning id into v_id; else insert into public.attendance_register_correction_requests(person_type,student_session_id,requested_status,requested_note,reason,evidence_note,requested_by_admin_client_id) values('student',v_id,v_status,nullif(p_payload->>'requestedNote',''),trim(p_payload->>'reason'),nullif(p_payload->>'evidenceNote',''),v_client.id) returning id into v_id; end if;
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'register_correction.create','attendance_register_correction_request',v_id::text,v_request_id,p_payload); return jsonb_build_object('ok',true,'code','CORRECTION_REQUEST_CREATED','correction_id',v_id,'request_id',v_request_id);
  end if;

  if p_action in ('approveRegisterCorrection','rejectRegisterCorrection') then
    if not ('*'=any(v_permissions) or 'corrections.review'=any(v_permissions) or 'settings.manage'=any(v_permissions)) then return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED'); end if;
    v_id:=nullif(p_payload->>'correctionId','')::uuid;
    update public.attendance_register_correction_requests set status=case when p_action='approveRegisterCorrection' then 'approved' else 'rejected' end,reviewed_by_admin_client_id=v_client.id,reviewed_at=now(),review_note=nullif(p_payload->>'reviewNote',''),updated_at=now() where id=v_id and status='pending';
    if not found then return jsonb_build_object('ok',false,'code','CORRECTION_NOT_PENDING'); end if;
    if p_action='approveRegisterCorrection' then
      update public.attendance_student_session_records r set status=c.requested_status,note=coalesce(c.requested_note,r.note),source='correction',updated_at=now() from public.attendance_register_correction_requests c where c.id=v_id and c.student_session_id=r.id;
      update public.attendance_staff_session_records r set status=c.requested_status,note=coalesce(c.requested_note,r.note),source='correction',updated_at=now() from public.attendance_register_correction_requests c where c.id=v_id and c.staff_session_id=r.id;
      update public.attendance_register_correction_requests set applied_at=now() where id=v_id;
    end if;
    perform public.attendance_emit_outbox_event('attendance_correction_decided','attendance_register_correction_request',v_id::text,jsonb_build_object('status',case when p_action='approveRegisterCorrection' then 'approved' else 'rejected' end));
    insert into public.attendance_admin_audit(admin_client_id,action,entity_type,entity_id,request_id,details) values(v_client.id,'register_correction.review','attendance_register_correction_request',v_id::text,v_request_id,p_payload); return jsonb_build_object('ok',true,'code','CORRECTION_DECIDED','correction_id',v_id,'request_id',v_request_id);
  end if;
  return jsonb_build_object('ok',false,'code','UNKNOWN_ACTION');
exception when unique_violation then return jsonb_build_object('ok',false,'code','DUPLICATE_RECORD'); when invalid_text_representation or datetime_field_overflow then return jsonb_build_object('ok',false,'code','INVALID_INPUT_FORMAT'); when others then return jsonb_build_object('ok',false,'code','ATTENDANCE_WRITE_FAILED','detail',left(sqlerrm,180));
end;
$$;

-- Protected, read-only contract for Workspace. Workspace should call this from
-- its server boundary with its existing authenticated Central Registry person.
create or replace function public.attendance_workspace_read_api(p_central_person_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_staff public.staff_attendance_profiles%rowtype;
  v_date date:=current_date;
  v_session text:=public.attendance_operational_session();
begin
  select * into v_staff from public.staff_attendance_profiles where central_person_id=p_central_person_id and employment_status='active' limit 1;
  if not found then return jsonb_build_object('ok',false,'code','STAFF_NOT_FOUND'); end if;
  return jsonb_build_object('ok',true,'person',jsonb_build_object('id',v_staff.id,'staff_number',v_staff.staff_number,'full_name',v_staff.full_name),'today',coalesce((select to_jsonb(d) from public.staff_attendance_daily d where d.staff_id=v_staff.id and d.attendance_date=v_date and d.academic_session=v_session),'{}'::jsonb),'weekly',coalesce((select jsonb_agg(to_jsonb(d) order by d.attendance_date) from public.staff_attendance_daily d where d.staff_id=v_staff.id and d.academic_session=v_session and d.attendance_date>=date_trunc('week',v_date)::date and d.attendance_date<date_trunc('week',v_date)::date+7),'[]'::jsonb),'classes',coalesce((select jsonb_agg(distinct a.class_key order by a.class_key) from public.school_staff_class_allocations a where a.allocation_status='active' and (a.person_id=p_central_person_id or a.staff_id=p_central_person_id) and a.academic_session=v_session),'[]'::jsonb),'unresolved_issue_count',(select count(*) from public.attendance_register_correction_requests c where c.status='pending' and (c.requested_by_admin_client_id is not null)));
end;
$$;

revoke all on table public.attendance_credential_index,public.attendance_import_batches,public.attendance_import_rows,public.attendance_raw_events,public.attendance_student_session_records,public.attendance_staff_session_records,public.attendance_register_locks,public.attendance_register_correction_requests,public.attendance_outbox_events from anon,authenticated;
revoke all on function public.attendance_universal_intake(text,uuid,uuid,text,text,timestamptz,timestamptz,text,uuid,text,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.attendance_emit_outbox_event(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.attendance_workspace_read_api(uuid) from public,anon,authenticated;
revoke all on function public.attendance_universal_admin_read_api(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.attendance_universal_admin_write_api(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.attendance_universal_intake(text,uuid,uuid,text,text,timestamptz,timestamptz,text,uuid,text,jsonb,uuid) to service_role;
grant execute on function public.attendance_workspace_read_api(uuid) to service_role;
grant execute on function public.attendance_universal_admin_read_api(text,text,text,jsonb) to anon,authenticated;
grant execute on function public.attendance_universal_admin_write_api(text,text,text,jsonb) to anon,authenticated;
