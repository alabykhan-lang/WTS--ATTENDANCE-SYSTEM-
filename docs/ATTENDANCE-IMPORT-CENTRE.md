# Import Centre

## Supported input

CSV, XLSX, XLS, TSV and generic delimited text are accepted in the browser. The adapter layer also defines read-only Google Sheets input and future vendor adapters.

## Workflow

1. Select an existing registered device when applicable.
2. Select the generic or verified adapter.
3. Upload the file.
4. Calculate a checksum and reject a previously uploaded device/checksum pair.
5. Preview rows and map columns.
6. Validate timestamps, direction and credential references.
7. Resolve unknown users to real Central Registry identities; never auto-create a person.
8. Confirm accepted rows.
9. Process them through the universal intake function.
10. Review the batch report and retain all unresolved/rejected rows.

Every batch records file name, checksum, device, uploader, upload time, source row count, accepted, duplicate, rejected and unresolved totals, status and audit history. Re-uploading the same file cannot create duplicate official attendance.

Device names in an export are informational. The stable device user ID/card value is the matching key.
