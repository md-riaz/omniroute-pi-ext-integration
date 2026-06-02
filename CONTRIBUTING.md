# Contributing

## Quick Start

```bash
npm install
npm run typecheck
npm run smoke
```

## Development Scripts

| Command | Purpose |
|---|---|
| `npm run typecheck` | Type-check `index.ts` with NodeNext settings. |
| `npm run smoke` | Import the extension module and verify it loads. |

## Local Pi Testing

From this repo:

```bash
pi -e ./index.ts
```

Or install normally:

```bash
pi install git:github.com/md-riaz/omniroute-pi-ext-integration
```

Then in Pi:

```text
/omni setup
/omni sync
/model cgpt-web/gpt-5.4-pro
```

## Before Opening a PR

Run:

```bash
npm run typecheck
npm run smoke
```

Check working tree:

```bash
git status --short
git diff --stat
```

## Documentation Rules

If changing user-visible behavior, update `README.md`.

If changing architecture or core data flow, update `ARCHITECTURE.md`.

If changing function names or scan paths, update `AI.md` so future AI agents do not waste tokens rediscovering the repo.

## Coding Rules

- Keep extension in `index.ts` unless feature grows enough to justify splitting files.
- Add short comments for non-obvious functions.
- Preserve `/model` UX; do not add duplicate providers for prompt tools.
- Keep `omni` as provider name.
- Keep prompt fallback automatic.
- Avoid destructive behavior in `/omni sync`; it should only replace `config.providers.omni.models`.

## Testing Checklist

For model sync changes:

- `/omni setup` saves URL/API key.
- `/omni sync` writes models to `~/.pi/agent/models.json`.
- Web-synced models get `tool_calling:false` even when `-web` only appears in OmniRoute `owned_by`/provider metadata.
- Normal models do not get forced into prompt mode.

For prompt tool changes:

- `npm run typecheck` passes.
- `npm run smoke` passes.
- A `tool_calling:false` model can trigger a tool call.
- A native model still uses native tool calls.
- Bad `<tool_call>` JSON surfaces correction text instead of silent failure.

## Commit Style

Use descriptive commit messages. Good examples:

```text
Add prompt-tool fallback for web-synced OmniRoute models
Document OmniRoute prompt tool architecture
Preserve raw tool_calling metadata during model sync
```
