# Select and observe an X11 app

This target uses the bundled CUA/Sky runtime for X11. An X11 session needs
DISPLAY and its authentication available to the selected machine's process.
With XDG_SESSION_TYPE=x11, or DISPLAY without a Wayland session, Skylight uses
upstream Sky directly. A Wayland session uses Farstep's monitor bridge. Xwayland
does not expose the full Wayland desktop.

In {{skylightTool}}'s code parameter, begin a fresh runtime with inventory.
cua is initialized automatically:

``` js
var inventory = await cua.getState();
```

Read returned documentation and state before another call. Choose the requested
app's exact open window by its app and title, then set observedWindowId to its
ID:

``` js
var app = await cua.getApp({ windowId: observedWindowId });
```

Do not choose the first window without checking it. cua.listWindows() also finds
windows without an app entry. Selecting an app does not launch it. If the app
has no window, call cua.computer.launch_app({ app: observedAppId }) with its
inventory ID, refresh inventory, then select the requested window. Input stays
bound to that window without activating it or moving the desktop pointer. Apps
may still open or activate windows during interaction.

Observations emit output automatically. Do not wrap them in nodeRepl.write or
nodeRepl.emitImage. Read "actions" before input. Use var for reusable top-level
bindings and const inside loops. The REPL runs JavaScript, not TypeScript.
