# Architecture

## Overview

This extension is a single-file Pi extension (`index.ts`) that integrates OmniRoute with Pi Coding Agent.

```text
Pi CLI
  -> loads extension from package.json pi.extensions
  -> extension registers /omni command
  -> extension registers omni provider
  -> user selects models with /model
  -> streamOmni() chooses native tools or prompt tools per selected model
```

## Data Flow: Setup

```text
/omni setup
  -> ask user for OmniRoute URL
  -> ask user for API key
  -> verify URL with authenticated GET /v1/models when key is present
  -> write ~/.pi/agent/models.json
  -> register/refresh omni provider
```

Saved provider shape:

```json
{
  "providers": {
    "omni": {
      "baseUrl": "https://example.com",
      "api": "omni-prompt-tools",
      "apiKey": "...",
      "models": []
    }
  }
}
```

## Data Flow: Sync

```text
/omni sync
  -> GET {OMNI_URL}/v1/models
  -> filter non-chat/image-only models
  -> normalize input modalities
  -> copy context/max token/reasoning metadata
  -> mark models with -web in id/name/provider/owned_by as tool_calling:false
  -> write config.providers.omni.models
  -> refresh Pi model registry
  -> re-register omni provider
```

## Data Flow: Native Tool Model

```text
Pi agent
  -> streamOmni(model, context, options)
  -> shouldUsePromptTools(model) === false
  -> getApiProvider("openai-completions")
  -> provider.streamSimple(model, context, options)
  -> OmniRoute receives native tools
  -> model returns native tool_calls
  -> Pi executes tools
```

## Data Flow: Chat-Only / Prompt Tool Model

```text
Pi agent
  -> streamOmni(model, context, options)
  -> shouldUsePromptTools(model) === true
  -> streamWithPromptTools(model, context, options)
  -> renderToolProtocol(context.tools)
  -> flattenMessages(context.messages)
  -> call openai-completions with tools: []
  -> parse <tool_call> blocks from full text response
  -> emit Pi-native toolcall_* stream events
  -> Pi executes tools
```

## Why `models.json` Is Re-read

Pi parses configured models into runtime `Model` objects. Its schema keeps supported fields like:

```text
id, name, api, provider, baseUrl, reasoning, input, contextWindow, maxTokens, compat
```

Custom synced fields like this are not preserved:

```json
"tool_calling": false
```

So `modelConfigToolCallingFalse()` reads raw `models.json` to recover that field at request time.

## Tool Mode Algorithm

```ts
promptTools =
  modelConfigToolCallingFalse(model) ||
  id/name/provider contains "-web" ||
  synced raw owned_by/provider marker contained "-web"
```

If `promptTools` is false, native OpenAI-compatible tool calling is used.

## Prompt Tool Design

Prompt mode uses this text protocol:

```xml
<tool_call>
{"name":"tool_name","arguments":{}}
</tool_call>
```

Why XML-like tags:

- easier to parse than arbitrary JSON in prose
- allows normal answer text before tool call
- supports multiple tool calls
- can replay history using same structure

## Stream Event Conversion

`streamWithPromptTools()` builds an `AssistantMessage` manually and pushes event stream entries:

```text
start
text_start/text_delta/text_end       if prose exists
toolcall_start/toolcall_delta/toolcall_end for each parsed call
done(reason: "toolUse" | "stop")
```

This makes Pi's normal agent loop execute tools, even though upstream model only wrote text.

## Known Trade-offs

- Prompt mode is buffered: it waits for full model output before parsing tool calls.
- Images in history/tool results are dropped in prompt mode.
- Small models may emit malformed JSON; parse errors are returned as visible assistant text so the model can self-correct next turn.
- Prompt tool calls are only as reliable as model instruction following.

## API Key Handling

`/omni setup` asks for the API key before testing `/v1/models` because protected remote OmniRoute deployments can require Authorization even for model listing. The key may still be blank for local/public deployments. Pi's provider registry and OpenAI-compatible SDK path require a non-empty API key string when registering custom models, so provider registration uses a harmless dummy value (`omniroute-public`) only when the saved key is empty. Real OmniRoute requests use the saved key when present.

## Extension Boundaries

This repo does not implement OmniRoute itself. It only:

- calls OmniRoute `/v1/models`
- routes chat completions through Pi's built-in `openai-completions` provider
- stores Pi config in `models.json`
- registers Pi commands/provider
