# Skylight API reference

Source: {{referencePath}}

Before using this reference, call {{guideTool}} with {{startGuide}}. These
generated schemas describe the Skylight Linux adapter's supported methods,
inputs and text receipts. Do not assume other upstream Sky methods are
available.

Use "screenshots" for display and "actions" for input. The adapter tracks the
captured frame for pointer input. Act only on the latest image and recapture
after display changes. Follow "start" for output choice and consent.

Call `sky.METHOD(INPUT)` for each method in `inputs`. `type_text` returns
`textResult`. Other methods return `status: "ok"` or throw. Text errors return
`status: "error"`, `code` and `message` when a receipt exists. Errors without
receipts and missing success receipts throw. Read "actions" for clipboard
effects and partial input.

Finish drag_handle with end() before unrelated input. Valid arguments alone do
not establish access: calls can fail for missing consent, stale frames or
unavailable compositor capabilities.

``` json
{{adapterReference}}
```
