# Select a browser and work with its tabs

Browser control is available on macOS, Windows, and X11, not the Wayland
monitor bridge. Reading this guide does not start Sky. {{skylightTool}} starts
the selected target's runtime with `cua` initialized automatically.

## Select the requested browser and profile

Discover providers with {{skylightTool}} and {{browserInventory}}.
Match the requested browser and profile to the returned inventory, including
its exact ID. An installed browser need not have a connected CUA provider.
Report a missing requested provider instead of silently choosing another.

Set `observedBrowserId` to that inventory ID, then call {{skylightTool}} with:

{{browserTabs}}

Selection does not open a tab. Use the returned `browser.browserId` for later
calls. Read the provider's returned documentation before using its APIs.
To display it again, use `nodeRepl.write(await browser.documentation())`.

## Bind an existing tab or create a requested one

Match the requested tab by its current URL, title, and ID. Set `observedTabId`
from that listing, then call {{skylightTool}} with {{browserTab}}.

A string passed to `getTab` means a tab ID. For a URL, use
`cua.getTab({ url: observedTabUrl }, { browser: browser.browserId })`.
A user-supplied tab mention uses `cua.getTab({ mention: tabMentionUrl })` with
the complete `plugin://...` URL. Do not substitute an unrelated tab.

Create a tab only when needed with
`cua.createBrowserTab(browser.browserId, requestedUrl)`. Creation is not
supported by every provider.

## Follow the selected provider's documentation

Binding or creating a tab emits its initial state and documentation.
Observations emit their own output too, so do not wrap them in
`nodeRepl.write` or `nodeRepl.emitImage`. Use `var` for reusable REPL bindings.

Read state before input and observe afterward. DOM-only tabs have no numeric
accessibility indices. Use their documented `tab.playwright` locators rather
than inventing indices or falling back to native input. This is not the full
external Playwright API. Navigation, capabilities, and lifecycle methods vary
by provider. Discover capabilities at the browser or tab scope that owns them
and read their documentation before use. For the bundled reference, call
{{guideTool}} with {{apiGuide}}.

## Transfer files and preserve only needed tabs

Upload and download paths belong to the selected target. Use {{syncTool}} to
move files between machines, not browser or tab handles. Follow the provider's
file API, starting chooser or download waits before the triggering action.
Do not assume `locator.setInputFiles` or a local download path exists.

For providers with automatic turn-end cleanup, leave intermediate tabs unmarked.
When documented, use `await tab.markDeliverable()` for a live tab the user
should keep, or `await tab.markHandoff()` for a page awaiting later work or
user input. Turn-scoped marks must be renewed each turn, and the latest mark
wins. Do not close user-owned tabs to clean up a binding. Reset clears REPL
bindings, not browser tabs.
