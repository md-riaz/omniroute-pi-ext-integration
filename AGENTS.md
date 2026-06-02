# AGENTS.md

Instructions for AI agents working in this repository.

## Start Here

Before editing, read:

1. `AI.md` — fast project handoff and key function map.
2. `ARCHITECTURE.md` — extension data flow and prompt-tool design.
3. `README.md` — user-facing behavior and commands.
4. `CONTRIBUTING.md` — local checks and contribution rules.

## Must-Do Documentation Rule

If you change source behavior, update docs in the same change.

Use this mapping:

| Change type | Docs to update |
|---|---|
| User-visible command/setup/model behavior | `README.md` |
| Provider flow, tool routing, prompt-tool logic | `ARCHITECTURE.md` |
| File layout, key function names, scan paths, pitfalls | `AI.md` |
| Dev workflow, tests, contribution process | `CONTRIBUTING.md` |
| Package scripts/deps | `README.md` Development section and `CONTRIBUTING.md` if relevant |

Do not leave code/docs inconsistent.

## Core UX Constraint

Keep model switching normal:

```text
/model <model-id>
```

Do not introduce duplicate providers or separate manual prompt-tool model lists unless user explicitly asks.

The provider should remain:

```text
omni
```

## Prompt Tool Constraint

Chat-only models should use prompt-emulated tools automatically when:

- model id/name/provider contains `-web`
- or raw `models.json` model entry has `tool_calling:false`

Do not rely only on Pi runtime `Model` for custom metadata. Pi strips unknown fields; use raw `models.json` when needed.

## Test Before Reporting Done

Run:

```bash
npm run typecheck
npm run smoke
```

If tests cannot run, report exact command and failure.

## Edit Guidance

- Prefer small targeted edits.
- Keep comments on non-obvious functions.
- Preserve `/omni setup`, `/omni sync`, `/omni dashboard` behavior unless user asks to change it.
- Keep prompt-tool format and parser docs in sync.
- If adding files, update `AI.md` file map.

## Important Files

| File | Why important |
|---|---|
| `index.ts` | Extension implementation. |
| `AI.md` | AI scan guide; update when project structure/function map changes. |
| `ARCHITECTURE.md` | Data flow and tool routing docs. |
| `README.md` | User-facing documentation. |
| `CONTRIBUTING.md` | Dev/test workflow. |
| `package.json` | Pi extension metadata and scripts. |
