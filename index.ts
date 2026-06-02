/**
 * OmniRoute Manager — Pi Coding Agent Extension
 *
 * Public-only OmniRoute integration for pi.
 *
 * Commands:
 *   /omni                  — Status
 *   /omni sync             — Sync public OmniRoute models to pi's Ctrl+P picker
 *   /omni setup            — Setup OmniRoute URL and API key
 *   /omni dashboard        — Show OmniRoute web dashboard URL
 *
 * License: MIT
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	calculateCost,
	createAssistantMessageEventStream,
	getApiProvider,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { homedir } from "os";

const OMNI_PROMPT_TOOLS_API = "omni-prompt-tools";
const UNDERLYING_API = "openai-completions";

/** Resolve Pi's models.json path; PI_HOME lets tests/custom installs point elsewhere. */
function modelsJsonPath(): string {
	return process.env.PI_HOME
		? `${process.env.PI_HOME}/models.json`
		: `${homedir()}/.pi/agent/models.json`;
}

/** Read raw models.json because custom metadata like tool_calling is not preserved by Pi's Model type. */
function readModelsJson(): any {
	const fs = require("fs");
	return JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
}

/** Load OmniRoute base URL from models.json, falling back to local default before setup. */
function getOmniUrl(): string {
	try {
		const url = readModelsJson()?.providers?.omni?.baseUrl;
		if (url) return url.replace(/\/$/, "");
	} catch {}
	return "http://127.0.0.1:20128";
}

/** Load OmniRoute API key from models.json for direct extension HTTP calls. */
function getApiKey(): string {
	try {
		return readModelsJson()?.providers?.omni?.apiKey || "";
	} catch {
		return "";
	}
}

/** Check whether /omni setup has created a provider entry. */
function isOmniConfigured(): boolean {
	try {
		return !!readModelsJson()?.providers?.omni;
	} catch {
		return false;
	}
}

let OMNI_URL = getOmniUrl();
let DASHBOARD_URL = OMNI_URL;

/**
 * Register/refresh the omni provider with a custom stream handler.
 * This keeps /model UX unchanged while letting us choose native vs prompt tools at runtime.
 */
function registerOmniProvider(pi: ExtensionAPI): void {
	try {
		const provider = readModelsJson()?.providers?.omni;
		if (!provider) return;

		pi.registerProvider("omni", {
			name: "OmniRoute",
			baseUrl: (provider.baseUrl || OMNI_URL).replace(/\/$/, ""),
			// Pi/OpenAI SDK require a non-empty apiKey; OmniRoute may ignore this dummy for public/local setups.
			apiKey: provider.apiKey || "omniroute-public",
			api: OMNI_PROMPT_TOOLS_API,
			streamSimple: streamOmni,
			models: (provider.models || []).map((model: any) => ({
				id: model.id,
				name: model.name || humanName(model.id),
				api: OMNI_PROMPT_TOOLS_API,
				reasoning: model.reasoning ?? false,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input || ["text"],
				cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindow || 128000,
				maxTokens: model.maxTokens || 16384,
				headers: model.headers,
				compat: model.compat,
			})),
		});
	} catch {}
}

