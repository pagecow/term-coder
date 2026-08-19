# Term Coder — ChatOSS .aip project

You are building a ChatOSS `.aip` app in the project folder `com.example.term-coder`.
The complete, current guide for building ChatOSS apps follows. It is the
authoritative API contract — follow it exactly and do not invent APIs that
are not documented here.

---

# How to build a ChatOSS app (.aip)

You are building an app for **ChatOSS**, a desktop "operating system for AI work." Follow this guide exactly — it is the complete, current contract.

## What a .aip is

A ChatOSS app is a **folder of plain HTML, CSS, and JavaScript** with an `app.json` manifest, **zipped**, with the zip named `<anything>.aip`. No frameworks, no build step, no npm, no server. The user installs it by dropping the file onto ChatOSS's Apps app; it appears in their dock with its icon and runs in a sandboxed window.

Deliver your work as the individual files (clearly labeled with their paths), plus the instruction: "zip these files (they must sit at the zip root), rename the zip to `yourapp.aip`, and drop it on the ChatOSS Apps app."

**If you are running inside ChatOSS's Code app**, you have an extra ability: a `publish_app` tool that installs the finished app directly into the user's dock — no manual zip/drop needed. The user gets a Publish / Cancel prompt; on Publish the folder is zipped, validated, and installed (same pipeline as dropping a .aip on the Apps app). When the app is done, **ask the user if they'd like you to publish it now** rather than only handing them zip instructions, and call `publish_app` with the app folder's path if they say yes.

## Folder structure

```
my-app/
├── app.json      ← manifest (REQUIRED, at the root)
├── index.html    ← entry point (REQUIRED; the name is configurable via "entry")
├── main.js       ← any JS/CSS/images, any names, any subfolders
├── style.css
├── icon.svg      ← the dock icon (recommended)
└── libs/         ← vendored third-party browser libraries, if needed
```

