# Select and observe an app

In {{skylightTool}}'s code parameter, begin a fresh runtime with inventory.
cua is initialized automatically:

``` js
var inventory = await cua.getState();
```

Read returned documentation and state before another call. Inventory can include
errors or apps without windows. Failure does not prove absence. Choose the
requested app's exact open window by its app and title, then set
observedWindowId to its ID:

``` js
var app = await cua.getApp({ windowId: observedWindowId });
```

Do not choose the first window without checking it. cua.listWindows() also finds
windows without an app entry. getApp does not launch apps on Windows. If the app
has no window, call cua.computer.launch_app({ app: observedAppId }) with its
inventory ID, refresh inventory, then select the requested window. Actions can
change focus, and apps share the interactive desktop.

Observations emit output automatically. Windows screenshots are displayed by
Sky. Do not wrap observations in nodeRepl.write or nodeRepl.emitImage. Use fresh
targets and methods exposed for the selected app. Read "actions" before input.

Skylight downloads its pinned ChatGPT computer-use runtime on first use. Native
Windows x64 and Arm64 are supported. Run it in an unlocked interactive Windows
session. Linux or WSL processes use the Linux backend.

Use var for reusable top-level bindings and const inside loops. The REPL runs
JavaScript, not TypeScript.
