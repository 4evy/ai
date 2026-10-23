# Capture the selected Wayland monitor

Skylight needs farstep running as the graphical user, an active Wayland
session, its session bus and XDG_RUNTIME_DIR. X11, accessibility trees and app
targeting are unavailable. Initialize in {{skylightTool}}'s code parameter:

``` js
var sky = (await import("@oai/sky")).sky;
var shots = await sky.get_screenshot();
for (const shot of shots) await nodeRepl.emitImage(shot.bytes);
```

Initialize once per runtime. Use var for reusable top-level bindings and const
inside loops. The REPL runs JavaScript, not TypeScript.

The first capture asks the user to choose a source and consent. Imports, guide
reads and restore tokens grant no access.

Capture and input capabilities vary by desktop. Check helper inspection before
choosing a method. If direct input needs an explicit output binding, obtain the
user's output name and initialize with it:

``` js
var sky = (await import("@oai/sky")).sky;
var shots = await sky.get_screenshot({ outputName: userSelectedOutputName });
for (const shot of shots) await nodeRepl.emitImage(shot.bytes);
```

Set `userSelectedOutputName` to that exact name. Never choose the first
discovered output. The user must select the same monitor in the portal. Later
captures reuse the first capture's `outputName`. Reset before changing it or
adding it to an existing capture binding. Read "actions" before input.

Managed launches may use a separate workspace. Do not assume a launch changes
the captured monitor. Display initial state and capture after each action.
