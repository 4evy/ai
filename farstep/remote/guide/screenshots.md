# Capture before pointer input

Call {{screenshotTool}} with {{captureFrame}} using the saved connection and
authorized session IDs. It captures the user-selected monitor or window and
returns an image with session and frame geometry. Save `streamId` and `frameId`
with the image for pointer input. Capture alone does not authorize control.

Use the latest frame. `logicalGeometry:null` means no pointer mapping is
available. Resize, rotation, hotplug, session closure or disconnection
invalidates coordinates, so recapture before acting. Input requires capture and
control authorization.
