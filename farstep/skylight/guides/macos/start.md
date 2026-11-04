# Select and observe an app

For browser work, call {{guideTool}} with {{browserGuide}} instead of selecting
the browser as a native app. Browser inventory identifies available providers
and profiles.

In {{skylightTool}}'s `code` parameter, begin a fresh runtime with one entry
point. cua is initialized automatically. Use the requested app's name, bundle
ID or full path. For example, select Calculator:

``` js
var app = await cua.getApp("com.apple.calculator");
```

If the target is unknown, begin with inventory instead:

``` js
var inventory = await cua.getState();
```

Read returned documentation and state before another call. Inventory can include
errors or apps without windows. Failure does not prove absence. Inspect missing
or ambiguous matches. If copies share a bundle ID, select the intended `.app`
by its full path rather than retrying that ID. A bare executable is not
necessarily a selectable app. Name lookup can find an installed copy instead
of a development build, so verify the returned app and window.

`getApp` launches in the background if needed, not just attaches. Actions can
change focus. Apps are not isolated in another Space.

Observations emit output automatically. `getAXStateAndScreenshot` also emits an
image. Do not wrap observations in `nodeRepl.write` or `nodeRepl.emitImage`.
Use fresh targets and methods exposed for the selected app. Read "actions"
before input.

Use var for reusable top-level bindings and const inside loops. The REPL runs
JavaScript, not TypeScript.
