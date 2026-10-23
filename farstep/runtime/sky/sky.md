# sky

## instructions

Call helper.handshake, then sky.prepare with a provisioning budget of up to
{{MINUTES}} minutes. Use js and js_reset to control this machine's persistent
Sky kernel. Each connection owns independent bindings. Code and input are
never automatically retried.

Use sky.file.read and sky.file.write to exchange bounded files with SHA-256
verification. Writes compare the destination's current digest before replacing
it.

Read skyBackend from the handshake and sky.reference for the selected API.
upstream uses the bundled cua interface. wayland exposes the narrower Farstep
bridge through (await import("@oai/sky")).sky. The reference describes that
backend's supported methods. Do not assume app or window targeting on Wayland.
