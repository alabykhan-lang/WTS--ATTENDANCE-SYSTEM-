-- Preserve a one-way hash of the exact device value alongside the normalized
-- hash. This keeps punctuation/case-tolerant card mapping while remaining
-- compatible with scanners that hash the exact reader output.
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
    when 'damaged' then 'suspended' when 'active' then 'active' when 'pending' then 'pending'
    when 'lost' then 'lost' when 'replaced' then 'replaced' when 'revoked' then 'revoked'
    when 'expired' then 'expired' else 'suspended' end;
  v_last4 := coalesce(new.token_last4, right(new.token_hash,4));
  v_valid_from := coalesce(new.valid_from,new.issued_at,now());
  v_valid_until := new.valid_until;
  v_last_used_at := new.last_used_at;
  delete from public.attendance_credential_index where source_credential_id=new.id and person_type=v_person_type;
  insert into public.attendance_credential_index(
    credential_hash,legacy_hash,credential_last4,person_type,student_id,staff_id,source_credential_id,
    credential_type,external_user_id,status,valid_from,valid_until,issued_at,last_used_at,revoked_at,
    revocation_reason,replaced_by,metadata,created_at,updated_at
  ) values(
    new.token_hash,v_legacy_hash,v_last4,v_person_type,v_student_id,v_staff_id,new.id,v_credential_type,
    new.metadata->>'external_user_id',v_status,v_valid_from,v_valid_until,coalesce(new.issued_at,now()),v_last_used_at,
    case when v_status in ('revoked','replaced','lost') then coalesce(new.disabled_at,now()) end,
    new.disabled_reason,new.replaced_by_card_id,v_metadata,coalesce(new.created_at,now()),now()
  );
  return new;
end;
$$;

revoke all on function public.attendance_sync_credential_index() from public,anon,authenticated;
