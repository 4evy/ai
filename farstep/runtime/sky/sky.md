# sky

## instructions

Call helper.handshake, then sky.prepare with a provisioning budget of up to
{{MINUTES}} minutes. Use js and js_reset to control this machine's persistent
Sky kernel. Each connection owns independent bindings. Code and input are
never automatically retried.

Every js request includes turn: { sessionId, turnId }. Keep those IDs stable
through the complete user-prompt tool loop. After the prompt finishes, call
sky.turn.end with the same IDs. Browser providers use this boundary to release
claimed tabs and clean up created tabs according to their returned
documentation. Ending an unused turn does not start a kernel. js_reset only
clears bindings, not browser tabs or native apps.

Use sky.file.read and sky.file.write to exchange bounded files with SHA-256
verification. Writes compare the destination's current digest before replacing
it.

Read skyBackend from the handshake and sky.reference for the selected API.
upstream uses the bundled cua interface for native apps and available browser
providers. Browser inventory is discovered on the selected target, not borrowed
from the caller's machine. Read the selected browser's returned documentation
and advertised capabilities. wayland exposes the narrower Farstep bridge through
(await import("@oai/sky")).sky. The reference describes that backend's supported
methods. Browser providers and app/window targeting are unavailable on Wayland.
