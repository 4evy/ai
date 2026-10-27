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

For an editable element exposing text selection, `selectText` can select a
phrase or position the cursor without replacing the whole field. Set
`observedElementIndex` from fresh state and supply the exact observed text:

``` js
await app.selectText(observedElementIndex, "Friday", {
  prefix: "Meet on ",
  suffix: " at noon",
  selectionType: "text",
});
await app.getAXStateAndScreenshot();
```

`prefix` and `suffix` are the text immediately surrounding the match. Use them
to distinguish repeated occurrences. `selectionType: "text"` selects the
matching phrase. `"cursor_before"` and `"cursor_after"` place the insertion
point at its boundaries. After observing the selection, type or paste the
intended replacement or insertion.

Short keyboard and typing sequences need known focus and no intermediate UI
choice. Use documented key names. Prefer `app.paste` for multiline or formatted
content. It uses the macOS pasteboard and restores the user's previous clipboard
contents afterward. Verify focus and destination behavior first. Newlines may
submit commands, forms or messages.

Set the format with the content. This hypothetical example pastes rich HTML:

``` js
var pasteText = "<p>First line</p><p>Second line with <strong>emphasis</strong></p>";
var pasteOptions = { format: "html" };
await app.paste(pasteText, pasteOptions);
await app.getAXStateAndScreenshot();
```

Replace `pasteText` with the intended content. `"md"` pastes formatted Markdown,
`"html"` pastes HTML, and `"text"` inserts literal text without interpreting its
markup. Choose the format the destination supports. Clear fields with
`setValue` and an empty string when supported. An empty paste does not prove
removal. Browser paste has different clipboard behavior, so do not transfer
this macOS app guarantee to browser tabs.

Use secondary actions only when exposed in the tree. For controls inaccessible
through the tree, use fresh screenshots and window-relative coordinates.
Observations wait for capture. Do not add delays or clicks just for animation.
For signatures, call {{guideTool}} with {{apiGuide}} or
`await cua.rewriteDocumentation()`.
