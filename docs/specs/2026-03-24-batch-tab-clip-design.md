# Batch Tab Clip — Design Spec

## Summary

Clip all open tabs in the current window in one operation. A review screen lets the user confirm which tabs to clip and which template to use for each. Clipping runs in the background service worker so it survives popup close. After completion, offers to close the clipped tabs.

## User Flow

1. User clicks **"Clip all tabs"** button in the popup (near the existing clip button area).
2. Popup swaps from the single-clip view to the **batch review view**.
3. Review view shows:
   - Header: "Clip all tabs (14 of 18)" — clippable count vs total window tabs.
   - **Select all / Deselect all** checkbox. Behavior: if all checked, uncheck all; otherwise, check all.
   - Scrollable list. Each row: checkbox + favicon + title (truncated) + template dropdown.
   - Templates auto-matched by URL/regex trigger rules only (schema.org triggers skipped — would require content extraction). User can override per tab.
   - **Excluded from list**: pinned tabs, internal pages (`chrome://`, `about:`, `moz-extension://`, extension pages).
4. User reviews, unchecks tabs they don't want, adjusts templates.
5. Clicks **"Clip selected (N)"**.
6. Popup sends the clip queue to the **background service worker**, which executes it.
7. Popup shows progress view. If popup closes and reopens, it reconnects to the in-flight batch.
8. On completion: **"Close N clipped tabs?"** with Yes / No.
9. If yes: clipped tabs close, popup returns to normal. If no: popup returns to normal.

## Data Flow

### Review Phase (no API calls, no content extraction)

1. Popup sends `{ action: 'getClippableTabs' }` to background.
2. Background queries `browser.tabs.query({ currentWindow: true })`.
3. Filters out: `pinned === true`, URLs starting with `chrome://`, `about:`, `moz-extension://`, `chrome-extension://`, blank pages.
4. For each remaining tab: runs `findMatchingTemplate(tab.url)` with URL/regex triggers only — schema.org triggers are skipped (a no-op `getSchemaOrgData` callback returning null). Falls back to first template if no match. This means some tabs may get a different auto-match than single-clip mode where schema.org data is available.
5. Returns `{ tabs: Array<{ id, title, url, favIconUrl, matchedTemplateId }> }` to popup.
6. Popup renders the review list.

### Clip Phase (runs in background service worker)

Popup sends `{ action: 'executeBatchClip', clips: Array<{ tabId, templateId }> }` to background.

Background executes sequentially for each clip:

1. Inject content script into the tab (if not already injected).
2. `extractPageContent(tabId)` — gets page HTML, metadata, schema.org data.
3. Run `checkDuplicate(url)` against Logseq. If duplicate: mark as "already clipped", skip.
4. Assemble template variables from extracted content: call `buildVariables()` (from `shared.ts`) which maps extracted content fields to template variable format (`{{title}}`, `{{content}}`, `{{url}}`, etc.).
5. Compile template with assembled variables via `compileTemplate()`.
6. If template has prompt variables: run LLM processing headlessly via `sendToLLM()` (extracted from `handleInterpreterUI` — DOM-free, takes prompt context + content + variables, returns prompt responses). Uses the template's default prompt context.
7. `saveToLogseq(noteContent, noteName, properties, behavior, sourceUrl)` using the tab's selected template's behavior.
8. Send progress update to popup (if open) via `browser.runtime.sendMessage`. Move to next tab.

Sequential execution avoids overwhelming Logseq's API and makes progress deterministic.

### Progress Communication

Background → Popup messaging:
- `{ action: 'batchClipProgress', current, total, tabId, status: 'clipping' | 'done' | 'failed' | 'duplicate', error? }`
- `{ action: 'batchClipComplete', results: Array<{ tabId, status, error? }> }`

Popup can reconnect by sending `{ action: 'getBatchClipStatus' }` on open. Background replies with current state (idle, in-progress with details, or complete with results).

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
│ ✓ 3 clipped                             │
│                                         │
│    Close 3 clipped tabs?                │
│      [ Yes ]    [ No ]                  │
└─────────────────────────────────────────┘
```

With mixed results:

```
│ ✓ 2 clipped, ⊘ 1 already existed, ✗ 1 failed │
│ ✗ YouTube: content extraction failed           │
│                                                │
│    Close 3 tabs? (2 clipped + 1 existing)      │
│      [ Yes ]    [ No ]                         │
```

Duplicates ("already existed") are included in the close-tabs count since their content is already in Logseq.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Content extraction fails | Skip tab, mark as failed, continue |
| Logseq API connection lost mid-batch | Stop remaining, show partial results |
| LLM/interpreter fails for a tab | Clip with prompt variables replaced by empty strings |
| Tab closed during review or clip | Skip at clip time, mark as failed ("tab closed") |
| Tab navigated during review | Re-extract at clip time with current URL; keep user's template selection (no re-match) |
| Zero clippable tabs | Show "No clippable tabs found" with Back button |
| All tabs unchecked | "Clip selected" button disabled |
| Cancel during clipping | Finish current tab, stop remaining, show partial results |
| Duplicate detected (dedup) | Skip, mark as "already clipped" with ⊘ icon in results |
| Popup closes during clipping | Batch continues in background; reopening popup reconnects to progress |

## Architecture

### New code

| Location | Change |
|----------|--------|
| `popup.ts` | Batch review UI: tab list, select/deselect, template dropdowns. Progress view that connects/reconnects to background. |
| `popup.html` | Container div for batch view (hidden by default). |
| `background.ts` | `'getClippableTabs'` handler. `'executeBatchClip'` handler (clip loop). `'getBatchClipStatus'` handler (reconnect). `'cancelBatchClip'` handler. |
| `interpreter.ts` | Extract `sendToLLM()` call path into a headless function usable without DOM. The existing `sendToLLM()` already takes pure data args — the extraction is about bypassing `handleInterpreterUI`'s DOM setup/teardown. |
| `style.scss` | Styles for batch review list, progress indicators, completion view. |

### Existing code reused (no changes)

| Module | Usage |
|--------|-------|
| `findMatchingTemplate()` | Template auto-matching (URL/regex triggers only, schema.org skipped) |
| `extractPageContent(tabId)` | Per-tab content extraction |
| `buildVariables()` | Assemble template variables from extracted content |
| `compileTemplate()` | Template variable substitution |
| `sendToLLM()` | Headless LLM processing (already takes pure data args) |
| `saveToLogseq()` | Save to Logseq API |
| `checkDuplicate()` | Dedup check per URL |

### Permissions

No new permissions needed. Existing `host_permissions: ["<all_urls>"]` enables content script injection into any tab and access to tab URLs/titles. The `tabs` permission is not required given this host permission scope.

## Scope

### In scope (v1)

- "Clip all tabs" button in popup
- Review screen: checkbox + template dropdown per tab
- Select all / deselect all
- Clip execution in background service worker (survives popup close)
- Popup reconnects to in-flight batch on reopen
- Headless LLM processing (no DOM dependency)
- Sequential clip with progress
- Post-clip "close tabs?" confirmation (includes duplicates)
- Per-tab error handling with summary

### Not in scope

- Side-panel batch mode
- Keyboard shortcut trigger
- Per-tab note name / property editing
- Schema.org trigger matching in review phase
- Parallel clipping
- Tab group awareness
- Cross-window clipping
