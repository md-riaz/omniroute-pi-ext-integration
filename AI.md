# AI Handoff Guide

This file is the first stop for AI agents. Read this before scanning the repo.

## Repository Purpose

`omniroute-pi-ext-integration` is a Pi Coding Agent extension for OmniRoute.

It does three jobs:

1. `/omni setup` saves OmniRoute URL/API key into Pi `models.json` and tests protected endpoints with the entered key.
2. `/omni sync` fetches OmniRoute `/v1/models` and syncs them into Pi's `/model` picker.
3. The extension registers an `omni` provider that routes tool calling automatically:
   - native tool-capable models use OpenAI-compatible native `tool_calls`
   - chat-only models use prompt-emulated tools via `<tool_call>` blocks

## Files

| Path | Purpose |
|---|---|
| `shared.ts` | Extension implementation. Commands, catalog sync/autosync, provider registration. |
| `omp.ts` | Oh My Pi entry point. |
| `pi.ts` | Pi Coding Agent entry point. |
| `scripts/sync-once.ts` | One-shot catalog sync helper for install/refresh scripts. |
| `test/shared.test.ts` | Legacy catalog migration and autosync unit tests. |
| `README.md` | User-facing install/setup/usage docs. |
| `package.json` | Pi extension metadata, scripts, dev deps. |
| `package-lock.json` | Locked npm dependency tree. |
| `AGENTS.md` | Mandatory instructions for AI agents editing this repo. |
| `ARCHITECTURE.md` | Detailed data flow and prompt-tool architecture. |
| `CONTRIBUTING.md` | Dev workflow, test checklist, and contribution rules. |
| `LICENSE` | MIT license. |

## Key Concepts

### Provider name

The Pi provider is always:

```text
omni
```

Users keep switching models normally:

```text
/model cgpt-web/gpt-5.4-pro
/model codex/gpt-5.2
```

Do not create a second prompt-tools provider unless explicitly requested.

### Custom API id

The extension registers a synthetic API id:

```ts
const OMNI_PROMPT_TOOLS_API = "omni-prompt-tools";
```

That custom API routes through `streamOmni()`.

### Underlying API

Real HTTP calls still use Pi's built-in OpenAI-compatible provider:

```ts
const UNDERLYING_API = "openai-completions";
```

Native mode passes tools normally. Prompt mode strips native tools and renders tool schemas as text.

## Tool Mode Decision

Entry point:

```ts
shouldUsePromptTools(model)
```

Prompt tool mode triggers when:

1. raw `models.json` says the selected model has:

```json
"tool_calling": false
```

2. or model id/name/provider/OmniRoute `owned_by` contains:

```text
-web
```

Reason: Pi's runtime `Model` type does not preserve custom fields like `tool_calling`, so the extension re-reads raw `models.json` in `modelConfigToolCallingFalse()`.

## Important Functions In `shared.ts`

Read in this order:

1. `createOmniExtension()` — registers commands, tools, health checks, and catalog autosync.
2. `registerOmniProvider()` — registers/refreshes the `omni` provider and model list.
3. `sanitizeAutoSyncIntervalMs()` — clamps `/omni autosync` and env interval values.
4. `syncOmniModelsForAgentHome()` — one-shot sync used by `scripts/sync-once.ts`.
5. `getAllModelsFromOmniRoute()` — fetches `/v1/models` and converts to Pi model entries.

## Prompt Tool Wire Format

The chat-only model is instructed to emit:

```xml
<tool_call>
{"name":"read","arguments":{"path":"index.ts"}}
</tool_call>
```

Tool results are replayed in history as:

```xml
<tool_result tool="read" id="call_123">
...tool output...
</tool_result>
```

`streamWithPromptTools()` parses these text blocks and emits Pi native `toolcall_*` stream events so Pi executes tools normally.

## Common Change Requests

### Add a new model detection rule

Update:

```ts
shouldUsePromptTools()
```

Keep `modelConfigToolCallingFalse()` because raw `models.json` metadata is important.

### Change OmniRoute sync metadata

Update:

```ts
getAllModelsFromOmniRoute()
SyncedModel
```

Then update README example model JSON if user-visible.

### Change prompt tool format

Update together:

```ts
renderToolProtocol()
TOOL_CALL_RE
renderToolCallBlock()
parseToolCalls()
README.md
```

### Change setup behavior

Update `/omni setup` handler near bottom of `index.ts`. Preserve the current order: ask for API key before testing `/v1/models`, because protected OmniRoute servers may require Authorization for model listing.

### Change sync behavior

Update `/omni sync`, catalog autosync (`startAutoSync` / `sanitizeAutoSyncIntervalMs`), and `getAllModelsFromOmniRoute()`. Keep `/omni autosync` as the user control; do not add a second provider.

## Test Commands

```bash
npm run typecheck
npm test
npm run smoke
```

Expected smoke output:

```text
omp ok
pi ok
```

## Pitfalls

- Do not rely only on Pi runtime `Model` for `tool_calling`; custom fields and OmniRoute `owned_by` are stripped.
- Do not set web/chat-only models to a separate provider; keep `/model` workflow unchanged.
- Do not send native `tools` to chat-only web-synced models; use prompt mode with `tools: []`.
- `streamWithPromptTools()` is buffered, not token-streamed. It waits for full response so it can parse tool blocks safely.
- Prompt mode drops non-text content in history because chat-only OpenAI-compatible endpoints here are treated as text-first.

## Current Branch Intent

Branch `prompt-tools-web-fallback` adds prompt-emulated tool calling inside the existing OmniRoute extension.

Goal: no UX change for user. `/model` works same; extension chooses tool mode internally.
