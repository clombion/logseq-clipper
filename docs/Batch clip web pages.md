# Batch clip web pages

Clip all open browser tabs in one operation. Review which tabs to include and which template to use for each before clipping.

## How to batch clip

1. Click the Web Clipper icon in your browser toolbar
2. Click **Clip all tabs** from the dropdown menu
3. The review screen shows all clippable tabs:
   - Each tab has a checkbox (include/exclude) and a template dropdown
   - Templates are auto-matched by URL trigger rules
   - Pinned tabs and internal browser pages are excluded
4. Adjust selections and templates as needed
5. Click **Clip selected (N)**

## Review screen

- **Select all / Deselect all**: Toggle at the top to quickly include or exclude all tabs
- **Template per tab**: Each tab shows its auto-matched template. Click the dropdown to choose a different one.
- **Excluded tabs**: Pinned tabs, `chrome://` pages, `about:` pages, and extension pages are not shown

## During clipping

- Tabs are clipped one at a time in order
- Each tab shows its status: pending (·), clipping (⏳), done (✓), failed (✗), or already clipped (⊘)
- **You can close the popup** — clipping continues in the background. Reopen the popup to see progress.
- Click **Cancel** to stop after the current tab finishes

## After clipping

- A summary shows how many tabs were clipped, failed, or already existed
- **Close clipped tabs?** — Choose Yes to close all successfully clipped tabs (including duplicates already in Logseq), or No to keep them open
- Failed tabs show the error reason

## Templates in batch mode

- Templates are matched using **URL trigger rules only** (not schema.org triggers, which require page content extraction)
- This means some tabs may get a different auto-match than single-clip mode
- You can always override the template per tab in the review screen
- If a template uses the **Interpreter** (LLM), it runs during clipping with the template's default prompt context

## Tips

- Use batch clip to quickly capture research sessions, bookmark collections, or reading lists
- Uncheck tabs you want to keep open for later
- Each tab follows its own template's behavior (create page, append to daily journal, etc.)