/** Call OmniRoute management/public API using saved URL/key. */
async function api(path: string, opts?: RequestInit): Promise<any> {
	const apiKey = getApiKey();
	const res = await fetch(`${OMNI_URL}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			...(opts?.headers || {}),
		},
		signal: AbortSignal.timeout(10000),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`${res.status}: ${body}`);
	}

	const text = await res.text();
	return text ? JSON.parse(text) : {};
}

/** Quick health probe used for status bar and /omni status. */
async function checkOmniRouteHealth(): Promise<boolean> {
	try {
		const apiKey = getApiKey();
		const res = await fetch(`${OMNI_URL}/v1/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(3000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

type SyncedModel = {
	id: string;
	name: string;
	owned_by?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	api?: string;
	tool_calling?: boolean;
};

/** Normalize OmniRoute modality names to Pi-supported input values. */
function normalizeModalities(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim().toLowerCase();
		if ((normalized === "text" || normalized === "image") && !out.includes(normalized)) {
			out.push(normalized);
		}
	}
	return out;
}

/** Filter out image-generation/non-chat models so Ctrl+P only shows usable chat models. */
function isPiChatModel(model: any): boolean {
	if (!model || typeof model !== "object") return true;
	const output = normalizeModalities(model.output_modalities ?? model.output);
	if (String(model.type || "chat").toLowerCase() === "image") return false;
	return output.length === 0 || output.includes("text");
}

/** Detect web-synced models whose native function calling is unreliable/missing. */
function isWebSyncedModel(...markers: unknown[]): boolean {
	return markers
		.filter((marker): marker is string => typeof marker === "string")
		.some((marker) => marker.toLowerCase().includes("-web"));
}

/** Read per-model tool_calling:false from models.json; Pi strips this custom field from runtime Model. */
function modelConfigToolCallingFalse(model: Pick<Model<any>, "id" | "provider">): boolean {
	try {
		const provider = readModelsJson()?.providers?.[model.provider];
		const configured = (provider?.models || []).find((m: any) => m?.id === model.id);
		return configured?.tool_calling === false || isWebSyncedModel(configured?.id, configured?.name, configured?.owned_by, configured?.provider);
	} catch {
		return false;
	}
}

/** Decide whether a model needs prompt-emulated tools instead of native OpenAI tool_calls. */
function shouldUsePromptTools(model: Pick<Model<any>, "id" | "name" | "provider">): boolean {
	return (
		modelConfigToolCallingFalse(model) ||
		isWebSyncedModel(model.id, model.name, model.provider) ||
		`${model.provider || ""}`.toLowerCase().includes("-web")
	);
}

const PROMPT_TOOL_FULL_REFRESH_TURNS = 6;
const PROMPT_TOOL_MAX_STATE_ENTRIES = 1000;

type PromptToolProtocolState = {
	toolSignature: string;
	protocolId: string;
	promptToolTurns: number;
	lastFullProtocolTurn: number;
	forceFullNextTurn: boolean;
};

type PromptToolProtocolSelection = {
	text: string;
};

/**
 * Runtime-only refresh state for prompt-tool instructions.
 *
 * Pi forwards `options.sessionId` to custom provider stream handlers, so we scope state by
 * session + model. This keeps one session/model from borrowing stale refresh counters from
 * another while avoiding any protocol persistence in the saved Pi conversation history.
 */
const promptToolProtocolStates = new Map<string, PromptToolProtocolState>();
let fullProtocolCache: { key: string; text: string } | undefined;

/** Stable cache key for the active tool set; any tool/schema change forces a fresh full protocol. */
function toolsSignature(tools: Tool[]): string {
	return JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters]));
}

