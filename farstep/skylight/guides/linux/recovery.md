# Observe before retrying

After interruption, inspect the error and observe before resending: input may
have executed. Failed helper calls release control; a later capture may request
consent again. Text receipts can report partial input without closing the
session.

JavaScript errors need no reset. Call {{skylightTool}} with {{resetRuntime}} to
clear bindings and release input; initialize and capture again afterward.

Cancellation, denial, revocation or session/device loss ends access. Never
approve portal dialogs for the user or switch backends to bypass consent.
Recapture stale frames; reset before changing outputs.

For setup failures, inspect helper status, the graphical user service,
WAYLAND_DISPLAY, XDG_RUNTIME_DIR and the session bus. Installation creates no
graphical session; missing compositor/portal protocols limit capabilities. Set
timeout_ms for known slow operations; increasing the cell budget does not change
a helper or backend's own deadline.
