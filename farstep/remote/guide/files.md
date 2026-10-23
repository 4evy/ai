# Work with remote files

Use {{readTool}}, {{writeTool}}, {{editTool}} or {{deleteTool}} with a saved
`connection` and a literal absolute, `~/` or connection-relative path. These
tools need no helper. File transfers are limited to {{fileMiB}} MiB. Check
returned errors and truncation before using a result.

Read a file range with {{readTool}} and {{readFileRange}}. Use your saved
connection ID and literal path. For directories, use `offset` and `limit`
instead of `selector`. Even a range returns the whole file's `sha256`. To reject
an edit if that content has changed, pass the hash to {{editTool}}:

{{editFile}}

Replace the connection, path, old and new text, and `FULL_FILE_SHA256` with
actual values. `expectedHash` rejects stale edits, but the final check and write
are not atomic against other writers.

{{writeTool}} creates parents and overwrites the file. {{editTool}} replaces
`old_string` with `new_string`. Ambiguous matches require `replace_all:true`.
Both preserve regular-file permissions but replace symlinks. {{deleteTool}}
removes a file or symlink and refuses directories. After a transport failure,
inspect before retrying because the mutation may have completed.

If the connection returns an `ssh://` root, native file tools can use it. Use
absolute URL paths and percent-encode reserved characters within path
components. Follow the reported transfer prerequisites.