Files are served at real URLs at runtime, so relative references all work: `<script src="main.js">`, `<link rel="stylesheet" href="style.css">`, `<img src="icon.svg">`, and `fetch('data.json')` (for reading the app's own bundled files).

Constraints:
- `app.json` and the entry HTML must be at the **zip root** (zipping the parent folder is also accepted — one shared root directory is stripped).
- Unpacked size limit: **20 MB**.
- Need a JS library? Vendor its prebuilt browser file into `libs/` and load it with a script tag. There is no npm install.

## app.json — the manifest

```json
{
  "id": "com.you.myapp",
  "name": "My App",
  "version": "1.0.0",
  "description": "One honest sentence about what this app does.",
  "icon": "icon.svg",
  "capabilities": ["chatApi", "fileAccess"],
  "scopedDataKeys": ["myapp.state"],
  "dataStoreRequests": [],
  "toolsStoreRequests": []
}
```

| Field | Required | Rules |
|---|---|---|
| id | yes | Unique, reverse-DNS, **lowercase** letters/digits/dots/dashes only (it becomes a URL host). `com.chatoss.*` is reserved. Reinstalling the same id updates the app in place. |
| name | yes | Shown in the dock and Apps manager. |
| version | yes | Free-form string. |
| description | yes | One line. |
| icon | no | An image file in the folder (PNG/JPEG/WebP/GIF/SVG), square, ≥64×64. Becomes the dock icon. Without it, a letter fallback is used. |
| entry | no | The HTML file to open. Defaults to "index.html". |
| capabilities | no | Array of: "chatApi", "fileAccess", "fileDrop", "terminal", "webSearch", "webview", "notifications", "clipboardRead", "clipboardWrite", "hostHttp", "globalShortcut", "openExternal", "background", "documents". Undeclared capabilities = those APIs are refused at runtime. Declare ONLY what you use. |
| webviewAllowlist | no | Required WITH "webview": array of allowed domains (e.g. ["wikipedia.org", "khanacademy.org"]). The OS restricts every webview window to these hosts (subdomains included). Ignored without the "webview" capability. |
| httpAllowlist | no | Required WITH "hostHttp": array of allowed domains (e.g. ["api.example.com"]). Requests are restricted to these hosts (subdomains match) AND to public IPs — a Rust SSRF guard blocks localhost/private/cloud-metadata even if a listed domain resolves there, and redirects aren't followed. Ignored without "hostHttp". |
| shortcuts | no | Required WITH "globalShortcut": array of accelerators (e.g. ["CmdOrCtrl+Shift+K"]) the app may register as system-wide hotkeys. First registration of each prompts. Ignored without "globalShortcut". |
| openExternalAllowlist | no | With "openExternal": http/https hosts (subdomains match) the app may open in the default browser. Enforced in Rust (scheme http/https/mailto only — never file:// or a local path). Optional — mailto: links always work. Ignored without "openExternal". |
| backgroundTasks | no | Required WITH "background": array of { "id", "name"?, "description"?, "trigger" } the app may run while its window is closed (max 8). `trigger` is one of { "type": "manual" } · { "type": "interval", "minutes": n } (floored to 5) · { "type": "daily", "hour": 0-23, "minute": 0-59 } · { "type": "weekly", "weekday": 0-6, "hour", "minute" } (0 = Sunday). Ignored without "background". |
| scopedDataKeys | no | The private storage keys you use (documentation; private storage never prompts). |
| dataStoreRequests | no | Only to WRITE shared OS-wide data: array of { "key", "what", "why" } — shown verbatim in the user's approval prompt. |
| toolsStoreRequests | no | Only to publish a tool to ChatOSS's own agents: array of { "toolName", "description", "why" }. Rare. |

## The runtime API — window.chatoss

The app runs in a sandboxed iframe. `window.chatoss` is injected before your code runs; it is the ONLY bridge to the OS. **Every method returns a Promise — always await.**

### Private storage (no capability, never prompts)

```js
await window.chatoss.scopedData.set('myapp.state', anyJsonValue);
const value = await window.chatoss.scopedData.get('myapp.state'); // undefined if unset
await window.chatoss.scopedData.delete('myapp.state');
```

Persists across launches, private to this app. Use this for all app state unless other apps must read it.

### AI chat (capability: "chatApi", no prompt)

Build an in-app model picker from ChatOSS's credential-free model list. Never ask for or handle API keys:

```js
const models = await window.chatoss.chat.listModels();
// [{ id, name, source: 'local'|'cloud'|'custom', capabilities,
//    contextLength, available, unavailableReason? }]
const defaultModel = await window.chatoss.chat.getDefaultModel();

// Show models in your own <select>; disable rows where available is false.
// Save the chosen opaque id in your app/project state, then pass it explicitly:
const result = await window.chatoss.chat.runTurn({
  model: selectedModelId || defaultModel,
  messages: [                       // REQUIRED. Roles: system | user | assistant
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Hello' }
  ],
  onToken: (t) => { out.textContent += t; },   // streamed reply chunks — use for live UI
  onThinking: (t) => {},            // streamed reasoning, when the model exposes it
  tools: TOOLS,                     // optional function-calling (see below)
  onToolCall: async (call) => '…',  // executes your tools; return a STRING result
  think: true,                      // optional: ask the model to reason first
  signal: abortController.signal    // optional: abort() stops the turn
});
// result = { content, thinking, toolCalls, usage?, aborted }
```

- If `model` is omitted, the app-wide ChatOSS default answers.
- `listModels()` exposes model ids and display metadata only — never credentials, tokens, or account details.
- Multi-turn memory = keep your own messages array and send all of it each turn.
- Your app's chats see ONLY the tools you pass — never the user's other tools.

Function calling: describe tools with JSON schema; the engine loops automatically (model calls tool → your onToolCall returns a string → model continues, up to 8 rounds).

### Web (capability: "webSearch")

Declare `"webSearch"` and the model can call the OS's `web_search` / `web_fetch` tools during a `chat.runTurn` — ChatOSS answers them itself (your `onToolCall` is not called for them). You can also search directly:

```js
const results = await window.chatoss.web.search('latest Ollama release', 5); // -> [{ title, url, content }]
const page = await window.chatoss.web.fetch('https://example.com');           // -> { title, content, links }
```

Web access rides the user's backend (a signed-in Ollama account, or a paid ChatOSS plan). When neither is available, the tools aren't advertised and `web.search`/`web.fetch` reject with a clear error.

### Webview — open real websites (capability: "webview")

An app runs in a sandboxed iframe, so embedding another site with `<iframe src="https://…">` only works for sites that permit framing — any site sending `X-Frame-Options: DENY/SAMEORIGIN` or a CSP `frame-ancestors` renders blank, and there is no client-side way around it. To build a browser / kiosk / kid-safe app that opens real sites, declare the `"webview"` capability plus a `"webviewAllowlist"`, then open a real top-level window:

```js
// app.json: { "capabilities": ["webview"], "webviewAllowlist": ["wikipedia.org", "khanacademy.org"] }
const { id } = await window.chatoss.webview.open({ url: 'https://en.wikipedia.org', title: 'Wikipedia' });
// …later:
await window.chatoss.webview.close(id);
```

The window's navigation is locked to your `webviewAllowlist` **at the OS level** (enforced in Rust): a click or redirect to any host not on the list is cancelled before it loads — a real firewall your page JS can't widen or escape. Because it's a top-level window (not an iframe), sites that refuse framing load fine. `open()` rejects if the URL's host isn't on the allowlist. This is the ONLY way to enforce a navigation allowlist — a JS-only allowlist inside an iframe is not a security boundary.

### Embedded web views — real web pages INSIDE your app (capability: "webview")

Same capability + allowlist, but the page renders **inside your own layout** instead of a separate window — this is how you build in-app browser tabs, embedded dashboards, or doc panes. The easy path is `mount(element, {url})`, which glues a real web view to one of your DOM elements and keeps it there as the window scrolls/resizes:

```js
// app.json: { "capabilities": ["webview"], "webviewAllowlist": ["wikipedia.org"] }
const box = document.getElementById('viewport');          // any element you sized in your layout
const view = window.chatoss.webview.mount(box, { url: 'https://en.wikipedia.org' });
await view.ready;                                          // resolves to { id }
view.onEvent(({ url, loading }) => { /* update a URL bar / spinner / tab title */ });
await view.navigate('https://en.wikipedia.org/wiki/Cat'); // load another allowed URL
// view.close() removes it and stops tracking.
```

For finer control (e.g. many tabs sharing one area), use the primitives directly:

```js
const { id } = await window.chatoss.webview.embed({ url, rect: { x, y, width, height } }); // rect = your element's box (CSS px)
await window.chatoss.webview.setBounds({ id, rect });   // call on scroll/resize to keep it glued
await window.chatoss.webview.navigate({ id, url });
await window.chatoss.webview.goBack(id);   // also goForward(id), reload(id)
window.chatoss.webview.on(id, ({ url, loading }) => { /* … */ });
await window.chatoss.webview.close(id);
```

🔴 The embedded view is a **native layer that floats ABOVE your DOM** — it does not clip to rounded corners and nothing (menus, modals) can overlay it. Reserve a clear rectangle for it, and hide it (`setBounds` offscreen, or `close`) when you show UI on top. Same OS-enforced allowlist firewall as `open` — an app can never point an embedded view off its `webviewAllowlist`.

### Notifications (capability: "notifications"; prompts on first use)

Declare `"notifications"` and post an OS notification banner:

```js
// app.json: { "capabilities": ["notifications"] }
const shown = await window.chatoss.notifications.send({ title: 'Build finished', body: 'All 42 tests passed.' });
// shown === true if dispatched, false if the user denied.
```

The first send prompts the user once (Allow once / Allow always / Deny); an app the user has marked **Trusted** in the Apps manager sends without prompting. On macOS the app also needs the system notification permission, which ChatOSS requests the first time.

### Clipboard (capabilities: "clipboardRead" / "clipboardWrite"; no prompt)

Read and write are SEPARATE capabilities — declare only what you use. A "copy" button needs just `"clipboardWrite"`; `"clipboardRead"` is more sensitive (it sees whatever the user last copied, which could be a password), so request it only if you genuinely need to paste in.

```js
// app.json: { "capabilities": ["clipboardRead", "clipboardWrite"] }
const wrote = await window.chatoss.clipboard.writeText('Copied from my app!'); // resolves true
const text  = await window.chatoss.clipboard.readText();                       // resolves the clipboard text
```

Clipboard is a low-friction convenience, so it does NOT prompt (only terminal, files, and notifications warn at install / ask on first use). The user can still turn either capability off any time from the app's **Permissions** panel (the **⋯ menu → Settings** on the app's row in the Apps manager); a turned-off call rejects, so wrap clipboard calls in try/catch.

### Host HTTP — call any REST/GraphQL API (capability: "hostHttp"; no prompt)

Your sandboxed iframe is subject to CORS, so `fetch()` to most third-party APIs fails. Declare `"hostHttp"` + an `"httpAllowlist"` and make requests through the OS with NO CORS, restricted to the domains you list:

```js
// app.json: { "capabilities": ["hostHttp"], "httpAllowlist": ["api.github.com"] }
const res = await window.chatoss.http.request({
  url: 'https://api.github.com/repos/ollama/ollama',
  method: 'GET',                       // default GET; POST/PUT/PATCH/DELETE/HEAD too
  headers: { Accept: 'application/vnd.github+json' },
  // body: JSON.stringify({ … }),      // set your own Content-Type header
});
// res = { status, headers, body }; body is text — JSON.parse it yourself.
```

The allowlist is enforced **in Rust**: a request to a host you didn't list is refused, and so is any request that resolves to a **private / loopback / link-local / cloud-metadata** address (an SSRF guard — an app can never reach `localhost` or `169.254.169.254`, even through a listed domain that resolves there). **Redirects are not followed** (you get the 3xx + `Location` back). It's a real boundary your page JS can't widen — the allowlist comes from your manifest, not your code.

### Global shortcuts (capability: "globalShortcut"; prompts per accelerator)

Register a system-wide hotkey that fires even when your app isn't focused (a launcher, quick-capture tool, etc.). List the accelerators in `"shortcuts"`, then register one with a callback:

```js
// app.json: { "capabilities": ["globalShortcut"], "shortcuts": ["CmdOrCtrl+Shift+K"] }
const ok = await window.chatoss.shortcuts.register('CmdOrCtrl+Shift+K', () => {
  // fires on every press, even when another app is focused
});
// later: await window.chatoss.shortcuts.unregister('CmdOrCtrl+Shift+K');
```

You can only register accelerators you listed in `"shortcuts"`. The first registration of each prompts the user once (`ok` is `false` if they deny). Shortcuts are released automatically when your app closes.

### Open external links (capability: "openExternal")

Hand a URL to the user's default browser or mail client — a "read more on the web" link, an OAuth start page, a support email, etc. List the web hosts you'll open in `"openExternalAllowlist"` (`mailto:` always works):

```js
// app.json: { "capabilities": ["openExternal"], "openExternalAllowlist": ["example.com"] }
await window.chatoss.openExternal.open('https://example.com/docs');
await window.chatoss.openExternal.open('mailto:support@example.com?subject=Help');
```

Only `http`/`https` (to a listed host) and `mailto:` open — `file://`, other schemes, and off-list hosts are refused in Rust, so an app can't launch a local file/executable or reach an unlisted site.

### Background tasks (capability: "background"; prompts on first use)

Run work on a schedule **while your app's window is closed** — sync, poll, a daily digest. Declare the tasks in `"backgroundTasks"` (this list is the ceiling; app code can't invent a new schedule), then register ONE handler at load. ChatOSS fires a due task by mounting your app **headless** (offscreen, no UI), calling your handler with the task id, and disposing it when the handler resolves:

