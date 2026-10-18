# Display app state and a screenshot

Select app with "start", then observe:

``` js
await app.getAXStateAndScreenshot();
```

Output is automatic. For selective display:

``` js
var state = await app.getAXStateAndScreenshot({ emit: false });
await nodeRepl.write(state.state);
if (state.screenshot) await nodeRepl.emitImage(state.screenshot);
```

If no screenshot is returned, use supported tree indices or capture a fresh
image before coordinate input. After screenshot-only observation, request a full
tree with disableDiffing:true before using indices again.

Coordinates are window-relative. emitImage detects the byte format; never print
base64 or assign a different image format to the bytes.
