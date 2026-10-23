# Select and observe an app

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
errors or apps without windows. Failure does not prove absence. Resolve the
requested app to a unique ID before calling `cua.getApp` with it. Inspect
missing or ambiguous matches. `getApp` launches in the background if needed.
Actions can change focus. Apps are not isolated in another Space.

Observations emit output automatically. `getAXStateAndScreenshot` also emits an
image. Do not wrap observations in `nodeRepl.write` or `nodeRepl.emitImage`.
Use fresh targets and methods exposed for the selected app. Read "actions"
before input.

Use var for reusable top-level bindings and const inside loops. The REPL runs
JavaScript, not TypeScript.
