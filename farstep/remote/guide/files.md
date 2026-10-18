# Work with remote files

Use {{readTool}}, {{writeTool}}, {{editTool}} or {{deleteTool}} with a saved
connection and a literal absolute, ~/ or connection-relative path. Check tool
descriptions and returned errors for transfer limits; no helper is needed.

Read a file range with {{readTool}} and {{readFileRange}}. Use your saved
connection ID and literal path. Use `offset`/`limit` for directories instead of
`selector`. Even a range returns the whole file's `sha256`. A hypothetical
{{editTool}} using that hash:

{{editFile}}

Replace the connection, path, old/new text and `FULL_FILE_SHA256` with actual
values. `expectedHash` rejects stale edits; the final check/write is not atomic
against other writers.

{{writeTool}} creates parents and overwrites. {{editTool}} uses
old_string/new_string; ambiguous matches need replace_all:true. Both preserve
regular-file permissions but replace symlinks. {{deleteTool}} removes a file or
symlink and refuses directories. After transport failure, inspect before
retrying: the mutation may have completed.

If the connection returns an ssh:// root, native file tools can use it. Use
absolute URL paths and percent-encode reserved characters within path
components. Follow reported transfer prerequisites and check results for
truncation.