/** Small deterministic hash used only for human-readable protocol IDs in reminders. */
function stableHash(input: string): string {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function protocolIdForSignature(signature: string): string {
	return `pi-tools-v1:${stableHash(signature)}`;
}

function promptToolStateKey(model: Model<any>, options?: SimpleStreamOptions): string {
	return [options?.sessionId || "no-session", model.provider, model.id].join(":");
}

function compactToolDescription(description: unknown): string {
	if (typeof description !== "string") return "";
	return description.replace(/\s+/g, " ").trim().slice(0, 180);
}

function compactToolParameters(parameters: unknown): string {
	try {
		return JSON.stringify(parameters ?? {});
	} catch {
		return "{}";
	}
}

/**
 * Render the full prompt-tool protocol.
 *
 * This contains every active Pi tool, including extension/custom tools, with compact minified
 * parameter schemas. It is intentionally not placed into `messages`; it is only appended to the
 * outbound system prompt for the current provider request.
 */
function renderFullToolProtocol(tools: Tool[], protocolId: string): string {
	const signature = toolsSignature(tools);
	const key = `full:${protocolId}:${signature}`;
	if (fullProtocolCache && fullProtocolCache.key === key) return fullProtocolCache.text;

	const lines: string[] = [
		"# Pi prompt tools",
		`Protocol id: ${protocolId}`,
		"Native/internal tool calls are unavailable for this chat-only model.",
		"To call tools, the entire assistant message must be only <tool_call> block(s), no prose/markdown/extra text.",
		"If any extra text appears beside <tool_call>, it is normal text and no tool executes.",
		"Format: <tool_call>{\"name\":\"tool_name\",\"arguments\":{}}</tool_call>",
		"Use valid JSON. arguments must be an object. After tool calls, stop and wait for <tool_result>.",
		"Never invent tool output. If no tool is needed, answer normally without <tool_call>.",
		"Available tools:",
	];

	for (const tool of tools) {
		const description = compactToolDescription(tool.description);
		const parameters = compactToolParameters(tool.parameters);
		lines.push(`- ${tool.name}${description ? `: ${description}` : ""}; parameters=${parameters}`);
	}

	const text = lines.join("\n");
	fullProtocolCache = { key, text };
	return text;
}

/**
 * Render the cheap steady-state reminder.
 *
 * Most prompt-tool turns use this instead of repeating every schema. The full protocol is resent
 * every PROMPT_TOOL_FULL_REFRESH_TURNS turns, whenever the tool set changes, or after parse
 * confusion so chat-only web models can recover when they forget exact rules/arguments.
 */
function compactToolReminderHint(tool: Tool): string {
	const parameters = compactToolParameters(tool.parameters);
	const cappedParameters = parameters.length > 300
		? `${parameters.slice(0, 300)}...`
		: parameters;
	return `${tool.name} parameters=${cappedParameters}`;
}

function renderToolProtocolReminder(tools: Tool[], protocolId: string): string {
	return [
		"# Pi prompt tools reminder",
		`Use protocol ${protocolId}.`,
		"Tool call format: <tool_call>{\"name\":\"tool_name\",\"arguments\":{}}</tool_call>",
		"Tool calls must be standalone assistant messages: no prose/markdown/extra text.",
		"Extra text beside <tool_call> means no tool executes.",
		"Compact argument hints:",
		...tools.map(compactToolReminderHint),
	].join("\n");
}

/** Choose full vs reminder protocol for this session/model/tool set and advance turn state. */
function selectPromptToolProtocol(
	model: Model<any>,
	tools: Tool[],
	options?: SimpleStreamOptions,
): PromptToolProtocolSelection {
	const key = promptToolStateKey(model, options);
	const signature = toolsSignature(tools);
	const protocolId = protocolIdForSignature(signature);
	const current = promptToolProtocolStates.get(key);
	const nextTurn = current ? current.promptToolTurns + 1 : 1;
	const toolSetChanged = !current || current.toolSignature !== signature;
	const refreshDue = current
		? nextTurn - current.lastFullProtocolTurn >= PROMPT_TOOL_FULL_REFRESH_TURNS
		: true;
	const sendFull = toolSetChanged || refreshDue || current?.forceFullNextTurn === true;

	// Pi extension hosts can live for many sessions. Bound the process-local state map so
	// refresh counters remain useful without growing indefinitely across old sessions.
	if (promptToolProtocolStates.size >= PROMPT_TOOL_MAX_STATE_ENTRIES && !promptToolProtocolStates.has(key)) {
		const oldestKey = promptToolProtocolStates.keys().next().value;
		if (oldestKey !== undefined) promptToolProtocolStates.delete(oldestKey);
	}

	promptToolProtocolStates.set(key, {
		toolSignature: signature,
		protocolId,
		promptToolTurns: nextTurn,
		lastFullProtocolTurn: sendFull ? nextTurn : current?.lastFullProtocolTurn ?? nextTurn,
		forceFullNextTurn: false,
	});

	return {
		text: sendFull
			? renderFullToolProtocol(tools, protocolId)
			: renderToolProtocolReminder(tools, protocolId),
	};
}

function forceFullProtocolNextTurn(model: Model<any>, options?: SimpleStreamOptions): void {
	const state = promptToolProtocolStates.get(promptToolStateKey(model, options));
	if (state) state.forceFullNextTurn = true;
}

/** Extract text blocks and drop unsupported content like images for plain chat endpoints. */
function textOf(content: string | (TextContent | { type: string })[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** Convert prior native Pi tool calls into text blocks chat-only models can read. */
function renderToolCallBlock(tc: ToolCall): string {
	return `<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.arguments })}\n</tool_call>`;
}

type FlattenableMessage = Message | { role: "system"; content: string | TextContent[]; timestamp?: number };

/** Flatten native Pi message history into user/assistant text history for non-tool-capable chat APIs. */
function flattenMessages(messages: FlattenableMessage[]): Message[] {
	const out: Message[] = [];
	const pushText = (role: "user" | "assistant", text: string) => {
		if (!text.trim()) return;
		const last = out[out.length - 1];
		if (last && last.role === role) {
			const block = (last.content as TextContent[])[0];
			block.text += `\n\n${text}`;
			return;
		}
		out.push({ role, content: [{ type: "text", text }], timestamp: Date.now() } as Message);
	};

	for (const msg of messages) {
		if (msg.role === "user") {
			pushText("user", textOf(msg.content));
		} else if (msg.role === "assistant") {
			const prose = textOf(msg.content);
			const calls = Array.isArray(msg.content)
				? msg.content.filter((c): c is ToolCall => c.type === "toolCall")
				: [];
			const parts = [prose, ...calls.map(renderToolCallBlock)].filter((s) => s.trim());
			pushText("assistant", parts.join("\n\n"));
		} else if (msg.role === "toolResult") {
			const body = textOf(msg.content);
			const tag = msg.isError ? "tool_result error" : "tool_result";
			pushText("user", `<${tag} tool="${msg.toolName}" id="${msg.toolCallId}">\n${body}\n</tool_result>`);
		} else if (msg.role === "system") {
			// Pi normally uses context.systemPrompt, but preserve unexpected system messages defensively.
			pushText("user", `<system>\n${textOf(msg.content)}\n</system>`);
		}
	}
	return out;
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/** Tolerate models that wrap tool JSON inside ```json fences despite instructions. */
function stripCodeFence(raw: string): string {
	return raw
		.replace(/^\s*```(?:json|JSON)?\s*\n?/, "")
		.replace(/\n?\s*```\s*$/, "")
		.trim();
}

/** Tolerate models that emit arguments as a JSON string instead of an object. */
function coerceArguments(value: unknown): Record<string, any> {
	if (value && typeof value === "object") return value as Record<string, any>;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object") return parsed as Record<string, any>;
		} catch {}
	}
	return {};
}

type ParseToolCallsResult = {
	prose: string;
	calls: { name: string; arguments: Record<string, any> }[];
	errors: string[];
	mixedToolCallText: boolean;
};

/**
 * Parse standalone <tool_call> messages and preserve parse errors as model-visible feedback.
 *
 * Mixed prose + <tool_call> remains safe: it is returned as normal prose and no tool executes.
 * The `mixedToolCallText` flag lets the next turn re-send the full protocol so the model can
 * recover from that confusion without showing noisy warnings for documentation/examples.
 */
function parseToolCalls(text: string): ParseToolCallsResult {
	const calls: { name: string; arguments: Record<string, any> }[] = [];
	const errors: string[] = [];
	const original = text.trim();
	if (!original) return { prose: "", calls, errors, mixedToolCallText: false };

	const openIdx = text.indexOf("<tool_call>");
	const hasToolCallText = openIdx !== -1 && text.indexOf("</tool_call>", openIdx) !== -1;
	TOOL_CALL_RE.lastIndex = 0;
	const remainder = text.replace(TOOL_CALL_RE, "").trim();
	if (remainder) {
		// Safety: examples or accidental <tool_call> snippets in prose must not execute.
		return { prose: original, calls: [], errors: [], mixedToolCallText: hasToolCallText };
	}

	let match: RegExpExecArray | null;
	TOOL_CALL_RE.lastIndex = 0;
	while ((match = TOOL_CALL_RE.exec(text)) !== null) {
		const body = stripCodeFence(match[1]);
		try {
			const parsed = JSON.parse(body);
			if (parsed && typeof parsed.name === "string") {
				calls.push({ name: parsed.name, arguments: coerceArguments(parsed.arguments) });
			} else {
				errors.push(`tool_call missing a string "name": ${body.slice(0, 200)}`);
			}
		} catch (e) {
			errors.push(`invalid JSON in <tool_call> (${e instanceof Error ? e.message : "parse error"}): ${body.slice(0, 200)}`);
		}
	}

	if (calls.length === 0 && errors.length === 0) {
		return { prose: original, calls, errors, mixedToolCallText: false };
	}
	return { prose: "", calls, errors, mixedToolCallText: false };
}

/**
 * Prompt-tool stream path for chat-only models.
 * It injects tool schemas as text, calls OmniRoute without native tools, then converts parsed blocks back to Pi toolCall events.
 */
function streamWithPromptTools(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			stream.push({ type: "start", partial: output });

			const tools = context.tools ?? [];
			const protocol = tools.length > 0
				? selectPromptToolProtocol(model, tools, options)
				: undefined;
			const innerContext: Context = {
				// Prompt-tool protocol stays ephemeral: it is appended only to this outbound
				// provider request, never to flattened message history or saved Pi session entries.
				systemPrompt: protocol
					? `${context.systemPrompt ?? ""}\n\n${protocol.text}`.trim()
					: context.systemPrompt,
				messages: flattenMessages(context.messages),
				tools: [],
			};

			const provider = getApiProvider(UNDERLYING_API);
			if (!provider) throw new Error(`Underlying api "${UNDERLYING_API}" is not registered`);

			const innerModel: Model<any> = { ...model, api: UNDERLYING_API };
			const inner = provider.streamSimple(innerModel, innerContext, options);
			// Prompt-tool mode is intentionally buffered: complete text is needed to parse <tool_call> blocks safely.
			const innerResult = await inner.result();

			output.usage = { ...innerResult.usage };
			output.responseId = innerResult.responseId;
			output.responseModel = innerResult.responseModel;
			if (innerResult.stopReason === "error" || innerResult.stopReason === "aborted") {
				output.stopReason = innerResult.stopReason;
				output.errorMessage = innerResult.errorMessage;
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
				return;
			}

			const rawText = textOf(innerResult.content as TextContent[]);
			const parsed = tools.length > 0
				? parseToolCalls(rawText)
				: { prose: rawText, calls: [], errors: [] as string[], mixedToolCallText: false };
			let prose = parsed.prose;

			if (parsed.errors.length > 0 || parsed.mixedToolCallText) {
				forceFullProtocolNextTurn(model, options);
			}

			if (parsed.errors.length > 0) {
				const note = [
					"[omni-prompt-tools] Could not parse tool call(s). Re-emit each as:",
					'<tool_call>{"name":"tool_name","arguments":{}}</tool_call>',
					...parsed.errors.map((e) => `- ${e}`),
				].join("\n");
				prose = prose ? `${prose}\n\n${note}` : note;
			}

			if (prose) {
				output.content.push({ type: "text", text: prose });
				const idx = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: idx, partial: output });
				stream.push({ type: "text_delta", contentIndex: idx, delta: prose, partial: output });
				stream.push({ type: "text_end", contentIndex: idx, content: prose, partial: output });
			}

			parsed.calls.forEach((call, i) => {
				const id = `call_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 8)}`;
				const toolCall: ToolCall = { type: "toolCall", id, name: call.name, arguments: call.arguments };
				output.content.push(toolCall);
				const idx = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: idx, delta: JSON.stringify(call.arguments), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
			});

			output.stopReason = parsed.calls.length > 0 ? "toolUse" : "stop";
			calculateCost(model, output.usage);
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/** Main provider stream router: web/tool_calling:false models use prompt tools; all others use native tools. */
function streamOmni(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (shouldUsePromptTools(model)) return streamWithPromptTools(model, context, options);

	const provider = getApiProvider(UNDERLYING_API);
	if (!provider) throw new Error(`Underlying api "${UNDERLYING_API}" is not registered`);
	return provider.streamSimple({ ...model, api: UNDERLYING_API }, context, options);
}

/** Merge duplicate OmniRoute model IDs while preserving best metadata from each source row. */
function upsertSyncedModel(models: SyncedModel[], next: SyncedModel): void {
	const index = models.findIndex((model) => model.id === next.id);
	if (index < 0) {
		models.push(next);
		return;
	}

	const existing = models[index];
	const input = Array.from(new Set([...(existing.input || []), ...(next.input || [])]));
	models[index] = {
		...existing,
		...next,
		input: input.length > 0 ? input : existing.input,
		contextWindow: next.contextWindow ?? existing.contextWindow,
		maxTokens: next.maxTokens ?? existing.maxTokens,
		reasoning: existing.reasoning || next.reasoning,
	};
}

/** Fetch OmniRoute /v1/models and convert rows into Pi models.json entries. */
async function getAllModelsFromOmniRoute(): Promise<SyncedModel[]> {
	const results: SyncedModel[] = [];
	const data = await api("/v1/models");
	const models = data?.data || [];

	for (const m of models) {
		const id = typeof m === "string" ? m : m.id;
		if (!id || !isPiChatModel(m)) continue;

		const synced: SyncedModel = {
			id,
			name: humanName(id),
			owned_by: m.owned_by,
			api: OMNI_PROMPT_TOOLS_API,
		};

		if (isWebSyncedModel(id, m.name, m.owned_by, m.provider)) synced.tool_calling = false;

		const input = normalizeModalities(m.input_modalities ?? m.input);
		synced.input = input.length > 0 ? input : ["text"];

		const contextWindow = m.context_length || m.max_input_tokens;
		if (contextWindow) synced.contextWindow = contextWindow;

		const maxTokens = m.max_output_tokens || m.max_tokens;
		if (maxTokens) synced.maxTokens = maxTokens;

		if (m.capabilities?.reasoning || m.capabilities?.thinking) synced.reasoning = true;

		upsertSyncedModel(results, synced);
	}

	return results
		.sort((a, b) => {
			const ownedA = a.owned_by || "zz";
			const ownedB = b.owned_by || "zz";
			if (ownedA !== ownedB) return ownedA.localeCompare(ownedB);
			return a.id.localeCompare(b.id);
		})
		.map(({ owned_by, ...rest }) => rest);
}

/** Convert provider/model-id strings into friendlier Ctrl+P labels. */
function humanName(id: string): string {
	const parts = id.split("/");
	const provider = parts.length > 1 ? parts[0] : "";
	const model = parts.length > 1 ? parts.slice(1).join("/") : parts[0];

	let name = model
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());

	if (provider && name.toLowerCase().startsWith(provider.toLowerCase())) {
		name = name.slice(provider.length).trim();
		if (!name) name = model;
		name = name.charAt(0).toUpperCase() + name.slice(1);
	}

	return name;
}

