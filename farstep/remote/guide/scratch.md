# Create a temporary workspace

Call {{scratchTool}} with {{createWorkspace}}. Choose a name for your work. Omit
`target` locally or pass a saved SSH connection ID. Use the returned ID, cwd and
file-tool paths; merge the run arguments with your command. Place files under
cwd using native tools locally or remote tools over SSH.

Use `list` to find workspaces and `inspect` with `workspace` set to the returned
ID for paths and metadata. Keep the target with each ID. After interruption,
inspect or list before retrying; the operation may have completed.

These private directories are not sandboxes or durable storage. Copy needed
outputs elsewhere. Before {{removeWorkspace}}, replace `WORKSPACE_ID` with the
returned ID and wait for or stop every job using the directory. Remove on the
same target; removal deletes files without stopping processes. Scratch needs no
helper; jobs do.
