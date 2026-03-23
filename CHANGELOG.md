# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.2]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.2
[0.3.1]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.1
[0.3.0]: https://github.com/clombion/logseq-clipper/releases/tag/0.3.0
