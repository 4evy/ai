# Capture before pointer input

Capture the user-selected monitor/window on a saved connection for an image and
session/frame geometry. Input requires capture/control authorization and a fresh
capture for current identifiers.

Call {{screenshotTool}} with {{captureFrame}} using the saved connection and
authorized session IDs. Save the returned `streamId` and `frameId` with the
image for pointer input.

Use the latest frame; logicalGeometry:null means no pointer mapping. Resize,
rotation, hotplug, session closure or disconnection invalidates coordinates:
recapture before acting.
