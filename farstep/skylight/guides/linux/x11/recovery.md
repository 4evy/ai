# Observe before retrying

After interruption, inspect the error and observe before resending: input may
have executed. Sky's window-targeted input does not fall back to desktop input
or activating a window. If a window closes or its identity changes, discover
and select the intended window again.

JavaScript errors need no reset. Call {{skylightTool}} with {{resetRuntime}} to
clear bindings, then initialize and observe again. Finish drag handles and held
keys in finally blocks while their runtime is available.

For setup failures, check `DISPLAY`, X11 authentication and the graphical user's
session bus on the selected machine. Window text input also needs the AT-SPI
accessibility bus and the app's accessibility tree. A screenshot or successful
keyboard request does not prove text input is available. A successful SSH
connection does not grant access to an X11 display. Wayland and Xwayland do not
provide a complete X11 desktop. Do not switch backends to bypass consent or a
revoked session.

Set timeout_ms for known slow operations. A larger cell budget does not change
Sky's native helper deadlines. Read "api" for the pinned runtime's reference.
