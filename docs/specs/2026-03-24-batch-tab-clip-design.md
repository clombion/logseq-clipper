# Batch Tab Clip — Design Spec

## Summary

Clip all open tabs in the current window in one operation. A review screen lets the user confirm which tabs to clip and which template to use for each, then clips them sequentially with a progress indicator. After completion, offers to close the clipped tabs.

## User Flow

1. User clicks **"Clip all tabs"** button in the popup (near the existing clip button area).
2. Popup swaps from the single-clip view to the **batch review view**.
3. Review view shows:
   - Header: "Clip all tabs (14 of 18)" — clippable count vs total window tabs.
   - **Select all / Deselect all** toggle.
   - Scrollable list. Each row: checkbox + favicon + title (truncated) + template dropdown.
   - Templates auto-matched by trigger rules (URL pattern matching — local, no API calls). User can override per tab.
   - **Excluded from list**: pinned tabs, internal pages (`chrome://`, `about:`, `moz-extension://`, extension pages).
4. User reviews, unchecks tabs they don't want, adjusts templates.
5. Clicks **"Clip selected (N)"**.
6. Progress view: sequential clipping with per-tab status (pending → in progress → done / failed).
7. On completion: **"Close N clipped tabs?"** with Yes / No.
8. If yes: clipped tabs close, popup returns to normal. If no: popup returns to normal.

## Data Flow

### Review Phase (no API calls)

1. Popup sends `{ action: 'getClippableTabs' }` to background.
2. Background queries `browser.tabs.query({ currentWindow: true })`.
3. Filters out: `pinned === true`, URLs starting with `chrome://`, `about:`, `moz-extension://`, `chrome-extension://`, blank pages.
4. For each remaining tab: runs `findMatchingTemplate(tab.url)` — pure regex/string matching on template trigger rules. Falls back to first template if no match.
5. Returns `{ tabs: Array<{ id, title, url, favIconUrl, matchedTemplateId }> }` to popup.
6. Popup renders the review list. No content extraction, no Logseq API calls, no LLM calls.

### Clip Phase (after user confirms)

For each selected tab, **sequentially**:

1. Inject content script into the tab (if not already injected).
2. `extractPageContent(tabId)` — gets page HTML, metadata, schema.org data.
3. Run `checkDuplicate(url)` against Logseq. If duplicate: mark as "already clipped", skip.
4. Compile template with extracted variables.
5. If template has prompt variables: run interpreter (LLM call happens here, not before).
6. `saveToLogseq(noteContent, noteName, properties, behavior, sourceUrl)` using the tab's selected template's behavior.
7. Update progress indicator. Move to next tab.

Sequential execution avoids overwhelming Logseq's API and makes progress deterministic.

## UI Layout

### Review View

```
┌─────────────────────────────────────────┐
│ ← Back          Clip all tabs     ⚙     │
├─────────────────────────────────────────┤
│ ☑ Select all              14 tabs       │
├─────────────────────────────────────────┤
│ ☑ 🌐 How to use Logseq API  [Default ▼]│
│ ☑ 🌐 OpenSanctions - Search  [Website▼]│
│ ☐ 🌐 YouTube - Some Video   [Default ▼]│
│ ☑ 🌐 GitHub - logseq/logseq [Default ▼]│
│   ...scrollable...                      │
├─────────────────────────────────────────┤
│        [ Clip selected (3) ]            │
└─────────────────────────────────────────┘
```

### Progress View

```
├─────────────────────────────────────────┤
│ Clipping 2 of 3...                      │
│ ✓ How to use Logseq API                 │
│ ⏳ OpenSanctions - Search                │
│ · GitHub - logseq/logseq                │
├─────────────────────────────────────────┤
│        [ Cancel ]                       │
└─────────────────────────────────────────┘
```

### Completion View

```
├─────────────────────────────────────────┤
│ ✓ 3 tabs clipped                        │
│                                         │
│    Close 3 clipped tabs?                │
│      [ Yes ]    [ No ]                  │
└─────────────────────────────────────────┘
```

With failures:

```
│ ✓ 2 clipped, ✗ 1 failed                │
│ ✗ YouTube: content extraction failed    │
│                                         │
│    Close 2 clipped tabs?                │
│      [ Yes ]    [ No ]                  │
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Content extraction fails (login wall, CORS, crashed tab) | Skip tab, mark as failed, continue |
| Logseq API connection lost mid-batch | Stop remaining, show partial results |
| LLM/interpreter fails for a tab | Clip with raw template variables (no LLM output) |
| Tab closed by user during review | Remove from list at clip time, no error |
| Tab navigated during review | Re-extract at clip time with current URL |
| Zero clippable tabs | Show "No clippable tabs found" with Back button |
| All tabs unchecked | "Clip selected" button disabled |
| Cancel during clipping | Finish current tab, stop remaining, show partial results |
| Duplicate detected (dedup) | Skip silently, mark as "already clipped" in results |

## Architecture

### New code

| Location | Change |
|----------|--------|
| `popup.ts` | `handleBatchClip()` function: builds review UI, manages clip queue, handles progress/completion |
| `popup.html` | Container div for batch view (hidden by default, shown when batch mode active) |
| `background.ts` | New message handler: `'getClippableTabs'` — queries and filters tabs |
| `style.scss` | Styles for batch review list, progress indicators, completion view |

### Existing code reused (no changes)

| Module | Usage |
|--------|-------|
| `findMatchingTemplate()` | Template auto-matching by URL triggers |
| `extractPageContent(tabId)` | Per-tab content extraction |
| `compileTemplate()` | Template variable substitution |
| `handleInterpreterUI()` | LLM processing (if template has prompts) |
| `saveToLogseq()` | Save to Logseq API |
| `checkDuplicate()` | Dedup check per URL |

### Permissions

No new permissions needed. Existing `activeTab` + `scripting` + `<all_urls>` cover multi-tab content script injection.

## Scope

### In scope (v1)

- "Clip all tabs" button in popup
- Review screen: checkbox + template dropdown per tab
- Select all / deselect all
- Sequential clip with progress
- Post-clip "close tabs?" confirmation
- Per-tab error handling with summary

### Not in scope

- Side-panel batch mode
- Keyboard shortcut trigger
- Per-tab note name / property editing
- Parallel clipping
- Tab group awareness
- Cross-window clipping
- Persisting batch state across popup close
