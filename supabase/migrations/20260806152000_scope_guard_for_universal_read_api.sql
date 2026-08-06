-- Keep the large read implementation stable while adding a small, explicit
-- scope gate at its public entrypoint. This prevents a class-scoped role from
-- reading an unrelated class by changing a request payload.
alter function public.attendance_universal_admin_read_api(text,text,text,jsonb)
  rename to attendance_universal_admin_read_api_legacy;

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
  v_class text;
  v_is_global boolean;
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
  select * into v_config from public.attendance_system_config where singleton=true;
  v_session:=coalesce(nullif(p_payload->>'session',''),v_config.operational_session,public.attendance_operational_session());
  v_term:=coalesce(nullif(p_payload->>'term',''),v_config.operational_term,public.attendance_operational_term());

  if p_action='register' then
    if not (v_is_global or 'class.attendance.read'=any(v_permissions) or 'reports.read'=any(v_permissions)) then
      return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
    end if;
    v_class:=trim(coalesce(p_payload->>'classKey',''));
    if not v_is_global and not exists(
      select 1 from public.school_staff_class_allocations a
      where a.class_key=v_class and a.allocation_status='active'
        and (a.person_id=v_client.central_person_id or a.staff_id=v_client.central_person_id)
        and (a.academic_session=v_session or a.academic_session is null)
        and (a.term_name=v_term or a.term_name is null)
    ) then
      return jsonb_build_object('ok',false,'code','CLASS_SCOPE_DENIED');
    end if;
  elsif p_action='staff_logbook' and not (v_is_global or 'staff.read'=any(v_permissions) or 'personal.attendance.read'=any(v_permissions)) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  elsif p_action='credentials' and not (v_is_global or 'credentials.manage'=any(v_permissions)) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  elsif p_action='devices' and not (v_is_global or 'devices.read'=any(v_permissions) or 'devices.manage'=any(v_permissions)) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  elsif p_action in ('imports','import_rows') and not (v_is_global or 'imports.read'=any(v_permissions) or 'imports.manage'=any(v_permissions)) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  elsif p_action='corrections' and not (v_is_global or 'corrections.create'=any(v_permissions) or 'corrections.review'=any(v_permissions)) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  elsif p_action='report' and not (v_is_global or 'reports.read'=any(v_permissions)) then
    return jsonb_build_object('ok',false,'code','ADMIN_PERMISSION_DENIED');
  end if;
  return public.attendance_universal_admin_read_api_legacy(p_client_code,p_client_secret,p_action,p_payload);
end;
$$;

revoke all on function public.attendance_universal_admin_read_api(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.attendance_universal_admin_read_api(text,text,text,jsonb) to anon,authenticated;
