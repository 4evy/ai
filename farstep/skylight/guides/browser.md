# Select a browser and work with its tabs

Browser control uses the selected target's available CUA providers on macOS,
Windows, X11, and Wayland. Reading this guide does not start Sky.
{{skylightTool}} starts the runtime with `cua` initialized automatically.

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

Binding or creating a tab emits its initial state and documentation. The CUA
facade's `getAXState()`, `getScreenshot()` and `getAXStateAndScreenshot()` also
emit output automatically. Do not wrap those methods in `nodeRepl.write` or
`nodeRepl.emitImage`. Use `var` for reusable REPL bindings.

Browser AX reads request canonical full state and include an `Observation`
header with `kind: "full"`, a snapshot identity, and `baseline: null`. Each
replaces the previous tree, including when `disableDiffing: false` is passed.
DOM-only tabs use the provider's full `playwright.domSnapshot()` unchanged,
without Farstep AX revision metadata. Missing metadata does not imply a diff.

Provider APIs return values without displaying them. For example, use
`nodeRepl.write(await tab.playwright.domSnapshot())` to display a DOM snapshot,
or `nodeRepl.emitImage(await tab.screenshot({}))` for a provider screenshot.
Emit returned text and images explicitly unless the provider documents
automatic output. An empty tool result does not mean the page is empty.

Read state before input and observe afterward. DOM-only tabs have no numeric
accessibility indices. Use their documented `tab.playwright` locators rather
than inventing indices or falling back to native input. This is not the full
external Playwright API. Navigation, capabilities, and lifecycle methods vary
by provider. Discover capabilities at the browser or tab scope that owns them
and read their documentation before use. For the bundled reference, call
{{guideTool}} with {{apiGuide}}.

## Preauthorize raw CDP before execution

Ordinary page and CDN asset loading does not require raw CDP approval. The
`cdp` capability has a separate, origin-scoped permission gate. Enabling the
capability alone does not grant permission to use it.

The configured browser policy preauthorizes HTTP and HTTPS origins through
the bundled runtime's saved permissions in `CODEX_HOME/browser/config.toml`
(`~/.codex/browser/config.toml` by default):

```toml
full_cdp_access_enabled = true

[full_cdp]
allowed = ["*"]
```

Use narrower origin patterns when broad web-origin access is not intended.
The upstream gate validates HTTP(S) origins before applying this wildcard,
which also covers non-default web ports.
Saved denials and managed browser policy still take precedence. These grants
do not authorize uploads, authentication, WebMCP, or native desktop input.

Farstep does not ask the agent to assert that a user approved an individual
request. Requests without a saved grant remain blocked with a configuration
error. Change the policy only when the user authorizes configuration changes,
not as a workaround for a rejected action. Start a new Sky runtime after
changing saved permissions.

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
