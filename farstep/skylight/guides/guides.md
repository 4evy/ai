# guides

## target

Select `target: "local"` or an OpenSSH host/alias before executing. Each target
and working directory has independent bindings. Use {{GUIDE_TOOL}} with the same
target for its platform API. Use {{SYNC_TOOL}} to transfer files between
machines. Do not move app handles or assume paths exist on another machine.

For browser control, load the "browser" topic before selecting a browser or tab.
Wayland uses CUA for browsers and a separate monitor bridge for desktop input.
Static guides do not start or provision Sky.
