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

Some apps expose only window controls and menus in the accessibility tree.
Use a screenshot to inspect their content. An unchanged or sparse tree does
not prove that the visible UI is unchanged. Do not poll the same tree
repeatedly when it cannot answer the next question.

If no screenshot is returned, use supported tree indices or capture a fresh
image before coordinate input. After screenshot-only observation, request a full
tree with disableDiffing:true before using indices again.

Coordinates are window-relative. `emitImage` detects the byte format. Never
print base64 or assign a different image format to the bytes.
