# Act on fresh app state

Select an app with "start". Set observedElementIndex from the latest
accessibility tree. If the editable control supports setValue, pass its value
directly and observe afterward; actions may renumber controls:

``` js
var field = { index: observedElementIndex, value: "replacement text" };
await app.setValue(field.index, field.value);
await app.getAXStateAndScreenshot();
```

Set field.value to the intended text. If setValue is unsupported or throws,
fetch fresh state before choosing another method; the field may have changed.
Never loop over cached indices. Clear fields with setValue and an empty string
when supported; an empty paste does not prove removal.

Short keyboard and typing sequences need known focus and no intermediate UI
choice. Use documented key names. Windows paste supports plain text only and
uses the same input path as typeText:

``` js
var pasteText = "First line\nSecond line";
await app.paste(pasteText, { format: "text" });
await app.getAXStateAndScreenshot();
```

Replace pasteText with the intended content. Verify focus and destination
behavior first: newlines may submit commands, forms or messages. selectText and
held mouse or key actions are unavailable on Windows.

Use secondary actions only when exposed in the tree. For controls inaccessible
through the tree, use a fresh screenshot and window-relative coordinates.
Scrolling requires a point and a distance in pixels. For example, after choosing
a point inside the intended scroll area from the latest screenshot:

``` js
await app.scroll(observedPoint, "down", { pixels: 400 });
await app.getAXStateAndScreenshot();
```

Observations wait for capture; do not add delays or clicks just for animation.
Read "api" or call `await cua.rewriteDocumentation()` for signatures.