```js
// app.json: {
//   "capabilities": ["background", "hostHttp"],
//   "httpAllowlist": ["api.example.com"],
//   "backgroundTasks": [{ "id": "sync", "name": "Sync inbox", "trigger": { "type": "interval", "minutes": 30 } }]
// }
window.chatoss.background.onTask(async (taskId) => {
  if (taskId === 'sync') {
    const res = await window.chatoss.http.request({ url: 'https://api.example.com/inbox' });
    await window.chatoss.scopedData.set('inbox', JSON.parse(res.body));   // persists for the next window open
  }
});
```

- **Triggers:** `{ type: "interval", minutes }` (floored to 5), `{ type: "daily", hour, minute }`, `{ type: "weekly", weekday, hour, minute }` (0 = Sunday), or `{ type: "manual" }` (runs only when the user hits **Run now** in the app's Activity view). Max 8 tasks.
- **Keep runs SHORT and idempotent.** There's a per-run time budget (~30–60s) — over it, the run is force-disposed. One run at a time per task; a slow run doesn't stack.
- **Your WHOLE app boots for each headless run** — index.html runs top to bottom with no window. Gate load-time side effects (auto-running checks, sounds, notification sends) with `const headless = await window.chatoss.background.isHeadlessRun()`; a headless boot should register `onTask` and nothing else.
- **What works headless:** `scopedData`/`data`, `http`, `chat.runTurn`, `web`, `notifications`, `clipboard.writeText`. **What refuses/no-ops (no window):** `webview`, `files` (drops, dialogs, read/write), `shortcuts`, `terminal`, `clipboard.readText`, `openExternal`, global `tools.register`. Store results in `scopedData` and render them the next time the window opens.
- **Honest scheduling:** tasks fire only while **ChatOSS itself is running** (the window being closed is fine; a full quit — ⌘Q / Ctrl+Q — is not). A schedule missed while ChatOSS was quit fires on the next launch. This is a desktop app, not a server.
- **Consent:** `"background"` is disclosed on the install screen (with each task's schedule) and prompts once on first fire (Allow once / always / Deny; a **Trusted** app skips the prompt). The user can switch it off any time in **Permissions** — that stops all the app's tasks immediately.
- **Users can watch and trigger tasks too:** **Apps → Background activity** lists every declared task's schedule, live status, and run history, with a **Run now** button — design handlers to be safe to run twice, since a manual fire can land right next to (or instead of) a scheduled one.

```js
const TOOLS = [{
  type: 'function',
  function: {
    name: 'add_item',
    description: 'Add one item to the list.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  }
}];
const result = await window.chatoss.chat.runTurn({
  messages: [
    { role: 'system', content: 'Manage the list with tools. Current list:\n' + serialize() },
    { role: 'user', content: userAsk }
  ],
  tools: TOOLS,
  onToolCall: async (call) => {
    const args = call.function.arguments;      // ALREADY PARSED to an object
    if (call.function.name === 'add_item') { addItem(args.text); return 'Added ' + args.text; }
    return 'Error: unknown tool';
  }
});
```

Include the app's current state in the system message — the model can only act on what it sees.

### Files (capability: "fileAccess"; first use prompts the user once)

```js
const path = await window.chatoss.files.saveDialog({
  defaultPath: 'export.txt',
  filters: [{ name: 'Text', extensions: ['txt'] }]
});                                              // null = cancelled/denied — ALWAYS check
await window.chatoss.files.writeFile(path, contents);
// contents: string OR binary (ArrayBuffer / typed array / Blob — e.g. jspdf output)

const openPath = await window.chatoss.files.openDialog({ filters: [...], multiple: false });
const text = await window.chatoss.files.readFile(openPath);   // text only
const folder = await window.chatoss.files.pickFolder();       // null if cancelled
```

Drag-and-drop needs capability "fileDrop" (no prompt — dropping is the user's action):

```js
window.chatoss.files.onDrop(async (files) => {
  // each file: { name, type, size, text(): Promise<string>, arrayBuffer(): Promise<ArrayBuffer> }
  const content = await files[0].text();
});
```

There is no directory listing and no path access outside user-driven dialogs/drops.

### Documents (capability: "documents"; no prompt — declare only)

Generate **real** PDF, Word, Excel, PowerPoint, JPG, and PNG files through the OS — no vendored library, no build step, and no `window.print()` (which is BLOCKED in the sandboxed iframe, since the sandbox grants no `allow-modals`). The OS bundles the generators (jspdf, xlsx, docx, pptxgenjs) and builds the bytes in the host; you write them to disk with the File API — or use the one-call `save()` helper.

```js
// app.json: "capabilities": ["documents", "fileAccess"]

// The simplest PDF — give it text, get back bytes, save them:
const { bytesB64 } = await window.chatoss.documents.generate({
  type: 'pdf',
  content: { title: 'Report', paragraphs: ['First paragraph.', 'Second paragraph.'] }
});
const path = await window.chatoss.files.saveDialog({
  defaultPath: 'report.pdf',
  filters: [{ name: 'PDF', extensions: ['pdf'] }]
});
if (path) await window.chatoss.files.writeFile(path, window.chatoss.documents.base64ToBytes(bytesB64));

// Or the one-call helper (generate + save dialog + write → path | null):
const saved = await window.chatoss.documents.save({
  type: 'xlsx',
  content: { sheets: [{ name: 'Q1', rows: [['Item', 'Qty'], ['Widget', 42]] }] },
  defaultPath: 'q1.xlsx'
});
```

Supported `type` values and their `content` shapes:

| type | content | notes |
|------|---------|-------|
| `pdf` / `docx` | `{ title?, blocks?, paragraphs?, text? }` | see the two shapes below — `blocks` keeps formatting, `paragraphs`/`text` are plain |
| `xlsx` | `{ sheets?: { name?, rows: (string\|number\|boolean\|null)[][] }[] }` | one+ worksheets of rows |
| `pptx` | `{ title?, slides?: { title?, bullets?: string[] }[] }` | one slide per entry |
| `jpg` / `png` | `{ image: string }` | `image` = a data URL or http(s) URL, re-encoded |

- `generate()` returns `{ bytesB64, ext, mimeType }`. Decode with `documents.base64ToBytes(bytesB64)` and pass to `files.writeFile`.
- `save({ type, content, defaultPath? })` does generate + save dialog + write in one call and resolves the chosen path (null if cancelled/denied). It needs BOTH `documents` and `fileAccess`.
- This is the EASIEST way to create documents. For full layout control you may still vendor your own library (jspdf, SheetJS, docx, pptxgenjs) and generate bytes in the iframe — see the Docs app's "Generating documents" page.

#### PDF / DOCX content — two shapes (READ THIS before formatting documents)

The PDF and DOCX generators accept **two** content shapes. Use the one that matches how your content is structured, or the **exported file's formatting will not match what your app's editor/preview shows** — this is the most common document bug.

**Shape 1 — plain text (simplest, no formatting):** `{ paragraphs?: string[], text?: string }`. Every paragraph becomes one unstyled line of body text. There is NO bold, italic, headings, or list support in this shape — pass markdown or HTML here and it will be rendered as literal text, NOT formatted. Use this only when your content is genuinely plain text.

```js
content: { title: 'Notes', paragraphs: ['First paragraph.', 'Second paragraph.'] }
// or a single blob split on line breaks (a single "
" or a blank line each
// end a paragraph — so a <textarea>'s newline-separated lines stay separate):
content: { title: 'Notes', text: 'First paragraph.\n\nSecond paragraph.' }
content: { title: 'Notes', text: 'Line one\nLine two\nLine three' } // → 3 paragraphs
```

**Shape 2 — structured blocks (keeps formatting — use this for any rich content):** `{ blocks: DocumentBlock[] }`. This is how headings, inline bold/italic/underline, and bullet/numbered lists survive from your app's editor/preview into the exported file, so "what you see is what you get." `blocks` takes precedence over `paragraphs`/`text` when present.

A `DocumentBlock` is one of:
- `{ type: 'heading', level: 1|2|3, text: string }` — a section heading.
- `{ type: 'paragraph', runs: TextRun[] }` — a paragraph of styled inline runs.
- `{ type: 'list', list: { type: 'bullet'|'number', items: (string|TextRun[])[] } }` — a list; each item is a plain string or its own array of runs.

A `TextRun` is either a plain `string` (unstyled) or `{ text: string, bold?: true, italic?: true, underline?: true }`. Build paragraphs and list items from runs to carry inline formatting.

```js
content: {
  title: 'Project Brief',
  blocks: [
    { type: 'heading', level: 1, text: 'Overview' },
    { type: 'paragraph', runs: [
        { text: 'This is ' },
        { text: 'bold', bold: true },
        { text: ' and ' },
        { text: 'italic', italic: true },
        { text: ' and ' },
        { text: 'underlined', underline: true },
        { text: ' inline text.' }
    ]},
    { type: 'heading', level: 2, text: 'Tasks' },
    { type: 'list', list: { type: 'bullet', items: [
        'Design the UI',
        'Build the API',
        [{ text: 'Ship it: ', bold: true }, { text: 'by Friday' }]   // mixed-style item
    ]}},
    { type: 'list', list: { type: 'number', items: [
        'First step', 'Second step', 'Third step'
    ]}}
  ]
}
```

🔴 **Why the exported file's formatting won't match your preview (and how to fix it).** Your app's editor/preview renders HTML/CSS in the iframe. The documents API does **not** take HTML — it takes the `blocks`/runs structure above and rebuilds the layout in its own renderer. So the export only matches the preview when you convert your editor's content to `blocks` before calling `generate()`. The four mistakes that make exports look wrong:

1. **Passing rich content as plain text.** `paragraphs: ['**Hello** world']` or `text: '<b>Hello</b> world'` — the API does NOT parse markdown/HTML, so `**Hello**` / `<b>Hello</b>` appears literally. Fix: convert to `blocks` → `{ type: 'paragraph', runs: [{ text: 'Hello', bold: true }, { text: ' world' }] }`.
2. **Concatenating the whole document into one `text` blob.** Headings and lists in a `text` blob are lost (everything is one unstyled paragraph run). Fix: emit one `block` per heading/paragraph/list.
3. **Dropping the space between styled runs.** Two runs `[{ text: 'bold', bold: true }, { text: 'word' }]` render as "boldword" — there is no auto-space between runs. Put the space inside a run: `[{ text: 'bold ', bold: true }, { text: 'word' }]`.
4. **Expecting styles the API doesn't support.** Only bold, italic, underline (and headings/lists) carry over — no colors, fonts, alignment, or font sizes beyond the built-in heading/title sizes. For pixel-perfect layout, vendor your own library (jspdf/docx) and build the bytes yourself.

**Converting your editor's HTML to blocks (the word-document-creator pattern):** walk your editor's DOM and emit one `DocumentBlock` per element. A minimal converter:

```js
function editorToBlocks(rootEl) {
  const blocks = [];
  for (const el of rootEl.childNodes) {
    if (el.nodeType === 3) { // text node
      const t = el.textContent;
      if (t.trim()) blocks.push({ type: 'paragraph', runs: [{ text: t }] });
      continue;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      blocks.push({ type: 'heading', level: Number(tag[1]), text: el.textContent });
    } else if (tag === 'ul') {
      blocks.push({ type: 'list', list: { type: 'bullet', items: [...el.children].map(li => htmlToRuns(li)) } });
    } else if (tag === 'ol') {
      blocks.push({ type: 'list', list: { type: 'number', items: [...el.children].map(li => htmlToRuns(li)) } });
    } else if (tag === 'p') {
      blocks.push({ type: 'paragraph', runs: htmlToRuns(el) });
    } else if (el.textContent.trim()) {
      blocks.push({ type: 'paragraph', runs: [{ text: el.textContent }] });
    }
  }
  return blocks;
}
// Recursively turn an element into styled runs, mapping <b>/<strong>→bold,
// <i>/<em>→italic, <u>→underline.
function htmlToRuns(el) {
  const runs = [];
  for (const node of el.childNodes) {
    if (node.nodeType === 3) { runs.push({ text: node.textContent }); continue; }
    const child = htmlToRuns(node);
    const tag = node.tagName.toLowerCase();
    const style = tag === 'b' || tag === 'strong' ? { bold: true }
      : tag === 'i' || tag === 'em' ? { italic: true }
      : tag === 'u' ? { underline: true } : {};
    child.forEach(r => Object.assign(r, style));
    runs.push(...child);
  }
  return runs;
}
// Then: generate({ type: 'docx', content: { title, blocks: editorToBlocks(editor) } })
```

🔴 **Formatting rules (so the export matches your preview):**
- The documents API does **not** parse markdown or HTML. If your app's editor produces markdown or HTML, convert it to `blocks`/runs yourself before calling `generate()` (see the converter above) — a markdown `**bold**` or `<b>bold</b>` passed as a plain `paragraph` string will appear literally, not bold.
- Pass one block per logical heading/paragraph/list item. Do not concatenate a whole document into a single `text` blob if it has headings or lists — those will be lost.
- Put spaces inside runs; the API does not insert a space between adjacent runs.
- Supported inline styles are **bold, italic, underline** only (no colors, fonts, or sizes beyond the built-in heading/title sizes). For pixel-perfect layout, vendor your own library (Tier 1 below).
- A `heading` becomes a real Word heading style (DOCX) / a bold larger line (PDF); a `list` becomes real Word bullet/numbering (DOCX) / a bullet or "1." marker (PDF).

### Terminal (capability: "terminal"; EVERY command prompts until the user allows that program)

```js
const result = await window.chatoss.terminal.exec('git status', { cwd: null, timeoutMs: 30000 });
// null = user denied. Otherwise: { output, exitCode, timedOut, cancelled }
```

Full machine access — request it only if the app genuinely needs to run programs. "Allow always" is scoped to the command's first word (e.g. approving `git` never covers `rm`).

### Shared data across apps (usually skip this)

```js
const v = await window.chatoss.data.get('some.key');          // any app may read any key
const ok = await window.chatoss.data.set('myapp.public', v);  // needs dataStoreRequests entry + user approval
window.chatoss.data.onChanged('some.key', (v) => render(v)); // fires until the app closes
```

### Publishing a tool to ChatOSS's own agents (advanced, usually skip)

```js
await window.chatoss.tools.register(toolDef, async (args) => 'result');
// Needs a toolsStoreRequests entry + user approval. The handler only answers
// while YOUR app is open; agents calling it when the app is closed get an
// honest "app isn't open" error.
```

### Misc

```js
const manifest = await window.chatoss.manifest.get();   // your own app.json
```

`fetch()` to the internet works like on any web page (subject to the remote server's CORS).

## Permissions model (what the user experiences)

- chatApi, fileDrop, webSearch, documents: declared in the manifest, never prompt.
- fileAccess: one prompt on first use (Allow once / always / Deny). Denied dialogs return null.
- terminal: prompts per command with the exact command shown; "always" is per program.
- webview: no per-call prompt — the manifest's webviewAllowlist IS the boundary (shown to the user and OS-enforced), so windows can only reach the domains you declared.
- notifications: prompts once on first send (Allow once / always / Deny); send() returns false if denied.
- clipboardWrite / clipboardRead: NO prompt — a low-friction convenience. The user can still turn either off any time in the app's Permissions panel; a disabled call rejects.
- hostHttp: NO prompt — the httpAllowlist IS the boundary (enforced in Rust + an SSRF guard). Requests off the list, or to private/loopback/metadata addresses, are refused.
- globalShortcut: prompts once per accelerator on first registration (a system-wide hotkey); register() returns false if denied.
- openExternal: NO prompt — restricted to the manifest's openExternalAllowlist (http/https) + mailto, enforced in Rust; file:// and off-list hosts are refused.
- background: disclosed on the install screen (with each task's schedule) and prompts once on first fire (Allow once / always / Deny; a Trusted app skips it). Bounded to the manifest's backgroundTasks; switching it off in Permissions stops every task immediately.
- data.set / tools.register: prompt quoting your manifest's "what"/"why".
- Updates: a new .aip with the same id that adds ANY new capability shows the user the exact additions; write complete manifests from v1.
- ANY capability can be switched off by the user at any time from the app's Permissions panel (the ⋯ menu → Settings on its row in the Apps manager) — even ones that never prompt. Treat every window.chatoss call as fallible.

Handle null/false results and rejections from every gated call gracefully — denial (or a turned-off capability) must not break the app.

## Design guidance — use the ChatOSS app pattern

For most project- or collection-based apps, copy ChatOSS Kanban's three-column architecture:

1. **Left — project library:** create/select/rename/delete projects or durable workspaces.
2. **Middle — project AI chat:** show a model picker from `chat.listModels()`, keep chat history per project, include a fresh selected-project snapshot in the system message, and expose complete CRUD tools for everything the user can change.
3. **Right — app canvas:** the product-specific surface (sticky notes, board, editor, diagram, preview, etc.). Usually this is the only column that should fundamentally change between apps.

Small single-purpose utilities may omit the pattern, but it is the default. The canonical Docs example is Sticky Notes and should be used as the visual/architectural reference.

- Use a light, clean default (system-ui font, hairline borders, rounded corners, one accent color), AND define dark colors under `@media (prefers-color-scheme: dark)`. ChatOSS Light/Dark/Auto flows through that media query.
- Stream AI output with onToken — never a spinner followed by a wall of text.
- Disable buttons while work is running; show a short status line.
- The app must work by hand too — treat AI as an alternative interface to the same data.
- Agent tools must be complete and orthogonal: create/read/update/delete plus any domain actions the UI supports. Return truthful result strings and never let the model claim an unconfirmed mutation.

## Checklist before delivering

1. app.json is valid JSON with id (lowercase reverse-DNS), name, version, description; capabilities has ONLY what the code uses.
2. Entry HTML references your files with plain relative paths.
3. Every window.chatoss call is awaited; every gated call handles null/denied.
4. State persists via scopedData and restores on launch.
5. If the app has chat, the user can choose a model from `chat.listModels()` and the choice persists per project/workspace.
6. Project/collection apps follow library → CRUD agent → product canvas, and the agent can perform every mutation available by hand.
7. Light and dark palettes both exist via `prefers-color-scheme`.
8. An icon file exists and is named in "icon".
9. If the app exports documents (PDF/Word/Excel/PowerPoint/image): use the OS `documents` API (no vendored library, no `window.print()` — it's blocked in the sandbox). Declare "documents" (+ "fileAccess" if you use `documents.save()`). For PDF/DOCX with any formatting (bold, italic, headings, lists), pass the content as `content.blocks` (structured blocks + styled runs) — NOT plain `paragraphs`/`text`, which strips formatting. See the Documents section above.
10. If you are NOT in ChatOSS Code: give zip instructions — files at zip root → rename to .aip → drop on the Apps app.
11. If you ARE in ChatOSS Code: ask the user whether they'd like to publish the app now, and call `publish_app` with the app folder path if they agree. (See the note at the top of this guide.)

## Orchestrate-mode rules (for the orchestrator)

- **Version bumps are release metadata, not implementation.** When merging a batch to main, the orchestrator may edit the version strings DIRECTLY with edit_file — the `"version"` field in app.json AND the `APP_VERSION` constant in app.js (near line 19) — instead of spawning a sub-agent. Treat them like git operations (the orchestrator's own job). The two strings must always match.
- Standing rule (also on the Term Coder backlog board, "Something to always know"): bump the version as part of the SAME push that merges a batch to main — MINOR bump for a batch with features/fixes, PATCH bump for a single tiny fix.
