# Access a remote desktop

Call {{desktopTool}} with {{inspectDesktop}} and your saved connection ID. Check
which operations are available, requestable or granted; SSH alone grants no
desktop access. Request control with {{authorizeDesktop}} and let the user
select the source and consent on Linux. macOS requests Screen Recording and
Accessibility; Windows uses the installed interactive desktop task. Locked or
secure Windows desktops are unavailable. Read "screenshots" and "input" before
acting.

Monitor and window capture are supported on all three platforms. Native
macOS and Windows text input sends Unicode events without changing the
clipboard.

Use open only when inspection reports support. It launches a URI in a managed
workspace; this does not change the selected capture source. Save workspaceId
and release it with {{releaseWorkspace}} when finished. Use the saved connection
and returned workspace ID. Check the result: occupied workspaces may be
retained.

Set outputName for direct input that needs an explicit output choice. release
closes control and releases held input, but leaves workspace leases intact.
