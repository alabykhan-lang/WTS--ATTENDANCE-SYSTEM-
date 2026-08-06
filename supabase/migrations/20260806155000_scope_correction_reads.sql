-- A requester may see only their own pending correction requests. Reviewers and
-- global administrators continue through the complete review queue.
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
