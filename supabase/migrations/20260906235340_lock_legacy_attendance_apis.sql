-- The strict architecture migration was already applied before the service-role
-- grants on historical wrappers were audited. Lock every old operator wrapper;
-- QR lifecycle internals use their private core functions and remain unaffected.
do $$
declare
  v_function record;
begin
  for v_function in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'attendance_universal_admin_read_api',
        'attendance_universal_admin_write_api',
        'attendance_universal_report_api',
        'attendance_notebook_read_api',
        'attendance_notebook_write_api',
        'attendance_admin_read_api',
        'attendance_admin_write_api',
        'staff_attendance_admin_read_api',
        'staff_attendance_admin_write_api',
        'attendance_controls_admin_read_api',
        'attendance_controls_admin_write_api'
      ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_function.signature);
  end loop;
end;
$$;
