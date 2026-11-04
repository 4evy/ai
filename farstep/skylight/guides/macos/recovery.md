# Observe after uncertain input

After interrupted or timed-out input, fetch fresh state before resuming because
input may have executed. Do not replay the sequence automatically.

Upstream errors may name `get_app_state` or `tool_search`. In Skylight, observe
the bound app with `await app.getAXState()` or
`await app.getAXStateAndScreenshot()` instead. Derive targets from that new
state, not the rejected call's indices. If the error says Computer Use is not
active and observation does not restore it, reacquire the intended app with
`cua.getApp(...)` and inspect its state before input.

If app-name lookup fails, use `cua.listApps()` for its bundle ID. If that ID is
ambiguous, select the intended `.app` by full path. An inventory entry alone
does not establish that a Java or Wine-hosted window is selectable.

Stop when the user stops or intervenes. Locked screens and pending permissions
need user attention. Resolve permission or version failures before continuing.

Ordinary JavaScript errors need no reset. If a timeout reports that the kernel
was reset, its bindings are already gone. Reacquire the app and observe before
resuming. Call {{skylightTool}} with {{resetRuntime}} only when you need to
clear REPL bindings explicitly. Session switches, branches, trees and shutdown
also discard the runtime. After compaction, call
`await cua.rewriteDocumentation()` to refresh docs without clearing bindings.
This runtime helper is available even though the generated `cua` interface omits
it. Increase `timeout_ms` only for known slow operations. It does not establish
whether interrupted input ran.
