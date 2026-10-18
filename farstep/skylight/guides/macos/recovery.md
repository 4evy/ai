# Observe after uncertain input

After interrupted or timed-out input, fetch fresh state before resuming; input
may have executed. If app-name lookup fails, use cua.listApps() for the bundle
ID. Stop when the user stops or intervenes. Locked screens and pending
permissions need user attention; resolve permission or version failures before
continuing.

JavaScript errors need no reset. Call {{skylightTool}} with {{resetRuntime}} to
clear REPL bindings; reacquire apps with "start" and observe their current
state. Session switches, branches, trees and shutdown discard the runtime. After
compaction, call `await cua.rewriteDocumentation()` to refresh docs without
clearing bindings. This runtime helper is available even though the generated
`cua` interface omits it. Increase `timeout_ms` only for known slow operations;
it does not establish whether interrupted input ran.
