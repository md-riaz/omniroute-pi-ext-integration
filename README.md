# omniroute-agent-extension

OmniRoute extension for [Pi Coding Agent](https://pi.dev) (`pi`) and [Oh My Pi](https://omp.sh) (`omp`).

Connects to your local or remote OmniRoute server, syncs models into the `Ctrl+P` picker with full metadata, and routes tool calls through a prompt-emulated fallback for chat-only web models.

## Installation

**Pi Coding Agent:**

```bash
pi install omniroute-agent-extension
```

```bash
pi install git:github.com/md-riaz/omniroute-pi-ext-integration
```

**Oh My Pi:**

```bash
omp install omniroute-agent-extension
```

```bash
omp install git:github.com/md-riaz/omniroute-pi-ext-integration
```

## Getting Started

1. Start your CLI (`pi` or `omp`)
2. Run `/omni setup` — enter your OmniRoute server URL and API key
3. Run `/omni sync` — populates the `Ctrl+P` model picker
4. Use `/model` as normal

Config is written to `~/.pi/agent/omniroute-agent-extension/config.json` (pi) or `~/.omp/agent/omniroute-agent-extension/config.json` (omp). Environment overrides: `OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_PROVIDER_NAME`.

## Commands

| Command | Description |
|---|---|
| `/omni` | Server health and provider status |
| `/omni setup` | Configure server URL and API key |
| `/omni sync` | Fetch `/v1/models` and register the OmniRoute provider |
| `/omni models [search]` | Browse synced models with optional filter |
| `/omni test <model>` | Smoke-test `/v1/chat/completions` with a specific model |
| `/omni dashboard` | Show OmniRoute dashboard URL |
| `/omni config` | Show config and models.json paths with current settings |
| `/omni help` | Show command list |

## Agent Tools

`omniroute_status` — returns server reachability, config path, and provider name.

`omniroute_sync` — fetches `/v1/models` and re-registers the provider; equivalent to `/omni sync`.

## Prompt Tool Fallback

Models that do not return native `tool_calls` — typically web-synced models with `-web` in their ID, name, `owned_by`, or provider label — are routed through a prompt-emulated tool path.

The model receives tool schemas as a compact text protocol injected into the system prompt. Tool calls are parsed from `<tool_call>` XML blocks in the response and converted to Pi-native tool events.

```xml
<tool_call>
{"name":"read","arguments":{"path":"shared.ts"}}
</tool_call>
```

**Safety rule:** tool calls execute only when the entire assistant message is `<tool_call>` block(s) plus whitespace. Prose mixed with `<tool_call>` is treated as normal text — no tools execute.

**Protocol refresh:** full schema list on turn 1, compact argument-hint reminders on turns 2–5, full resend every 6 prompt-tool turns, after any tool-set change, or after malformed/mixed output.

**Detection:** prompt tool mode activates when the model's upstream ID/name/`owned_by`/provider contains `-web`, or when the synced `models.json` entry has `"tool_calling": false`.

Example synced model entry:

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

## Auto Models

The following virtual model IDs are always prepended to the synced list. OmniRoute resolves them server-side:

```
auto  auto/coding  auto/fast  auto/cheap  auto/offline  auto/smart  auto/lkgp
```

## Development

```bash
npm run typecheck   # tsc — zero errors
npm run smoke       # node --experimental-strip-types import check for omp.ts and pi.ts
```

| File | Purpose |
|---|---|
| `shared.ts` | All business logic — no CLI package imports; local `OmniPI` interface |
| `omp.ts` | Oh My Pi entry — `OMP_HOME` / `~/.omp/agent` |
| `pi.ts` | Pi Coding Agent entry — `PI_HOME` / `~/.pi/agent` |
| `AGENTS.md` | Instructions for AI agents editing this repo |
| `AI.md` | Fast handoff guide for AI agents and maintainers |
| `ARCHITECTURE.md` | Data flows and prompt-tool protocol details |
| `CONTRIBUTING.md` | Local setup, test checklist, contribution rules |

## Requirements

- `pi` ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) v0.60.0+ **or** `omp` ([`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)) v0.60.0+
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — any version exposing `/v1/models` and `/v1/chat/completions`

## License

MIT
