-- QR replacement must derive the person from the selected credential.
-- This keeps the replace action safe and makes the API contract credential-id based.
create or replace function public.attendance_qr_card_api(
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
  v_student_id uuid;
  v_staff_id uuid;
  v_person_type text;
  v_card_id uuid;
  v_old_card_id uuid;
  v_new_card_id uuid;
  v_secret_id uuid;
  v_raw_secret text;
  v_vault_secret text;
  v_label text;
  v_reason text;
  v_result jsonb;
  v_credential public.attendance_credential_index%rowtype;
  v_student_card public.student_cards%rowtype;
  v_staff_card public.staff_cards%rowtype;
  v_old_student_card public.student_cards%rowtype;
  v_old_staff_card public.staff_cards%rowtype;
  v_has_current boolean := false;
  v_old_version integer := 1;
  v_new_version integer := 1;
  v_request_id uuid := gen_random_uuid();
begin
  if p_action not in ('issueQr','replaceQr') then
    return jsonb_build_object('ok',false,'code','QR_ACTION_NOT_ALLOWED');
  end if;

  select *
    into v_client
  from public.attendance_admin_clients
  where client_code = trim(coalesce(p_client_code,''))
    and status = 'active';

  if not found
     or p_client_secret is null
     or encode(digest(p_client_secret,'sha256'),'hex') <> coalesce(v_client.secret_hash,'') then
    return jsonb_build_object('ok',false,'code','ADMIN_AUTH_FAILED');
  end if;

  if v_client.session_expires_at is not null
     and v_client.session_expires_at <= now() then
    return jsonb_build_object('ok',false,'code','ADMIN_SESSION_EXPIRED');
  end if;

  v_permissions := public.attendance_admin_effective_permissions(v_client.id);
  if not (
    '*' = any(coalesce(v_permissions,array[]::text[]))
    or 'credentials.manage' = any(coalesce(v_permissions,array[]::text[]))
  ) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  end if;

  if p_action = 'issueQr' then
    begin
      v_student_id := nullif(coalesce(p_payload,'{}'::jsonb)->>'studentId','')::uuid;
      v_staff_id := nullif(coalesce(p_payload,'{}'::jsonb)->>'staffId','')::uuid;
    exception when others then
      return jsonb_build_object('ok',false,'code','INVALID_PERSON_ID');
    end;

    if (v_student_id is null) = (v_staff_id is null) then
      return jsonb_build_object('ok',false,'code','ONE_PERSON_REQUIRED');
    end if;

    if v_student_id is not null then
      if not exists (
        select 1
        from public.students s
        where s.id = v_student_id
          and s.archived = false
          and s.lifecycle_status = 'active'
      ) then
        return jsonb_build_object('ok',false,'code','STUDENT_NOT_ACTIVE');
      end if;
      v_person_type := 'student';
    else
      if not exists (
        select 1
        from public.staff_attendance_profiles s
        where s.id = v_staff_id
          and s.employment_status = 'active'
          and s.registration_status = 'active'
      ) then
        return jsonb_build_object('ok',false,'code','STAFF_NOT_ACTIVE');
      end if;
      v_person_type := 'staff';
    end if;

    if v_student_id is not null then
      select *
        into v_student_card
      from public.student_cards c
      where c.student_id = v_student_id
        and c.card_type = 'qr'
        and c.status in ('active','pending')
      order by case when c.status = 'active' then 0 else 1 end, c.issued_at desc
      limit 1;
      v_has_current := found;
      if v_has_current then
        v_card_id := v_student_card.id;
        v_secret_id := v_student_card.qr_secret_id;
      end if;
    else
      select *
        into v_staff_card
      from public.staff_cards c
      where c.staff_id = v_staff_id
        and c.card_type = 'qr'
        and c.status in ('active','pending')
      order by case when c.status = 'active' then 0 else 1 end, c.issued_at desc
      limit 1;
      v_has_current := found;
      if v_has_current then
        v_card_id := v_staff_card.id;
        v_secret_id := v_staff_card.qr_secret_id;
      end if;
    end if;

    if v_has_current then
      if v_secret_id is null then
        return jsonb_build_object(
          'ok',false,
          'code','QR_REPRINT_UNAVAILABLE',
          'credential_id',v_card_id,
          'message','This older QR card was created before reprint-safe storage. Replace it once to create a permanent reprintable card.'
        );
      end if;

      select d.decrypted_secret
        into v_raw_secret
      from vault.decrypted_secrets d
      where d.id = v_secret_id;

      if coalesce(v_raw_secret,'') = '' then
        return jsonb_build_object(
          'ok',false,
          'code','QR_REPRINT_UNAVAILABLE',
          'credential_id',v_card_id,
          'message','The secure QR value is unavailable. Replace this card once to create a reprintable card.'
        );
      end if;

      return jsonb_build_object(
        'ok',true,
        'code','QR_CREDENTIAL_READY',
        'credential',jsonb_build_object(
          'id',v_card_id,
          'credential_type','qr_token',
          'token_last4',case when v_student_id is not null then v_student_card.token_last4 else v_staff_card.token_last4 end,
          'raw_token',v_raw_secret,
          'existing',true
        )
      );
    end if;

    v_raw_secret := 'WTSQR1-' || encode(gen_random_bytes(24),'hex');
    v_label := coalesce(
      nullif(trim(coalesce(p_payload,'{}'::jsonb)->>'label'),''),
      'WTS permanent QR ID card'
    );

    v_result := public.attendance_universal_admin_write_api_core_v1(
      p_client_code,
      p_client_secret,
      'assignCredential',
      jsonb_build_object(
        'studentId',v_student_id,
        'staffId',v_staff_id,
        'credentialType','qr_token',
        'rawIdentifier',v_raw_secret,
        'label',v_label,
        'metadata',coalesce(p_payload->'metadata','{}'::jsonb)
          || jsonb_build_object('issued_as','permanent_qr_card','permanent_qr',true)
      )
    );

    if coalesce((v_result->>'ok')::boolean,false) = false then
      return v_result;
    end if;

    v_card_id := nullif(v_result->>'credential_id','')::uuid;
    if v_card_id is null then
      raise exception 'QR card was created without a source credential id';
    end if;

    select vault.create_secret(
      v_raw_secret,
      null,
      'WTS attendance QR card ' || v_card_id::text,
      null
    )
      into v_secret_id;

    if v_secret_id is null then
      raise exception 'Vault did not return a QR secret id';
    end if;

    if v_student_id is not null then
      update public.student_cards
      set qr_secret_id = v_secret_id,
          metadata = coalesce(metadata,'{}'::jsonb)
            || jsonb_build_object('permanent_qr',true,'qr_storage','vault'),
          updated_at = now()
      where id = v_card_id;
      if not found then
        raise exception 'Student QR card could not be linked to Vault';
      end if;
    else
      update public.staff_cards
      set qr_secret_id = v_secret_id,
          metadata = coalesce(metadata,'{}'::jsonb)
            || jsonb_build_object('permanent_qr',true,'qr_storage','vault'),
          updated_at = now()
      where id = v_card_id;
      if not found then
        raise exception 'Staff QR card could not be linked to Vault';
      end if;
    end if;

    return v_result || jsonb_build_object(
      'code','QR_CREDENTIAL_CREATED',
      'credential',jsonb_build_object(
        'id',v_card_id,
        'credential_type','qr_token',
        'token_last4',v_result->>'token_last4',
        'raw_token',v_raw_secret,
        'existing',false
      )
    );
  end if;

  begin
    v_card_id := nullif(coalesce(p_payload,'{}'::jsonb)->>'credentialId','')::uuid;
  exception when others then
    return jsonb_build_object('ok',false,'code','INVALID_CREDENTIAL_ID');
  end;

  select *
    into v_credential
  from public.attendance_credential_index i
  where (i.id = v_card_id or i.source_credential_id = v_card_id)
    and i.credential_type in ('qr_token','qr')
  order by case when i.status = 'active' then 0 else 1 end, i.updated_at desc
  limit 1;

  if not found then
    return jsonb_build_object('ok',false,'code','QR_CREDENTIAL_NOT_FOUND');
  end if;

  if v_credential.person_type = 'student' then
    v_student_id := v_credential.student_id;
    v_staff_id := null;
    if v_student_id is null or not exists (
      select 1
      from public.students s
      where s.id = v_student_id
        and s.archived = false
        and s.lifecycle_status = 'active'
    ) then
      return jsonb_build_object('ok',false,'code','STUDENT_NOT_ACTIVE');
    end if;
    v_person_type := 'student';
  elsif v_credential.person_type = 'staff' then
    v_staff_id := v_credential.staff_id;
    v_student_id := null;
    if v_staff_id is null or not exists (
      select 1
      from public.staff_attendance_profiles s
      where s.id = v_staff_id
        and s.employment_status = 'active'
        and s.registration_status = 'active'
    ) then
      return jsonb_build_object('ok',false,'code','STAFF_NOT_ACTIVE');
    end if;
    v_person_type := 'staff';
  else
    return jsonb_build_object('ok',false,'code','ONE_PERSON_REQUIRED');
  end if;

  if v_credential.status in ('replaced','expired') then
    return jsonb_build_object('ok',false,'code','QR_CREDENTIAL_NOT_REPLACEABLE');
  end if;

  v_old_card_id := v_credential.source_credential_id;
  v_reason := coalesce(
    nullif(trim(coalesce(p_payload,'{}'::jsonb)->>'reason'),''),
    'QR card replacement requested'
  );
  v_label := coalesce(
    nullif(trim(coalesce(p_payload,'{}'::jsonb)->>'label'),''),
    'WTS permanent QR ID card'
  );

  begin
  if v_person_type = 'student' then
    select *
      into v_old_student_card
    from public.student_cards
    where id = v_old_card_id
    for update;

    if not found or v_old_student_card.status in ('replaced','expired') then
      return jsonb_build_object('ok',false,'code','QR_CREDENTIAL_NOT_REPLACEABLE');
    end if;

    v_old_version := greatest(coalesce(v_old_student_card.credential_version,1),1);

    update public.student_cards
    set status = 'replaced',
        disabled_at = now(),
        disabled_reason = v_reason,
        updated_at = now()
    where id = v_old_card_id;
  else
    select *
      into v_old_staff_card
    from public.staff_cards
    where id = v_old_card_id
    for update;

    if not found or v_old_staff_card.status in ('replaced','expired') then
      return jsonb_build_object('ok',false,'code','QR_CREDENTIAL_NOT_REPLACEABLE');
    end if;

    v_old_version := greatest(coalesce(v_old_staff_card.credential_version,1),1);

    update public.staff_cards
    set status = 'replaced',
        disabled_at = now(),
        disabled_reason = v_reason,
        updated_at = now()
    where id = v_old_card_id;
  end if;

  v_raw_secret := 'WTSQR1-' || encode(gen_random_bytes(24),'hex');
  v_result := public.attendance_universal_admin_write_api_core_v1(
    p_client_code,
    p_client_secret,
    'assignCredential',
    jsonb_build_object(
      'studentId',v_student_id,
      'staffId',v_staff_id,
      'credentialType','qr_token',
      'rawIdentifier',v_raw_secret,
      'label',v_label,
      'metadata',coalesce(p_payload->'metadata','{}'::jsonb)
        || jsonb_build_object(
          'issued_as','permanent_qr_card',
          'permanent_qr',true,
          'replacement_of',v_old_card_id::text
        )
    )
  );

  if coalesce((v_result->>'ok')::boolean,false) = false then
    raise exception using message = 'QR replacement assignment failed';
  end if;

  v_new_card_id := nullif(v_result->>'credential_id','')::uuid;
  if v_new_card_id is null then
    raise exception 'Replacement QR card was created without a source credential id';
  end if;

  select vault.create_secret(
    v_raw_secret,
    null,
    'WTS attendance QR replacement ' || v_new_card_id::text,
    null
  )
    into v_secret_id;

  if v_secret_id is null then
    raise exception 'Vault did not return a replacement QR secret id';
  end if;

  v_new_version := v_old_version + 1;

  if v_person_type = 'student' then
    update public.student_cards
    set qr_secret_id = v_secret_id,
        credential_version = v_new_version,
        metadata = coalesce(metadata,'{}'::jsonb)
          || jsonb_build_object(
            'permanent_qr',true,
            'qr_storage','vault',
            'replacement_of',v_old_card_id::text
          ),
        updated_at = now()
    where id = v_new_card_id;
    if not found then
      raise exception 'Replacement student QR card could not be linked to Vault';
    end if;

    update public.student_cards
    set replaced_by_card_id = v_new_card_id,
        updated_at = now()
    where id = v_old_card_id;
  else
    update public.staff_cards
    set qr_secret_id = v_secret_id,
        credential_version = v_new_version,
        metadata = coalesce(metadata,'{}'::jsonb)
          || jsonb_build_object(
            'permanent_qr',true,
            'qr_storage','vault',
            'replacement_of',v_old_card_id::text
          ),
        updated_at = now()
    where id = v_new_card_id;
    if not found then
      raise exception 'Replacement staff QR card could not be linked to Vault';
    end if;

    update public.staff_cards
    set replaced_by_card_id = v_new_card_id,
        updated_at = now()
    where id = v_old_card_id;
  end if;

  insert into public.attendance_admin_audit(
    admin_client_id,action,entity_type,entity_id,request_id,details
  )
  values (
    v_client.id,
    'credential.replace_qr',
    'attendance_credential',
    v_old_card_id::text,
    v_request_id,
    jsonb_build_object(
      'old_card_id',v_old_card_id,
      'new_card_id',v_new_card_id,
      'person_type',v_person_type,
      'reason',v_reason,
      'credential_version',v_new_version
    )
  );

  return jsonb_build_object(
    'ok',true,
    'code','QR_CREDENTIAL_REPLACED',
    'old_credential_id',v_old_card_id,
    'credential',jsonb_build_object(
      'id',v_new_card_id,
      'credential_type','qr_token',
      'token_last4',v_result->>'token_last4',
      'raw_token',v_raw_secret,
      'existing',false,
      'replaced',true,
      'credential_version',v_new_version
    )
  );
  exception when others then
    return jsonb_build_object('ok',false,'code','QR_REPLACEMENT_FAILED','message','QR card replacement could not be completed. No card was changed.');
  end;

end;
$$;

revoke all on function public.attendance_qr_card_api(text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.attendance_qr_card_api(text,text,text,jsonb)
  to anon, authenticated;
