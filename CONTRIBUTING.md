# Contributing

## Development

### Prerequisites

- Node.js (v18+)
- [pnpm](https://pnpm.io/)
- Logseq with HTTP API enabled (for manual testing)

### Setup

```bash
pnpm install
cp .env.example .env   # then fill in values
```

### Build

```bash
pnpm run build:chrome    # -> dist/
pnpm run build:firefox   # -> dist_firefox/
pnpm run build           # both
```

### Test

```bash
pnpm test                # run once
pnpm run test:watch      # watch mode
```

### Lint & format

```bash
pnpm run lint            # biome check
pnpm run format          # biome format --write
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | For interpreter tests | OpenAI API key for LLM interpreter |

## Branching & merge strategy

Development happens on feature branches off `main`. The `logseq` branch tracks the deployable state.

- Feature branches: `feat/<name>`, `fix/<name>`
- Merge to `main` via **squash merge**
- Release: merge `main` into `logseq` (fast-forward when possible)

## Pull requests

1. Create a branch from `main`
2. Make changes, ensure `pnpm run build && pnpm test` pass
3. Open a PR against `main`
4. Fill in the PR template (description, testing steps, checklist)

## Code style

- TypeScript, tabs for indentation
- Single quotes, semicolons
- Run `pnpm run format` before committing

## Project structure

```
src/
├── core/              # popup.ts, settings.ts (UI entry points)
├── managers/          # template-ui, general-settings, highlights, interpreter
├── utils/
│   ├── logseq-api.ts          # HTTP API client for Logseq
│   ├── logseq-note-creator.ts # Save, dedup, clip log, settings sync
│   ├── markdown-to-blocks.ts  # Markdown -> IBatchBlock[] converter
│   ├── shared.ts              # Pure functions (variables, frontmatter)
│   ├── filters/               # 100+ template filters
│   └── ...
├── _locales/          # 32 languages
├── setup.html/ts      # First-run setup page
└── manifest.*.json    # Chrome, Firefox manifests
```
