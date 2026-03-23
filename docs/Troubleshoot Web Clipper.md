---
permalink: web-clipper/troubleshoot
---
If you encounter issues with [[Introduction to Logseq Web Clipper|Web Clipper]] you can report bugs on the project's GitHub repo.

## General

### Some content is missing

By default, Web Clipper tries to intelligently capture content from the page. However it may not be successful in doing so across all websites.

Web Clipper uses [Defuddle](https://github.com/kepano/defuddle) to capture only the main content of the page. This excludes header, footer, and other elements, but sometimes it can be overly conservative and remove content that you want to keep. You can [report bugs](https://github.com/kepano/defuddle) to Defuddle.

To bypass Defuddle in Web Clipper use the following methods:

- Select text, or use `Cmd/Ctrl+A` to select all text.
- [[Highlight web pages|Highlight content]] to choose exactly what you want to capture.
- Use a [[Templates|custom template]] for the site.

### No content appears in Logseq

If you don't see any content in Logseq when you click **Add to Logseq**:

- Ensure Logseq is running and the HTTP API server is enabled (check Logseq settings).
- Check that the API token in Web Clipper settings matches the one configured in Logseq.
- Verify the API URL is correct (default: `http://127.0.0.1:12315`).
- Check for errors in the browser developer console.
- Check that your graph name in Web Clipper settings exactly matches your graph name in Logseq.

## Linux

#### Logseq does not receive clipped content

- Ensure Logseq is running and the HTTP API is enabled.
- Check that your firewall is not blocking local connections to the API port.

## iOS and iPadOS

To enable the Web Clipper extension for Safari:

1. Go to Safari, tap the leftmost button in the browser URL bar, it looks like a rectangle with lines beneath it.
2. Tap **Manage Extensions**.
3. Enable **Logseq Web Clipper** in the Extensions list.
4. Exit the menu.
5. To use the extension **tap the puzzle piece icon** in the URL bar.

To allow Web Clipper to run on all websites:

1. Go to iOS **Settings** →  **Apps** →  **Safari** →  **Extensions**.
2. Under **Permissions** allow it to run on all websites.
