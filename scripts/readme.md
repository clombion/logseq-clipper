## Scripts

### Localization

First, add an OpenAI API key in `.env` at the root of the repo:

```
OPENAI_API_KEY=sk-...
```

Scripts can be run using pnpm in the root of the repo.

#### Update locale

```
pnpm run update-locales
```

- Checks the English locale file and automatically translates missing strings
- Reorganizes strings alphabetically

#### Add locale

```bash
pnpm run add-locale fr
```

### Version bump

```bash
./scripts/bump-version.sh 1.0.1
```

- Updates `version` in `package.json` and all browser manifests

### Changelog

```bash
./scripts/generate-changelog.sh
```

- Generates `changelogs/<version>.md` from commits since the last git tag
- Reads the version from `package.json`
- Commits starting with "fix" are grouped under an **Improved** section
- Version bump commits are excluded
