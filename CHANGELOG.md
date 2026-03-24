# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-03-24

### Fixed
- Page properties not visible in Logseq for create/update behaviors — `upsertBlockProperty` on page UUID doesn't render visible properties; now uses metadata block pattern (`key:: value` first block) matching append/prepend behaviors
- Zen Browser crash mitigation — `sendMessageToTab` async chain could linger indefinitely, keeping the service worker alive; added 30s timeout so the chain always resolves, allowing clean service worker termination

## [0.3.3] - 2026-03-24

### Fixed
- Dedup detection: clip log properties now stored on anchor block via upsertBlockProperty so queryByProperty matches correctly
- Highlight offset calculation: TreeWalker starts with nextNode() to avoid double-counting container textContent
- API token no longer written to browser.storage.sync (was cloud-synced during setup window)
- HTML sanitizer replaced with DOMPurify (was manual script-tag removal only)
- Removed `extension_ids: ["*"]` from web_accessible_resources in manifests
- Double-click guard on clip button prevents duplicate saves
- Modal event listener cleanup uses stored handler reference (was inline arrow, never removed)
- Query value escaping includes parentheses for Datalog safety
- Highlight merge undo works for same-count merges
- Per-property error handling in save flow (partial failure no longer aborts entire save)
- Template property compilation uses Promise.allSettled (one bad property no longer aborts clip)
- Interpreter timer uses requestAnimationFrame instead of 10ms setInterval
- Passive listeners on highlighter scroll/resize handlers
- Charts mousemove handler throttled

### Changed
- TypeScript: eliminated all explicit `any` (21 justified suppressions remain), enabled noUncheckedIndexedAccess
- Defined TemplateValue and SchemaOrgData types to replace ~50 any suppressions at root cause
- All JSON.parse calls use unknown intermediate with runtime narrowing
- PropertyType.type narrowed from string to PropertyTypeName union
- Exhaustive switch checks with assertNever on Template.behavior
- Replaced console.log with debugLog across all production files
- parseLLMResponse refactored from 4-layer nested try-catch to sequential strategy pipeline
- waitForInterpreter DOM polling replaced with direct Promise tracking
- Event delegation for reader outline items and template property list
- Pre-cached overlay rects and heading indices to eliminate layout thrashing
- Immutable array operations (.toReversed(), .toSorted())
- Dead code removed (resolver.ts duplicates, unused imports)
- Added pnpm audit to CI workflow

### Accessibility
- Settings sidebar: tablist/tab roles with keyboard navigation (arrow keys, Enter/Space)
- Star rating: radiogroup role with arrow-key navigation
- Modals: role=dialog, aria-modal=true, aria-labelledby
- Variable panel: focusable items with keyboard handlers
- Error messages: aria-live regions on popup and side-panel
- Hamburger menu: aria-expanded updated on toggle
- Menu containers: role=menu for menuitem children
- HTML lang attribute on all pages

### Added
- Error-path tests for removeBlock, insertBatchBlock, upsertBlockProperty
- Edge case tests for filter functions
- CHANGELOG.md (Keep a Changelog format)
- .env.example with test variables
- Node.js engines field in package.json
- Bug report template fixed for Logseq

## [0.3.2] - 2025-06-15

### Fixed
- Journal page query returns null entries; filter for actual page
- Metadata block uses template properties only, no injected keys
- Clip log tracks destination page, dedup verifies clip exists
- Behavioral correctness in save flow
- Security and API robustness improvements
- Changelog links to our releases, help notes link to correct docs

### Added
- Integration tests against live Logseq API

## [0.3.1] - 2025-06-01

### Fixed
- Append/prepend create metadata parent block with properties
- Settings persistence on connection page (save on input, not just blur)
- Setup page styling and encoding
- Firefox signing only on release, not on push

## [0.3.0] - 2025-05-15

### Changed
- Initial Logseq adaptation (forked from [Obsidian Web Clipper v1.2.1](https://github.com/obsidianmd/obsidian-clipper))
- Replaced Obsidian vault API with Logseq HTTP API integration
- Save targets: daily journal page (append/prepend) or named page
- Extension icon replaced with Logseq logo

### Fixed
- Critical save flow, security, and behavioral issues
- Removed dead code: CLI, unused properties param, local journal function

### Added
- Logseq API connection setup page
- Firefox extension signing via Mozilla AMO (unlisted)
- Save-as-page dropdown with error handling

[0.3.4]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.4
[0.3.3]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.3
[0.3.2]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.2
[0.3.1]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.1
[0.3.0]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.0
