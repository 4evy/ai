# Access a remote desktop

Call {{desktopTool}} with {{inspectDesktop}} and your saved connection ID. Check
which operations are available, requestable or granted. SSH alone grants no
desktop access.

Request control with {{authorizeDesktop}}. On Linux, let the user select the
source and consent. macOS requests Screen Recording and Accessibility
permissions. Windows uses the installed interactive desktop task. Locked or
secure Windows desktops are unavailable. Read "screenshots" and "input" before
acting.

All three platforms support monitor and window capture. Native macOS and
Windows text input sends Unicode events without changing the clipboard.

Use `open` only when inspection reports support. It launches a URI in a managed
workspace without changing the selected capture source. Save `workspaceId` and
release it with {{releaseWorkspace}} when finished. Use the saved connection and
returned workspace ID. Check the result because occupied workspaces may be
retained.

Set `outputName` for direct input that needs an explicit output choice.
`release` closes control and releases held input, but leaves workspace leases
intact.
