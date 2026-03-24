# Logseq Web Clipper

A browser extension that clips web pages directly into [Logseq](https://logseq.com) via its HTTP API.

## Features

- **Clip web pages** — save any page to Logseq as a new page or append to your daily journal
- **Batch clip** — clip all open tabs (or a tab group) in one operation with per-tab template selection
- **Templates** — customizable templates with 100+ filters, variables, logic, and URL-based triggers
- **Highlighter** — mark up web pages and save highlights to Logseq
- **Reader mode** — distraction-free reading view
- **LLM interpreter** — summarize or extract content via OpenAI, Anthropic, Gemini, Ollama, and others
- **Dedup detection** — warns if a URL was already clipped, offers to update the existing clip

## Install

### Firefox

Download the latest `.xpi` from [Releases](https://github.com/clombion/logseq-clipper/releases) and open it in Firefox, or install from file via `about:addons` → gear icon → **Install Add-on From File**.

### Chrome / Chromium

1. Download and unzip `logseq-web-clipper-chrome.zip` from [Releases](https://github.com/clombion/logseq-clipper/releases)
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked**, select the unzipped folder

## Logseq setup

The extension connects to Logseq's local HTTP API. On first install, a setup page guides you through:

1. **Enable HTTP API**: In Logseq → **Settings → Features** → enable **HTTP APIs Server**
2. **Start the server**: Click the API icon in the toolbar → **Start Server**
3. **Create a token**: In the API panel → **Authorization tokens** → **Add new token** → paste into the extension

## Documentation

- [Introduction](docs/Introduction%20to%20Logseq%20Web%20Clipper.md)
- [Clip web pages](docs/Clip%20web%20pages.md)
- [Batch clip web pages](docs/Batch%20clip%20web%20pages.md)
- [Highlight web pages](docs/Highlight%20web%20pages.md)
- [Interpret web pages](docs/Interpret%20web%20pages.md)
- [Templates](docs/Templates.md)
- [Variables](docs/Variables.md)
- [Filters](docs/Filters.md)
- [Logic](docs/Logic.md)
- [Troubleshooting](docs/Troubleshoot%20Web%20Clipper.md)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, build, test, and PR instructions.

## Origin

Forked from [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) v1.2.1 by [kepano](https://github.com/kepano). Replaced the Obsidian vault integration with Logseq HTTP API, added batch clipping, and removed Safari/legacy features. A [monthly GitHub Action](.github/workflows/upstream-check.yml) tracks upstream changes for cherry-picking.
