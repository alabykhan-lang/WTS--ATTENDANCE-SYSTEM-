-- Keep official session records compatible with every vendor-neutral intake source.
-- Raw events remain the source of truth; this only prevents a valid adapter source
-- from failing when the interpreted AM/PM record is upserted.
alter table public.attendance_student_session_records
  drop constraint if exists attendance_student_session_records_source_check;
alter table public.attendance_student_session_records
  add constraint attendance_student_session_records_source_check
  check (source in (
    'manual','qr','nfc','mifare','rfid','card','fingerprint','face','pin',
    'import','google_sheets','correction','device','usb_hid','usb_ccid',
    'standalone_terminal','offline_sync'
  ));

alter table public.attendance_staff_session_records
  drop constraint if exists attendance_staff_session_records_source_check;
alter table public.attendance_staff_session_records
  add constraint attendance_staff_session_records_source_check
  check (source in (
    'manual','qr','nfc','mifare','rfid','card','fingerprint','face','pin',
    'import','google_sheets','correction','device','usb_hid','usb_ccid',
    'standalone_terminal','offline_sync'
  ));
