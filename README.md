# OmniRoute Pi Extension

A seamless [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) extension that brings [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — the ultimate AI gateway — directly into your editor environment.

Connect to your local or remote OmniRoute server, browse models, manage combos, check quotas, and intelligently route your Pi queries across 44+ LLM providers.

## Features

- 🔮 **Wizard-Based Setup**: Just run `/omni setup` inside Pi. No manual JSON editing needed.
- ⚡ **Pure HTTP Client**: Works securely and seamlessly whether your OmniRoute server is running locally on `localhost:20128` or hosted on a remote VPS.
- 🔄 **Combo & Model Sync**: Instantly push all OmniRoute combos and available models into Pi’s `Ctrl+P` model picker with full metadata (context windows, max tokens, reasoning support, and vision capabilities).
- 🧬 **Smart Sorting**: Syncing organizes your model list by provider/group (`owned_by`) for a cleaner `Ctrl+P` experience.
- 📊 **Real-time Routing Feedback**: Status bar dynamically shows which model *actually* served each response.
- 🛠️ **Diagnostics & Health**: Spot expired tokens, connection failures, or disconnected providers right when Pi starts.
- 📉 **Quota Management**: Live usage tracking mapped directly to OmniRoute's global quota endpoints.

## Installation

```bash
pi install git:github.com/md-riaz/omniroute-pi-ext-integration
```

## Getting Started

1. **Start Pi:**
   ```bash
   pi
   ```
2. **Run Setup:** Once Pi starts, open the command palette and run:
   ```bash
   /omni setup
   ```
3. **Enter Credentials:** Enter your OmniRoute Server URL and your API Key when prompted.
4. **Sync Models:** Run `/omni sync` to populate the `Ctrl+P` list with all your provider models and combos.

## Commands Reference

| Command | Description |
|---------|-------------|
| `/omni setup` | Launch interactive wizard to link Pi with your OmniRoute gateway |
| `/omni` | Dashboard showing server health, active connections, and combos |
| `/omni combos` | View and edit your routing combos directly from Pi |
| `/omni providers` | Browse active providers, connection statuses, and node lists |
| `/omni health` | Run an automated diagnostic check for token expiry and broken models |
| `/omni limits` | View server-side API quotas and rate limit usage |
| `/omni sync` | Sync your Pi model picker with all healthy OmniRoute instances |
| `/omni dashboard` | Get the direct link to your OmniRoute web interface |

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) v0.60.0+
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) v2.9.0+

## License

MIT
