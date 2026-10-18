# Skylight API reference

Source: {{referencePath}}

Read "start" before use. These generated schemas describe the Skylight Linux
adapter's supported methods, inputs and text receipts. Do not assume that other
upstream Sky methods are available.

Use "screenshots" for display and "actions" for input. The adapter tracks the
captured frame for pointer input; act only on the latest image and recapture
after display changes. Follow "start" for output choice and consent.

Call sky.METHOD(INPUT) for each inputs method. type_text returns textResult;
other methods return status:"ok" or throw. Text errors return status:"error",
code and message when a receipt exists; errors without receipts and missing
success receipts throw. Read "actions" for clipboard effects and partial input.

Finish drag_handle with end() before unrelated input. Valid arguments alone do
not establish access: calls can fail for missing consent, stale frames or
unavailable compositor capabilities.

``` json
{{adapterReference}}
```
