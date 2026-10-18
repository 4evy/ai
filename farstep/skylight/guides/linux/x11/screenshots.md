# Display X11 window state

Select an app with "start", then observe:

``` js
await app.getAXStateAndScreenshot();
```

Output is automatic. For selective display:

``` js
var state = await app.getAXStateAndScreenshot({ emit: false });
await nodeRepl.write(state.state);
if (state.screenshot) await nodeRepl.emitImage(state.screenshot);
```

Coordinates are relative to the selected window. Capture fresh state after
window or content changes. Linux reports whether its tree comes from AT-SPI or
the observation-only X11 fallback. Never infer actionable indices from the
fallback tree. emitImage detects the byte format. Never print base64 or relabel
the image bytes.
