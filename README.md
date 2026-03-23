# Logseq Web Clipper

A browser extension that clips web pages directly into [Logseq](https://logseq.com) via its HTTP API. Forked from [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) v1.2.1.

## What changed from the upstream

**Replaced — Logseq integration via HTTP API:**
- Saves clips as Logseq pages with `property:: value` metadata via `createPage`
- Structures content as hierarchical blocks via `insertBatchBlock` (headings → parent blocks, paragraphs → children)
- Dedup detection — queries existing clips by `source::` property before saving, warns if URL already clipped
- Append-only clip log (`[[Web Clips Log]]`) with content hashes for dedup and history
- "Update existing" flow — replaces content blocks on an existing page, appends new log entry with `replaces::` pointer
- Settings sync — extension settings stored as JSON in the log page for cross-browser portability
- First-run setup page guiding users through enabling Logseq's HTTP API

**Removed:**
- Obsidian vault concept (Logseq uses graphs)
- `obsidian://` URI scheme integration
- Safari/Xcode build target
- Legacy mode, silent open, beta features toggles
- Overwrite behavior (replaced by dedup/update mechanism)

**Kept from upstream:**
- Content extraction via [Defuddle](https://github.com/kepano/defuddle)
- Template system with variables, filters, and logic
- Highlighter (mark up web pages, save highlights)
- Reader mode (distraction-free reading)
- LLM interpreter (summarize pages via OpenAI, Anthropic, Gemini, Ollama, etc.)
- 100+ filters for template processing
- Side panel and embedded modes

## Install

The extension is not yet on browser stores. Install from source:

### Firefox

1. Clone and build (see [Development](#development) below)
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select any file inside `dist_firefox/`

For permanent installation on Firefox Nightly/Developer Edition:
1. Set `xpinstall.signatures.required` to `false` in `about:config`
2. Go to `about:addons` → gear icon → **Install Add-on From File…**
3. Select the `.zip` from `builds/`

### Chrome / Chromium

1. Clone and build
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked**, select `dist/`

## Logseq setup

The extension connects to Logseq's local HTTP API. On first install, a setup page guides you through these steps:

1. **Enable HTTP API**: In Logseq, go to **Settings → Features** → enable **HTTP APIs Server**
2. **Start the server**: Click the API icon in the toolbar → **Start Server**
3. **Create a token**: In the API panel → **Authorization tokens** → **Add new token** → paste the value into the extension

Optional: enable "Auto start server" in the API panel so it starts with Logseq.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, build, test, and PR instructions.

## Upstream sync

A [monthly GitHub Action](.github/workflows/upstream-check.yml) compares this fork against the upstream Obsidian Web Clipper and opens an issue with categorized changes (security, dependencies, bug fixes) for manual review and cherry-picking.

## Credits

- Forked from [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) by [kepano](https://github.com/kepano)
- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for browser compatibility
- [Defuddle](https://github.com/kepano/defuddle) for content extraction and Markdown conversion
- [dayjs](https://github.com/iamkun/dayjs) for date parsing and formatting
- [lz-string](https://github.com/pieroxy/lz-string) for template compression
- [lucide](https://github.com/lucide-icons/lucide) for icons
- [DOMPurify](https://github.com/cure53/DOMPurify) for HTML sanitization
