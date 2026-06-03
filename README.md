# omniroute-agent-extension

[![npm version](https://img.shields.io/npm/v/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)
[![npm downloads](https://img.shields.io/npm/dm/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)

OmniRoute extension for [Pi Coding Agent](https://pi.dev) (`pi`) and [Oh My Pi](https://omp.sh) (`omp`).

Connect to your local or remote OmniRoute server, browse models, and intelligently route queries across 44+ LLM providers — directly from your agent CLI.

## Features

- **Wizard-Based Setup**: Run `/omni setup` inside `pi` or `omp`. No manual JSON editing needed.
- **Dual CLI Support**: One package, identical feature set for both `pi` and `omp`.
- **Pure HTTP Client**: Works whether your OmniRoute server is on `localhost:20128` or a remote VPS.
- **Model Sync**: Push all available OmniRoute models into the `Ctrl+P` picker with full metadata — context windows, max tokens, reasoning support, and vision capabilities.
- **Prompt Tool Fallback**: Chat-only and web-synced models that don't support native `tool_calls` transparently use prompt-emulated tool calling. Same `/model` workflow, no separate provider needed.
- **Protocol Refresh**: Full tool schema on the first prompt-tool turn, compact reminders after, full resend every 6 turns or after tool-set changes and parse errors.
- **Smart Sorting**: Models grouped by provider prefix (`owned_by`) for a cleaner `Ctrl+P` experience. Auto-routing models (`auto`, `auto/coding`, etc.) always appear first.
- **Health Monitoring**: Periodic reachability checks with status bar indicators for unconfigured or unreachable servers.
- **Env Overrides**: `OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_PROVIDER_NAME` skip the setup wizard entirely.

## Installation

**Pi Coding Agent:**

```bash
pi install omniroute-agent-extension
```

```bash
pi install git:github.com/md-riaz/omniroute-agent-extension
```

**Oh My Pi:**

```bash
omp install omniroute-agent-extension
```

```bash
omp install git:github.com/md-riaz/omniroute-agent-extension
```

## Getting Started

1. Start your CLI (`pi` or `omp`)
2. Run `/omni setup` — enter your OmniRoute server URL and API key
3. Run `/omni sync` — populates the `Ctrl+P` model picker
4. Use `/model` as normal — the extension routes native vs prompt tools automatically

Config is saved to:

| CLI | Config path |
|---|---|
| `pi` | `~/.pi/agent/omniroute-agent-extension/config.json` |
| `omp` | `~/.omp/agent/omniroute-agent-extension/config.json` |

Synced models are written to `~/.pi/agent/models.json` or `~/.omp/agent/models.json` so they survive restarts without a network call.

## Commands

| Command | Description |
|---|---|
| `/omni` | Server health and provider status |
| `/omni setup` | Configure server URL and API key interactively |
| `/omni sync` | Fetch `/v1/models` and register the OmniRoute provider |
| `/omni models [search]` | Browse synced models with optional keyword filter |
| `/omni test <model>` | Smoke-test `/v1/chat/completions` with a specific model |
| `/omni dashboard` | Show the OmniRoute dashboard URL |
| `/omni config` | Show config and models.json paths with current settings |
| `/omni help` | Show command list |

## Agent Tools

The extension registers two tools the LLM can call directly:

- **`omniroute_status`** — returns server reachability, config path, and provider name
- **`omniroute_sync`** — fetches `/v1/models` and re-registers the provider (equivalent to `/omni sync`)

## Prompt Tool Fallback

Some OmniRoute-synced models are chat-only: they return text but not native `tool_calls`. This is common for web-synced models with `-web` in their identifier:

```text
cgpt-web/gpt-5.4-pro
chatgpt-web/gpt-5.5
bb-web/gpt-4-turbo
ds-web/deepseek-v4-pro
```

For these models the extension keeps the same `omni` provider and `/model` workflow, but internally switches to prompt-emulated tool calling.

### Native tool mode

```text
Pi/omp agent
  -> omni provider
  -> OmniRoute with native tools: [...]
  -> model returns native tool_calls
  -> agent executes tools
```

### Prompt tool mode

The extension injects a compact text protocol into the outbound system prompt. Tool calls are parsed from `<tool_call>` XML blocks in the response and converted to native tool events. Prompt tool mode is buffered — the extension waits for the full model response before emitting tool events.

```text
Pi/omp agent
  -> omni provider
  -> extension injects tool schemas as text in system prompt
  -> OmniRoute request sent with tools: []
  -> model writes <tool_call>{...}</tool_call>
  -> extension converts blocks to native toolCall events
  -> agent executes tools normally
```

The model is taught this wire format:

```xml
<tool_call>
{"name":"read","arguments":{"path":"shared.ts"}}
</tool_call>
```

**Safety rule:** tool calls execute only when the entire assistant message is `<tool_call>` block(s) plus whitespace. Prose mixed with `<tool_call>` is treated as normal text — no tools execute. This prevents documentation snippets or mixed answers from accidentally triggering tool execution.

**Protocol refresh:** full schema list on turn 1, compact argument-hint reminders on turns 2–5, full resend every 6 prompt-tool turns, after any tool-set change, or after malformed/mixed output.

Tool results are fed back in history as text:

```xml
<tool_result tool="read" id="call_123">
...tool output...
</tool_result>
```

## How Prompt Tool Mode Is Detected

Prompt tool mode activates when either condition is true:

1. The upstream model metadata contains `-web` during sync — checked against OmniRoute model ID, `name`, `owned_by`, or provider label.
2. The synced `models.json` entry contains `"tool_calling": false`.

The second check reads raw `models.json` because the CLI runtime strips custom fields like `tool_calling` from its `Model` objects.

Example synced entry for a chat-only model:

```json
{
  "id": "cgpt-web/gpt-5.4-pro",
  "name": "Gpt 5.4 Pro",
  "api": "omni-prompt-tools",
  "tool_calling": false,
  "input": ["text", "image"],
  "contextWindow": 400000,
  "maxTokens": 65535,
  "reasoning": true
}
```

## Model Switching

Use the normal model picker:

```text
/model cgpt-web/gpt-5.4-pro
/model codex/gpt-5.2
/model auto/coding
```

The extension routes automatically:

| Model kind | Detection | Tool mode |
|---|---|---|
| Web-synced model | ID / name / `owned_by` / provider contains `-web` | Prompt-emulated tools |
| Explicit chat-only | `tool_calling: false` in `models.json` | Prompt-emulated tools |
| Normal model | No fallback marker | Native tools |

## Auto Models

The following virtual model IDs are always prepended to the synced list. OmniRoute resolves them server-side to the best available model for each intent:

```
auto         auto/coding    auto/fast
auto/cheap   auto/offline   auto/smart   auto/lkgp
```

## Development

```bash
npm run typecheck   # tsc — zero errors expected
npm run smoke       # import check for omp.ts and pi.ts via node --experimental-strip-types
```

| File | Purpose |
|---|---|
| `shared.ts` | All business logic — no CLI package imports; local `OmniPI` interface |
| `omp.ts` | Oh My Pi entry point — `OMP_HOME` / `~/.omp/agent` |
| `pi.ts` | Pi Coding Agent entry point — `PI_HOME` / `~/.pi/agent` |
| `AGENTS.md` | Instructions for AI agents editing this repo |
| `AI.md` | Fast handoff guide for AI agents and maintainers |
| `ARCHITECTURE.md` | Data flows and prompt-tool protocol details |
| `CONTRIBUTING.md` | Local setup, test checklist, contribution rules |

## Requirements

- `pi` ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) v0.60.0+ **or** `omp` ([`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)) v0.60.0+
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — any version exposing `/v1/models` and `/v1/chat/completions`

## License

MIT
