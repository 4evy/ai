# Act on fresh app state

Select an app with "start". Set `observedElementIndex` from the latest
accessibility tree. If the editable control supports `setValue`, pass its value
directly and observe afterward. Actions may renumber controls:

``` js
var field = { index: observedElementIndex, value: "replacement text" };
await app.setValue(field.index, field.value);
await app.getAXStateAndScreenshot();
```

Set `field.value` to the intended text. If `setValue` is unsupported or throws,
fetch fresh state before choosing another method because the field may have
changed. Never loop over cached indices.

Default observations may show only tree changes. Apply the latest diff to your
current tree before choosing a target. If that baseline is unclear, request
`app.getAXStateAndScreenshot({ disableDiffing: true })` and select from the full
tree. A full tree may renumber controls, so discard earlier indices.

Short keyboard and typing sequences need known focus and no intermediate UI
choice. Use documented key names. Prefer `app.paste` for multiline or formatted
content and check its documented clipboard behavior. Verify focus and
destination behavior first. Newlines may submit commands, forms or messages.

Set the format with the content. This hypothetical example pastes literal
Markdown source:

``` js
var pasteText = "First line\nSecond line with **literal asterisks**";
var pasteOptions = { format: "text" };
await app.paste(pasteText, pasteOptions);
await app.getAXStateAndScreenshot();
```

Replace `pasteText` with the intended content. Choose a documented format that
matches the destination's intended behavior. Clear fields with `setValue` and
an empty string when supported. An empty paste does not prove removal.

Use secondary actions only when exposed in the tree. For controls inaccessible
through the tree, use fresh screenshots and window-relative coordinates.
Observations wait for capture. Do not add delays or clicks just for animation.
For signatures, call {{guideTool}} with {{apiGuide}} or
`await cua.rewriteDocumentation()`.
