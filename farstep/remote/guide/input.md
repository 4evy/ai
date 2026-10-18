# Send input to the observed frame

Call {{inputTool}} with a saved connection, authorized session ID and an action.
A hypothetical click using the latest capture:

{{clickFrame}}

Replace the connection, session and frame placeholders with returned IDs.
Replace `OBSERVED_X` and `OBSERVED_Y` with numeric pixel coordinates observed in
that image, without quotes. Pointer actions need both frame identifiers. If
authorization or mapping is missing, resolve it and recapture before input.

Inspect the app after partial or interrupted input. Success confirms backend
submission, not app acceptance; check text receipts for mechanism,
clipboardChanged, submittedBytes and partial. Text delivery depends on the
backend and may use clipboard paste. Verify the destination's paste chord and
newline behavior; paste may change the clipboard or enter its history.
