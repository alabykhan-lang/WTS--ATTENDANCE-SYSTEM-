# Import Centre

## Supported input

CSV, XLSX, XLS, TSV and generic delimited text are accepted in the browser. The adapter layer also defines read-only Google Sheets input and future vendor adapters.

## Workflow

1. Select an existing registered device when applicable.
2. Select the generic or verified adapter.
3. Upload the file.
4. Calculate a checksum and reject a previously uploaded device/checksum pair.
5. Preview rows and validate the exported QR values, timestamps and direction.
6. Validate timestamps, direction and credential references.
7. Confirm accepted rows. Values that do not match an issued QR remain rejected/unresolved; the import flow never creates or manually assigns a person.
8. Process them through the universal intake function.
9. Review the batch report and retain all unresolved/rejected rows.

Every batch records file name, checksum, device, uploader, upload time, source row count, accepted, duplicate, rejected and unresolved totals, status and audit history. Re-uploading the same file cannot create duplicate official attendance.

Device names in an export are informational. The stable device user ID/card value is the matching key.
