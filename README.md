# omniroute-agent-extension

[![npm version](https://img.shields.io/npm/v/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)
[![npm downloads](https://img.shields.io/npm/dm/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)

OmniRoute extension for [Pi Coding Agent](https://pi.dev) (`pi`) and [Oh My Pi](https://omp.sh) (`omp`).

Connect to your local or remote OmniRoute server and route queries across 44+ LLM providers directly from your agent CLI.

## Features

- **Wizard-based setup** — `/omni setup` inside `pi` or `omp`. No manual JSON editing.
- **Dual CLI support** — one package, identical feature set for both `pi` and `omp`.
- **Model sync** — push all OmniRoute models into the `Ctrl+P` / `/model` picker with full metadata: context windows, max tokens, reasoning, and vision capabilities.
- **Native tool calls** — the host's built-in `openai-completions` handler runs every request, so you get real SSE streaming and native `tool_calls` for all models.
- **Smart sorting** — models grouped by provider prefix, auto-routing models (`auto`, `auto/coding`, etc.) always first.
- **Health monitoring** — periodic reachability checks with status bar indicators.
- **Connection log** — every failed or abnormally slow connection attempt is appended as a JSON line to `<agent-home>/<state>/connection.log` for infra debugging; `ms` timings expose server cold starts, error fields include the fetch `cause` (e.g. `ECONNRESET`, `ETIMEDOUT`, TLS errors).
- **Catalog autosync** — while the harness is running, re-fetch `/v1/models` on session start and on a configurable interval (default 5 minutes). Manual `/omni sync` still works anytime; control with `/omni autosync on|off|<interval>`.
- **Env overrides** — `OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, and `OMNIROUTE_PROVIDER_NAME` skip the setup wizard entirely. `OMNIROUTE_AUTO_SYNC_INTERVAL_MS` overrides the catalog autosync interval.

## Installation

**Oh My Pi:**

```bash
omp install omniroute-agent-extension
```

```bash
omp install git:github.com/md-riaz/omniroute-agent-extension
```

**Pi Coding Agent:**

```bash
pi install omniroute-agent-extension
```

```bash
pi install git:github.com/md-riaz/omniroute-agent-extension
```

When replacing the earlier Pi-only `omniroute-pi-ext-integration`, existing `omni` catalog entries are normalized automatically on first load. Run `/omni sync` afterward to refresh the catalog from the server.

## Getting Started

1. Start your CLI (`pi` or `omp`)
2. Run `/omni setup` — enter your OmniRoute server URL and API key
3. Run `/omni sync` — populates the `Ctrl+P` / `/model` picker (optional after first session; catalog autosync also runs on session start)
4. Select any model with `/model` and start chatting

Config is saved to:

| CLI | Config path |
|---|---|
| `omp` | `~/.omp/agent/omniroute-agent-extension/config.json` |
| `pi` | `~/.pi/agent/omniroute-agent-extension/config.json` |

Synced models are written to `~/.omp/agent/models.json` (or `~/.pi/agent/models.json`) and reloaded on startup without a network call.

## Commands

| Command | Description |
|---|---|
| `/omni` | Server health and provider status |
| `/omni setup` | Configure server URL and API key interactively |
| `/omni sync` | Fetch `/v1/models` and register models in the picker |
| `/omni models [search]` | Browse synced models with optional keyword filter |
| `/omni log [lines]` | Show recent connection log entries from `connection.log` |
| `/omni test <model>` | Smoke-test `/v1/chat/completions` with a specific model |
| `/omni dashboard` | Show the OmniRoute dashboard URL |
| `/omni config` | Show config, models.json, and connection log paths with current settings |
| `/omni autosync [on\|off\|status\|<interval>]` | Enable, disable, or set background catalog discovery (default 5m) |
| `/omni help` | Show command list |

## Agent Tools

Two tools the LLM can call directly:

- **`omniroute_status`** — returns server reachability, config path, and provider name
- **`omniroute_sync`** — fetches `/v1/models` and re-registers the provider (same as `/omni sync`)

## How It Works

The extension registers OmniRoute as an `openai-completions` provider. After `/omni sync`, all models appear in the picker. Every request is handled natively by the host's built-in `openai-completions` handler — real SSE streaming, native `tool_calls`, no middleware.

```text
agent
  -> /model codex/gpt-5.2
  -> OmniRoute /v1/chat/completions (SSE stream)
  -> token-by-token output, native tool_calls
  -> agent executes tools
```

## Auto Models

These virtual model IDs are always prepended to the synced list. OmniRoute resolves them server-side to the best available model for each intent:

```
auto         auto/coding    auto/fast
auto/cheap   auto/offline   auto/smart   auto/lkgp
```

## Environment Variables

| Variable | Description |
|---|---|
| `OMNIROUTE_URL` | OmniRoute server base URL |
| `OMNIROUTE_API_KEY` | API key |
| `OMNIROUTE_PROVIDER_NAME` | Provider name shown in the picker (default: `omni`) |
| `OMNIROUTE_AUTO_SYNC_INTERVAL_MS` | Background catalog re-fetch interval in milliseconds. `0` disables autosync. Default `300000` (5 minutes). Minimum `60000`. |

When `OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, or `OMNIROUTE_PROVIDER_NAME` are set, `/omni setup` is not required.

## Development

```bash
npm run typecheck   # tsc — zero errors expected
npm test            # Node test suite (legacy catalog + autosync)
npm run smoke       # import check for omp.ts and pi.ts
```

| File | Purpose |
|---|---|
| `shared.ts` | All business logic — no host package imports; works in both `pi` and `omp` |
| `omp.ts` | Oh My Pi entry point — `OMP_HOME` / `~/.omp/agent` |
| `pi.ts` | Pi Coding Agent entry point — `PI_HOME` / `~/.pi/agent` |
| `scripts/sync-once.ts` | One-shot catalog sync helper for install/refresh scripts |

## Requirements

- `omp` ([`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)) v15.9.0+ **or** `pi` ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) v0.60.0+
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — any version exposing `/v1/models` and `/v1/chat/completions`

## License

MIT
