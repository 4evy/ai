# Create a temporary workspace

Call {{scratchTool}} with {{createWorkspace}}. Choose a name for your work. Omit
`target` locally or pass a saved SSH connection ID. Save the returned ID, `cwd`
and file-tool paths. Merge the returned run arguments with your script. Place
files under `cwd` using native tools locally or remote tools over SSH.

Use `list` to find workspaces or {{inspectWorkspace}} to recover paths and
metadata. Replace `WORKSPACE_ID` with the returned ID and keep the target with
it. After an interruption, inspect or list before retrying because the operation
may have completed.

These private directories are not sandboxes or durable storage. Copy needed
outputs elsewhere. Before {{removeWorkspace}}, replace `WORKSPACE_ID` with the
returned ID and wait for or stop every job using the directory. Remove it on the
same target. Removal deletes files without stopping processes. Scratch needs no
helper, but jobs do.
