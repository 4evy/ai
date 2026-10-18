# Act on fresh X11 window state

Select an app with "start". Read its returned documentation before input. Linux
always returns full accessibility state. AT-SPI elements support only the
actions shown in the tree. The x11 fallback tree is observation-only. Use the
latest screenshot and window-relative coordinates when element input is
unavailable. Use the exact Secondary Actions names with
app.performSecondaryAction(index, action) when the tree exposes them.

After choosing an element from the latest AT-SPI tree:

``` js
await app.click(observedElementIndex);
await app.getAXStateAndScreenshot();
```

Re-read state after actions and derive fresh indices. Linux element clicks
support one left or right click. Use coordinates for other click options.

setValue and selectText are unavailable. Window-targeted typeText and paste
require a working AT-SPI tree. The x11 fallback alone does not provide text
entry. After verifying the field's focus and Control+A behavior, replace its
contents with supported keyboard and text input:

``` js
await app.pressKey("Control_L+a");
await app.typeText("replacement text");
await app.getAXStateAndScreenshot();
```

Replace the example text with the intended content. For an empty replacement,
delete the selection with BackSpace. Do not assume Control+A selects text in a
terminal. Newlines may submit commands or forms. app.paste supports plain text
only and uses Sky's native text input. Text entry uses the shared clipboard.

For scrolling, choose a fresh element or window-relative point and a distance:

``` js
await app.scroll(observedPoint, "down", { pixels: 400 });
await app.getAXStateAndScreenshot();
```

Observe after input before deciding the next action. Some apps omit current
field values from accessibility text, so inspect the screenshot too. Sky handles
settling before observations. Do not add animation delays. Read "api" for
clipboard snapshots, held keys, drag handles and other Sky methods outside the
bound CUA interface.
