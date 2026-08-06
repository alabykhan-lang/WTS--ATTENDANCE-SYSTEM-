-- A file checksum identifies the upload itself. Do not allow the same export to
-- be processed twice merely because an operator selected a different device.
create unique index if not exists attendance_import_batches_checksum_global_uq
  on public.attendance_import_batches(checksum_sha256)
  where checksum_sha256 is not null;
