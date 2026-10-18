# Act on the latest screenshot

Initialize sky with "start". Set observedX and observedY from the latest image.
Pointer input needs an authoritative mapping; recapture after geometry, scale,
rotation or output changes:

``` js
await sky.click({ x: observedX, y: observedY });
var shots = await sky.get_screenshot();
for (const shot of shots) await nodeRepl.emitImage(shot.bytes);
```

After verifying a text field's focus and Control+A behavior, replace its
contents and inspect the receipt and app:

``` js
var textInput = { text: "replacement text", paste_key: "Control_L+v" };
await sky.press_key({ key: "Control_L+a" });
if (textInput.text === "") {
  await sky.press_key({ key: "BackSpace" });
} else {
  var receipt = await sky.type_text(textInput);
  await nodeRepl.write(JSON.stringify(receipt, null, 2));
  if (receipt.status === "error") {
    throw new Error(`${receipt.code}: ${receipt.message}`);
  }
  if (
    receipt.partial ||
    receipt.submittedBytes !== Buffer.byteLength(textInput.text, "utf8")
  ) {
    throw new Error("Text input did not complete; read recovery before continuing");
  }
}
var shots = await sky.get_screenshot();
for (const shot of shots) await nodeRepl.emitImage(shot.bytes);
```

Set textInput.text to the intended text. For an empty replacement, BackSpace
deletes the selection; type_text leaves the field unchanged. Do not use this
sequence in terminals: Control+A may move the cursor. Terminal paste may need
paste_key:"Control_L+Shift_L+v".

Check status, mechanism, clipboardChanged, submittedBytes and partial. Bytes
measure UTF-8 submission, not app acceptance. Delivery depends on the backend;
clipboard paste may enter history and leave the clipboard changed. Newlines may
submit commands or forms. Failure stops the snippet before capture: read
"recovery", then observe before resuming. Never automatically replay or request
new consent.

For scrolling, set the direction, pixel distance and origin from the latest
image. Replace this hypothetical distance:

``` js
var scrollInput = {
  direction: "down",
  pixels: 480,
  x: observedX,
  y: observedY,
};
await sky.scroll(scrollInput);
var shots = await sky.get_screenshot();
for (const shot of shots) await nodeRepl.emitImage(shot.bytes);
```

Supply both x and y or omit both. Read "api" for argument constraints. Observe
after scrolling before choosing another target.

Keys use keysyms such as Return and Control_L+a. Finish drag_handle with end()
before unrelated input; reset, abort or connection loss releases held input.
Read "api" for signatures.