export default function (pi: ExtensionAPI) {
	let healthInterval: ReturnType<typeof setInterval> | undefined;
	registerOmniProvider(pi);

	pi.on("model_select", async (event: any, ctx: any) => {
		try {
			const modelId = (event.model as any)?.id ?? "";
			if (modelId) ctx.ui.setStatus("omni", `→ ${modelId}`);
		} catch {}
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!isOmniConfigured()) {
			ctx.ui.setStatus("omni", "OmniRoute (unconfigured)");
			ctx.ui.notify("OmniRoute is unconfigured. Run /omni setup to connect it.", "warning");
			return;
		}

		const healthy = await checkOmniRouteHealth();
		ctx.ui.setStatus("omni", healthy ? "OmniRoute ✓" : "OmniRoute ✗");

		if (healthy) {
			ctx.ui.notify("OmniRoute ready — public model API available", "info");
		} else {
			ctx.ui.notify(
				`OmniRoute not reachable at ${OMNI_URL}\n\nCheck your URL setting or run /omni setup.`,
				"warning"
			);
		}

		healthInterval = setInterval(async () => {
			const h = await checkOmniRouteHealth();
			if (!h) ctx.ui.setStatus("omni", "OmniRoute ✗");
		}, 60_000);
	});

	pi.on("session_shutdown", async () => {
		if (healthInterval) clearInterval(healthInterval);
	});

	pi.registerCommand("omni", {
		description: "OmniRoute: /omni [sync|setup|dashboard]",
		getArgumentCompletions(prefix: string) {
			return ["sync", "setup", "dashboard"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		async handler(args: string, ctx: any) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "";

			if (!sub) {
				const healthy = await checkOmniRouteHealth();
				ctx.ui.notify([
					"═══ OmniRoute Status ═══",
					"",
					`  OmniRoute: ${healthy ? "✅ healthy" : "❌ DOWN"} (${OMNI_URL})`,
					"  Mode: public model API only",
					"",
					"Supported:",
					"  /omni sync            Sync public /v1/models to Ctrl+P picker",
					"  /omni setup           Save OmniRoute URL and API key",
					"  /omni dashboard       Show dashboard URL",
				].join("\n"), "info");
				ctx.ui.setStatus("omni", healthy ? "OmniRoute ✓" : "OmniRoute ✗");
				return;
			}

			if (sub === "sync") {
				ctx.ui.notify("Syncing models from OmniRoute to Ctrl+P picker...", "info");

				try {
					const allModels = await getAllModelsFromOmniRoute();
					const fs = require("fs");
					const path = modelsJsonPath();
					const config = JSON.parse(fs.readFileSync(path, "utf8"));

					if (!config.providers?.omni) {
						ctx.ui.notify(
							"No 'omni' provider found in models.json.\n" +
							"Run /omni setup first.",
							"error"
						);
						return;
					}

					const oldCount = config.providers.omni.models?.length || 0;
					config.providers.omni.models = allModels;
					fs.writeFileSync(path, JSON.stringify(config, null, 2));

					ctx.modelRegistry.refresh();
					registerOmniProvider(pi);

					ctx.ui.notify(
						`✅ Synced ${allModels.length} models to Ctrl+P (was ${oldCount})`,
						"info"
					);
				} catch (e: any) {
					ctx.ui.notify(`Sync failed: ${e.message}`, "error");
				}
				return;
			}

			if (sub === "setup") {
				const fs = require("fs");
				const path = modelsJsonPath();

				const urlInput = await ctx.ui.input(
					"OmniRoute URL",
					"e.g. http://localhost:20128"
				);
				if (!urlInput) return;
				const baseUrl = urlInput.trim().replace(/\/$/, "");

				// Ask for API Key before testing connectivity: some remote OmniRoute
				// instances require Authorization even for /v1/models.
				const apiKey = await ctx.ui.input(
					"OmniRoute API Key",
					"Enter your API key or press enter to leave blank"
				);
				if (apiKey === undefined) return;
				const trimmedApiKey = apiKey.trim();

				try {
					const res = await fetch(`${baseUrl}/v1/models`, {
						headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : {},
						signal: AbortSignal.timeout(3000),
					});
					if (!res.ok) {
						const body = (await res.text()).slice(0, 200);
						ctx.ui.notify(
							`OmniRoute unreachable at ${baseUrl} (${res.status})${body ? `: ${body}` : ""}`,
							"error"
						);
						return;
					}
				} catch (e: any) {
					ctx.ui.notify(`OmniRoute unreachable at ${baseUrl}: ${e.message}`, "error");
					return;
				}

				try {
					let config: any = {};
					try {
						config = JSON.parse(fs.readFileSync(path, "utf8"));
					} catch {}

					if (!config.providers) config.providers = {};
					config.providers.omni = {
						baseUrl,
						api: OMNI_PROMPT_TOOLS_API,
						apiKey: trimmedApiKey,
						models: [],
					};

					fs.writeFileSync(path, JSON.stringify(config, null, 2));

					OMNI_URL = baseUrl;
					DASHBOARD_URL = baseUrl;
					registerOmniProvider(pi);

					ctx.ui.notify(
						"✅ OmniRoute setup complete and saved to models.json\n\n" +
						"Run /omni sync to pull models into the Ctrl+P picker.",
						"info"
					);
				} catch (e: any) {
					ctx.ui.notify(`Failed to save to models.json: ${e.message}`, "error");
				}
				return;
			}

			if (sub === "dashboard" || sub === "dash") {
				ctx.ui.notify(
					[
						`OmniRoute Dashboard: ${DASHBOARD_URL}`,
						"",
						"Open in your browser to manage combos, providers, usage, and request logs.",
					].join("\n"),
					"info"
				);
				return;
			}

			ctx.ui.notify(
				`Unknown: /omni ${sub}\n\nAvailable: sync, setup, dashboard`,
				"warning"
			);
		},
	});
}
