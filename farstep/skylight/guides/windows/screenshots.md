# Display app state and a screenshot

Select an app with "start", then observe:

``` js
await app.getAXStateAndScreenshot();
```

Windows screenshots are displayed automatically by Sky. emit:false is
unavailable for observations that capture screenshots. Do not emit the returned
bytes again or print base64.

For a text-only observation:

``` js
await app.getAXState();
```

If accessibility state is unavailable, use a fresh screenshot and supported
coordinate actions. After screenshot-only observation, fetch accessibility state
again before using element indices.

Coordinates are window-relative. The selected app retains the latest captured
screenshot identifier for coordinate input; recapture after changes to window
size, position or content. An AX-only observation clears that screenshot
mapping; capture again before coordinate input.
