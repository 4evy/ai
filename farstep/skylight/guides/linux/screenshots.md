# Display the selected monitor

Initialize sky with "start". get_screenshot returns filepath, data_url and
decoded bytes for each image. Display bytes in order; emitImage detects their
format:

``` js
var shots = await sky.get_screenshot();
for (const shot of shots) await nodeRepl.emitImage(shot.bytes);
```

Never print base64. Input needs the latest frame and current geometry; capture
can succeed without pointer mapping, so do not guess coordinates. Read "start"
for output binding. Closing the runtime removes temporary screenshots. Recapture
after reset or session changes before acting or reusing paths.
