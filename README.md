# dsh-plugin-browser-control

English | [中文](README.zh.md)

Give a [DSH (DeepSeek-Harness)](https://github.com/deepseek-ai/deepseek-harness) agent control over the app's **own built-in browser** — the `Browser` tab in the right Sidebar — instead of spawning a separate headless Chromium.

DSH ships `@deepseek-ai/dsh-client-ui-sidebar-browser`, which is presentation-only. Its README states plainly that the browser tab registers *no tool, no prompt section, no session event*. This plugin supplies the missing half: a `browser_control` agent tool plus a page-side executor.

## Why not Playwright / a headless browser

| | this plugin | headless Chromium |
|---|---|---|
| what the user sees | the tab they are already looking at | nothing |
| session / login state | the real browser session | fresh profile, log in again |
| extra download | none | ~150 MB browser binary |
| works behind the user's proxy | yes | usually not |

It is a *supervised* browser: the user watches every action happen.

## Actions

| action | what it does |
|---|---|
| `open` | Open a URL; reuses the visible tab, opens one if there is none |
| `navigate` | Navigate the current tab |
| `back` / `forward` / `reload` | Native navigation history |
| `read` | Title + visible text + links (truncation capped) |
| `evaluate` | Run an async function body inside the page, return JSON |
| `click` | CSS selector → scroll into view + full pointer/mouse event chain; reports the page after navigation |
| `fill` | Write into `input`/`textarea`/`select`; uses the native setter so React/Vue controlled components update |
| `hover` | Fire the hover event chain (opens hover menus) |
| `press` | Dispatch a `KeyboardEvent` (default `Enter`) to a selector or the focused element |
| `screenshot` | `capturePage()` → PNG, admitted through the attachment store so the model can see it |
| `status` | What the current tab is showing |
| `list` | Every browser tab with its index |

Most actions accept `tab` to target a specific tab by index (see `list`), which matters on sites that open the next page in a new window.

## How it works

```
agent tool call
      │
      ▼
Host plugin (index.js) ── registers ctx.tools + two webServer routes
      │  GET  /browser-control/next    (page long-polls for a command)
      │  POST /browser-control/result  (page returns the result)
      ▼
Client plugin (client.js) ── runs in the app renderer
      │  finds [data-sidebar-browser-frame] → <webview> (Desktop) / <iframe> (Web)
      ▼
page does the work, returns plain JSON
```

Both routes are gated by `ctx.connection.requestRejection()`, the same trust fence `dsh-host-open-in-app` uses: only the app's own authenticated origin may poll or report.

Screenshots go through `attachments.saveImages()`, so image bytes never enter the transcript's text blocks.

## Install

DSH Desktop owns its profile exclusively, so the CLI refuses (`profile "desktop" is managed exclusively by the Electron application`). Install from the GUI instead:

1. Sidebar → **Plugins**
2. **Add plugin** → **Install a third-party plugin**
3. Paste either the npm name `dsh-plugin-browser-control`, or the absolute path to a checkout
4. Confirm the `browser-control` row is live (both the Host row and the Client row), then restart the app

## Requirements and limits

- **Desktop only for full capability.** Desktop drives an Electron `<webview>` with the complete guest API. The Web profile uses a cross-origin sandboxed `<iframe>`, where text cannot be read back and `capturePage()` does not exist.
- **Needs a live app window.** Commands are claimed by a page that long-polls; with no page connected the call times out and says so.
- **Screenshots require the tab to be visible.** Electron answers `capturePage()` for a hidden guest with the app window or an error, so the plugin reveals the tab first. Keep the Browser tab on screen.
- **Sites can refuse embedding.** `X-Frame-Options` / CSP block some origins. Downloads, native file pickers and `alert()` are denied by the Desktop main process.
- **No privilege escalation.** The guest runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. This plugin only uses the public `<webview>` API from the renderer — it injects nothing into the main process.
- **Viewport screenshots only.** A webview cannot stitch a scrolled page.
- **Single window.** One FIFO queue per Host process; the first connected page to poll claims the command.
- **Editing `client.js` requires an app restart** — the page has no file watcher for installed bundles.

## Development

```
index.js        Host half: tool definition, command bus, HTTP routes
client.js       Client half: polls the routes, drives the carrier
define-tool.js  vendored defineTool (the plugin is linked outside the host's
                node_modules, so a bare @deepseek-ai/dsh-tools import fails to
                resolve; see the comment at the top of that file)
cordis.patch.yml inserts the loader row
```

No build step, no dependencies at runtime — plain ESM.

## License

MIT
