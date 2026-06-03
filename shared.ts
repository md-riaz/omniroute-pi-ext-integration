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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as Typebox from "typebox/type";

// ─── Local CLI interface — no import from either CLI package ──────────────────
interface OmniPI {
	registerProvider(name: string, config: any): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: any;
		execute(id: string, params: any, signal?: AbortSignal, onUpdate?: (p: any) => void, ctx?: any): Promise<any>;
	}): void;
	registerCommand(
		name: string,
		opts: {
			description: string;
			getArgumentCompletions?(prefix: string): { value: string; label: string }[];
			handler(args: string, ctx: any): Promise<void>;
		},
	): void;
	on(event: string, handler: (event: any, ctx: any) => any): void;
}

// ─── Public export ────────────────────────────────────────────────────────────
export interface AgentHomeOptions {
	homeEnvVar: string;
	defaultHome: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────
interface OmniConfig {
	serverUrl: string;
	apiKey: string;
	providerName: string;
}

interface OmniApiModel {
	id?: string;
	name?: string;
	owned_by?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_tokens?: number;
	reasoning?: boolean;
	capabilities?: { reasoning?: boolean; thinking?: boolean };
	input_modalities?: unknown;
	input?: unknown;
	output_modalities?: unknown;
	output?: unknown;
	type?: string;
	provider?: string;
	tool_calling?: boolean;
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

type ProviderModelConfig = {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────
const OMNI_PROMPT_TOOLS_API = "omni-prompt-tools";
const UNDERLYING_API = "openai-completions";
const AUTO_MODELS = ["auto", "auto/coding", "auto/fast", "auto/cheap", "auto/offline", "auto/smart", "auto/lkgp"];
const EXTENSION_STATE_DIR = "omniroute-agent-extension";
const DEFAULT_CONFIG: OmniConfig = {
	serverUrl: "http://127.0.0.1:20128",
	apiKey: "",
	providerName: "omni",
};

// ─── Path helpers ─────────────────────────────────────────────────────────────
function resolveAgentHome(opts: AgentHomeOptions): string {
	const env = process.env[opts.homeEnvVar];
	if (env) return env;
	const parts = opts.defaultHome.replace(/^~\//, "").split("/");
	return join(homedir(), ...parts);
}

function configPath(agentHome: string): string {
	return join(agentHome, EXTENSION_STATE_DIR, "config.json");
}

function modelsJsonPath(agentHome: string): string {
	return join(agentHome, "models.json");
}

// ─── Config I/O ───────────────────────────────────────────────────────────────
function normalizeServerUrl(value: string): string {
	let url = value.trim().replace(/\/+$/, "");
	if (url.endsWith("/v1")) url = url.slice(0, -3);
	return url || DEFAULT_CONFIG.serverUrl;
}

function sanitizeConfig(input: Partial<OmniConfig>): OmniConfig {
	return {
		serverUrl: normalizeServerUrl(String(input.serverUrl || DEFAULT_CONFIG.serverUrl)),
		apiKey: String(input.apiKey ?? ""),
		providerName: String(input.providerName || DEFAULT_CONFIG.providerName).trim() || DEFAULT_CONFIG.providerName,
	};
}

function loadConfig(agentHome: string): OmniConfig {
	const env: Partial<OmniConfig> = {};
	if (process.env.OMNIROUTE_URL) env.serverUrl = process.env.OMNIROUTE_URL;
	if (process.env.OMNIROUTE_API_KEY) env.apiKey = process.env.OMNIROUTE_API_KEY;
	if (process.env.OMNIROUTE_PROVIDER_NAME) env.providerName = process.env.OMNIROUTE_PROVIDER_NAME;
	try {
		return sanitizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath(agentHome), "utf8")), ...env });
	} catch {
		return sanitizeConfig({ ...DEFAULT_CONFIG, ...env });
	}
}

function saveConfig(agentHome: string, config: OmniConfig): void {
	const path = configPath(agentHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(sanitizeConfig(config), null, 2));
}

function readModelsJson(agentHome: string): any {
	try {
		return JSON.parse(readFileSync(modelsJsonPath(agentHome), "utf8"));
	} catch {
		return {};
	}
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function authHeaders(config: OmniConfig): Record<string, string> {
	return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

async function requestJson(config: OmniConfig, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
	const res = await fetch(`${config.serverUrl}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...authHeaders(config), ...(init.headers ?? {}) },
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	if (!res.ok) throw Object.assign(new Error(`${res.status}: ${text || res.statusText}`), { status: res.status });
	return text ? JSON.parse(text) : {};
}

async function checkHealth(config: OmniConfig): Promise<boolean> {
	try {
		const res = await fetch(`${config.serverUrl}/v1/models`, {
			headers: authHeaders(config),
			signal: AbortSignal.timeout(3_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ─── Model utilities ──────────────────────────────────────────────────────────
function normalizeModalities(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const normalized = String(item).trim().toLowerCase();
		if ((normalized === "text" || normalized === "image") && !out.includes(normalized)) out.push(normalized);
	}
	return out;
}

function isPiChatModel(model: OmniApiModel): boolean {
	const output = normalizeModalities(model.output_modalities ?? model.output);
	if (String(model.type || "chat").toLowerCase() === "image") return false;
	return output.length === 0 || output.includes("text");
}

function isWebSyncedModel(...markers: unknown[]): boolean {
	return markers
		.filter((m): m is string => typeof m === "string")
		.some((m) => m.toLowerCase().includes("-web"));
}

function upsertSyncedModel(models: SyncedModel[], next: SyncedModel): void {
	const index = models.findIndex((m) => m.id === next.id);
	if (index < 0) {
		models.push(next);
		return;
	}
	const existing = models[index];
	const input = Array.from(new Set([...(existing.input ?? []), ...(next.input ?? [])]));
	models[index] = {
		...existing,
		...next,
		input: input.length > 0 ? input : existing.input,
		contextWindow: next.contextWindow ?? existing.contextWindow,
		maxTokens: next.maxTokens ?? existing.maxTokens,
		reasoning: existing.reasoning || next.reasoning,
	};
}

function sortKey(id: string): string {
	const autoIdx = AUTO_MODELS.indexOf(id);
	if (autoIdx >= 0) return `0:${String(autoIdx).padStart(3, "0")}`;
	return `1:${id}`;
}

// ─── Sync + persistence ───────────────────────────────────────────────────────
async function fetchSyncedModels(config: OmniConfig): Promise<SyncedModel[]> {
	const data = await requestJson(config, "/v1/models");
	const rawModels: any[] = Array.isArray(data?.data) ? data.data : [];
	const results: SyncedModel[] = [];

	for (const m of rawModels) {
		const id = typeof m === "string" ? m : m?.id;
		if (!id || !isPiChatModel(m)) continue;

		const synced: SyncedModel = {
			id,
			name: m.name ?? id,
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

		if (m.reasoning || m.capabilities?.reasoning || m.capabilities?.thinking) synced.reasoning = true;

		upsertSyncedModel(results, synced);
	}

	return results
		.sort((a, b) => {
			const oa = a.owned_by || "zz";
			const ob = b.owned_by || "zz";
			if (oa !== ob) return oa.localeCompare(ob);
			return a.id.localeCompare(b.id);
		})
		.map(({ owned_by: _owned_by, ...rest }) => rest);
}

function buildProviderModelConfig(m: SyncedModel): ProviderModelConfig {
	return {
		id: m.id,
		name: m.name,
		api: OMNI_PROMPT_TOOLS_API,
		reasoning: m.reasoning ?? false,
		input: m.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 16_384,
	};
}

function buildAutoModel(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		api: OMNI_PROMPT_TOOLS_API,
		reasoning: id === "auto/coding" || id === "auto/smart",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

async function discoverModels(config: OmniConfig): Promise<ProviderModelConfig[]> {
	const synced = await fetchSyncedModels(config);
	const syncedIds = new Set(synced.map((m) => m.id));
	const autoModels = AUTO_MODELS.filter((id) => !syncedIds.has(id)).map(buildAutoModel);
	return [...autoModels, ...synced.map(buildProviderModelConfig)];
}

function buildProviderEntry(config: OmniConfig, models: ProviderModelConfig[]): any {
	return {
		name: "OmniRoute",
		baseUrl: `${config.serverUrl}/v1`,
		apiKey: config.apiKey || "omniroute-public",
		api: OMNI_PROMPT_TOOLS_API,
		authHeader: true,
		models,
	};
}

function persistModelsJson(agentHome: string, config: OmniConfig, models: ProviderModelConfig[]): void {
	const path = modelsJsonPath(agentHome);
	let file: any = {};
	try {
		file = JSON.parse(readFileSync(path, "utf8"));
	} catch {}
	if (!file.providers) file.providers = {};
	file.providers[config.providerName] = buildProviderEntry(config, models);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(file, null, 2));
}

async function registerOmniProvider(pi: OmniPI, agentHome: string, config: OmniConfig, streamFn: Function): Promise<ProviderModelConfig[]> {
	const models = await discoverModels(config);
	pi.registerProvider(config.providerName, { ...buildProviderEntry(config, models), streamSimple: streamFn });
	persistModelsJson(agentHome, config, models);
	return models;
}

function reloadProviderFromModelsJson(pi: OmniPI, agentHome: string, config: OmniConfig, streamFn: Function): void {
	try {
		const provider = readModelsJson(agentHome)?.providers?.[config.providerName];
		if (!provider) return;
		pi.registerProvider(config.providerName, { ...provider, streamSimple: streamFn });
	} catch {}
}

// ─── Display ──────────────────────────────────────────────────────────────────
function groupModels(models: ProviderModelConfig[]): Map<string, ProviderModelConfig[]> {
	const groups = new Map<string, ProviderModelConfig[]>();
	for (const m of models) {
		const group = AUTO_MODELS.includes(m.id) ? "auto" : m.id.includes("/") ? m.id.split("/")[0] : "direct";
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)!.push(m);
	}
	const entries = [...groups.entries()].sort(([a], [b]) => {
		if (a === "auto") return -1;
		if (b === "auto") return 1;
		return a.localeCompare(b);
	});
	return new Map(entries);
}

function modelLines(models: ProviderModelConfig[], query = "", limit = 80): string[] {
	const q = query.toLowerCase();
	const filtered = q ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : models;
	const sorted = [...filtered].sort((a, b) => sortKey(a.id).localeCompare(sortKey(b.id)) || a.id.localeCompare(b.id));
	const lines: string[] = [];
	for (const [group, gModels] of groupModels(sorted)) {
		lines.push(`-- ${group} (${gModels.length}) --`);
		for (const m of gModels) {
			const tags = [m.reasoning ? "reasoning" : "", m.input.includes("image") ? "vision" : ""].filter(Boolean).join(", ");
			lines.push(`  ${m.id} | ${m.contextWindow} ctx | ${m.maxTokens} out${tags ? ` | ${tags}` : ""}`);
			if (lines.length >= limit) break;
		}
		if (lines.length >= limit) break;
	}
	if (!filtered.length) lines.push("No models matched.");
	else if (filtered.length > limit) lines.push(`... ${filtered.length} total; refine with /omni models <search>`);
	return lines;
}

async function showStatus(ctx: any, agentHome: string, config: OmniConfig): Promise<void> {
	const ok = await checkHealth(config);
	const configured = existsSync(configPath(agentHome));
	ctx.ui.notify(
		[
			"OmniRoute Status",
			"",
			`Server:     ${config.serverUrl}`,
			`Provider:   ${config.providerName}`,
			`Health:     ${ok ? "reachable" : "unreachable"}`,
			`Configured: ${configured ? "yes" : "no — run /omni setup"}`,
		].join("\n"),
		ok ? "info" : "warning",
	);
}

function helpText(): string {
	return [
		"OmniRoute commands",
		"",
		"/omni                  Status",
		"/omni setup            Configure server URL and API key",
		"/omni sync             Sync models to Ctrl+P / /model picker",
		"/omni models [search]  Browse models",
		"/omni test <model>     Smoke-test /v1/chat/completions",
		"/omni dashboard        Show OmniRoute dashboard URL",
		"/omni config           Show config paths and current settings",
		"/omni help             Show this help",
	].join("\n");
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function runSetup(ctx: any, pi: OmniPI, agentHome: string, streamFn: Function): Promise<OmniConfig | undefined> {
	const current = loadConfig(agentHome);
	const serverUrl = await ctx.ui.input("OmniRoute server URL", current.serverUrl);
	if (serverUrl === undefined) return undefined;
	const apiKey = await ctx.ui.input(
		"OmniRoute API key",
		current.apiKey ? "(press enter to keep current)" : "(optional — press enter to skip)",
	);
	if (apiKey === undefined) return undefined;

	const next = sanitizeConfig({ ...current, serverUrl, apiKey: apiKey || current.apiKey });

	if (!(await checkHealth(next))) {
		ctx.ui.notify(`Cannot reach ${next.serverUrl}/v1/models.`, "error");
		return undefined;
	}

	saveConfig(agentHome, next);
	const models = await registerOmniProvider(pi, agentHome, next, streamFn);
	;(ctx as any).modelRegistry?.refresh?.();
	ctx.ui.notify(`Saved. Synced ${models.length} model(s).`, "info");
	return next;
}

async function testChat(config: OmniConfig, model: string): Promise<string> {
	const data = await requestJson(
		config,
		"/v1/chat/completions",
		{
			method: "POST",
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "Reply with exactly: ok" }],
				stream: false,
				max_tokens: 8,
			}),
		},
		20_000,
	);
	const content = data?.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : JSON.stringify(data).slice(0, 200);
}

// ─── Prompt-tool system ───────────────────────────────────────────────────────
const PROMPT_TOOL_FULL_REFRESH_TURNS = 6;
const PROMPT_TOOL_MAX_STATE_ENTRIES = 1000;

type PromptToolProtocolState = {
	toolSignature: string;
	protocolId: string;
	promptToolTurns: number;
	lastFullProtocolTurn: number;
	forceFullNextTurn: boolean;
};

const promptToolProtocolStates = new Map<string, PromptToolProtocolState>();
let fullProtocolCache: { key: string; text: string } | undefined;

function toolsSignature(tools: Tool[]): string {
	return JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters]));
}

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

function renderFullToolProtocol(tools: Tool[], protocolId: string): string {
	const signature = toolsSignature(tools);
	const key = `full:${protocolId}:${signature}`;
	if (fullProtocolCache?.key === key) return fullProtocolCache.text;

	const lines: string[] = [
		"# Pi prompt tools",
		`Protocol id: ${protocolId}`,
		"Native/internal tool calls are unavailable for this chat-only model.",
		"To call tools, the entire assistant message must be only <tool_call> block(s), no prose/markdown/extra text.",
		"If any extra text appears beside <tool_call>, it is normal text and no tool executes.",
		'Format: <tool_call>{"name":"tool_name","arguments":{}}</tool_call>',
		"Use valid JSON. arguments must be an object. After tool calls, stop and wait for <tool_result>.",
		"Never invent tool output. If no tool is needed, answer normally without <tool_call>.",
		"Available tools:",
	];

	for (const tool of tools) {
		const desc = compactToolDescription(tool.description);
		lines.push(`- ${tool.name}${desc ? `: ${desc}` : ""}; parameters=${compactToolParameters(tool.parameters)}`);
	}

	const text = lines.join("\n");
	fullProtocolCache = { key, text };
	return text;
}

function compactToolReminderHint(tool: Tool): string {
	const params = compactToolParameters(tool.parameters);
	return `${tool.name} parameters=${params.length > 300 ? `${params.slice(0, 300)}...` : params}`;
}

function renderToolProtocolReminder(tools: Tool[], protocolId: string): string {
	return [
		"# Pi prompt tools reminder",
		`Use protocol ${protocolId}.`,
		'Tool call format: <tool_call>{"name":"tool_name","arguments":{}}</tool_call>',
		"Tool calls must be standalone assistant messages: no prose/markdown/extra text.",
		"Extra text beside <tool_call> means no tool executes.",
		"Compact argument hints:",
		...tools.map(compactToolReminderHint),
	].join("\n");
}

function selectPromptToolProtocol(
	model: Model<any>,
	tools: Tool[],
	options?: SimpleStreamOptions,
): { text: string } {
	const key = promptToolStateKey(model, options);
	const signature = toolsSignature(tools);
	const protocolId = protocolIdForSignature(signature);
	const current = promptToolProtocolStates.get(key);
	const nextTurn = current ? current.promptToolTurns + 1 : 1;
	const toolSetChanged = !current || current.toolSignature !== signature;
	const refreshDue = current ? nextTurn - current.lastFullProtocolTurn >= PROMPT_TOOL_FULL_REFRESH_TURNS : true;
	const sendFull = toolSetChanged || refreshDue || current?.forceFullNextTurn === true;

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

function textOf(content: string | (TextContent | { type: string })[] | undefined | null): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextContent => !!c && "type" in c && c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

function renderToolCallBlock(tc: ToolCall): string {
	return `<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.arguments })}\n</tool_call>`;
}

type FlattenableMessage = Message | { role: "system"; content: string | TextContent[]; timestamp?: number };

function flattenMessages(messages: FlattenableMessage[]): Message[] {
	const out: Message[] = [];
	const pushText = (role: "user" | "assistant", text: string) => {
		if (!text.trim()) return;
		const last = out[out.length - 1];
		if (last?.role === role) {
			(last.content as TextContent[])[0].text += `\n\n${text}`;
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
			pushText("assistant", [prose, ...calls.map(renderToolCallBlock)].filter((s) => s.trim()).join("\n\n"));
		} else if ((msg as any).role === "toolResult") {
			const m = msg as any;
			const tag = m.isError ? "tool_result error" : "tool_result";
			pushText("user", `<${tag} tool="${m.toolName}" id="${m.toolCallId}">\n${textOf(m.content)}\n</tool_result>`);
		} else if (msg.role === "system") {
			pushText("user", `<system>\n${textOf(msg.content)}\n</system>`);
		}
	}
	return out;
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function stripCodeFence(raw: string): string {
	return raw
		.replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
		.replace(/\n?\s*```\s*$/, "")
		.trim();
}

function coerceArguments(value: unknown): Record<string, any> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, any>;
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

function parseToolCalls(text: string): ParseToolCallsResult {
	const calls: { name: string; arguments: Record<string, any> }[] = [];
	const errors: string[] = [];
	const cleaned = stripCodeFence(text);
	const original = cleaned.trim();
	if (!original) return { prose: "", calls, errors, mixedToolCallText: false };

	const openIdx = cleaned.indexOf("<tool_call>");
	const hasToolCallText = openIdx !== -1 && cleaned.indexOf("</tool_call>", openIdx) !== -1;
	TOOL_CALL_RE.lastIndex = 0;
	const remainder = cleaned.replace(TOOL_CALL_RE, "").trim();
	if (remainder) return { prose: text.trim(), calls: [], errors: [], mixedToolCallText: hasToolCallText };

	let match: RegExpExecArray | null;
	TOOL_CALL_RE.lastIndex = 0;
	while ((match = TOOL_CALL_RE.exec(cleaned)) !== null) {
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

	if (calls.length === 0 && errors.length === 0) return { prose: original, calls, errors, mixedToolCallText: false };
	return { prose: "", calls, errors, mixedToolCallText: false };
}

function streamWithPromptTools(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
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
			const protocol = tools.length > 0 ? selectPromptToolProtocol(model, tools, options) : undefined;
			const innerContext: Context = {
				// Protocol is ephemeral: appended only to this outbound request, never into flattened history.
				systemPrompt: protocol
					? `${context.systemPrompt ?? ""}\n\n${protocol.text}`.trim()
					: context.systemPrompt,
				messages: flattenMessages(context.messages),
				tools: [],
			};

			const provider = getApiProvider(UNDERLYING_API);
			if (!provider) throw new Error(`Underlying api "${UNDERLYING_API}" is not registered`);

			const inner = provider.streamSimple({ ...model, api: UNDERLYING_API }, innerContext, options);
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

// ─── Factory ──────────────────────────────────────────────────────────────────
export async function createOmniExtension(pi: OmniPI, opts: AgentHomeOptions): Promise<void> {
	const agentHome = resolveAgentHome(opts);
	let config = loadConfig(agentHome);
	let healthTimer: ReturnType<typeof setInterval> | undefined;

	function modelConfigToolCallingFalse(model: { id: string; provider: string }): boolean {
		try {
			const provider = readModelsJson(agentHome)?.providers?.[model.provider];
			const configured = (provider?.models ?? []).find((m: any) => m?.id === model.id);
			return (
				configured?.tool_calling === false ||
				isWebSyncedModel(configured?.id, configured?.name, configured?.owned_by, configured?.provider)
			);
		} catch {
			return false;
		}
	}

	function shouldUsePromptTools(model: { id: string; name?: string; provider: string }): boolean {
		return (
			modelConfigToolCallingFalse(model) ||
			isWebSyncedModel(model.id, model.name, model.provider) ||
			`${model.provider ?? ""}`.toLowerCase().includes("-web")
		);
	}

	function streamOmni(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		if (shouldUsePromptTools(model)) return streamWithPromptTools(model, context, options);
		const provider = getApiProvider(UNDERLYING_API);
		if (!provider) throw new Error(`Underlying api "${UNDERLYING_API}" is not registered`);
		return provider.streamSimple({ ...model, api: UNDERLYING_API }, context, options);
	}

	async function sync(ctx?: any): Promise<number> {
		config = loadConfig(agentHome);
		const models = await registerOmniProvider(pi, agentHome, config, streamOmni);
		;(ctx as any)?.modelRegistry?.refresh?.();
		ctx?.ui.notify(`OmniRoute synced ${models.length} model(s).`, "info");
		return models.length;
	}

	// On load: re-register from existing models.json (no network call)
	reloadProviderFromModelsJson(pi, agentHome, config, streamOmni);

	pi.on("session_start", async (_event: any, ctx: any) => {
		config = loadConfig(agentHome);
		if (!existsSync(configPath(agentHome)) && !process.env.OMNIROUTE_URL) {
			ctx.ui.setStatus("omni", "OmniRoute unconfigured");
			ctx.ui.notify("OmniRoute loaded. Run /omni setup to connect.", "warning");
			return;
		}
		const ok = await checkHealth(config);
		ctx.ui.setStatus("omni", ok ? undefined : "OmniRoute unreachable");
		if (!ok) ctx.ui.notify(`OmniRoute unreachable at ${config.serverUrl}. Run /omni sync after reconnecting.`, "warning");
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = setInterval(async () => {
			ctx.ui.setStatus("omni", (await checkHealth(loadConfig(agentHome))) ? undefined : "OmniRoute unreachable");
		}, 60_000);
	});

	pi.on("session_shutdown", () => {
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = undefined;
	});

	pi.on("model_select", async (event: any, ctx: any) => {
		const id = event.model?.id;
		if (id) ctx.ui.setStatus("omni", `→ ${id}`);
	});

	pi.registerTool({
		name: "omniroute_status",
		label: "OmniRoute Status",
		description: "Return OmniRoute health and provider registration status.",
		parameters: Typebox.Object({}),
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const ok = await checkHealth(cfg);
			const configured = existsSync(configPath(agentHome));
			return {
				content: [
					{
						type: "text" as const,
						text: `OmniRoute ${ok ? "reachable" : "unreachable"}; configured: ${configured}; provider: ${cfg.providerName}.`,
					},
				],
				details: { ok, configured, serverUrl: cfg.serverUrl, providerName: cfg.providerName },
			};
		},
	});

	pi.registerTool({
		name: "omniroute_sync",
		label: "OmniRoute Sync",
		description: "Fetch /v1/models from OmniRoute and register them as a provider.",
		parameters: Typebox.Object({}),
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const models = await registerOmniProvider(pi, agentHome, cfg, streamOmni);
			return {
				content: [{ type: "text" as const, text: `OmniRoute synced ${models.length} model(s).` }],
				details: { count: models.length, provider: cfg.providerName },
			};
		},
	});

	pi.registerCommand("omni", {
		description: "OmniRoute: /omni [setup|sync|models|test|dashboard|config|help]",
		getArgumentCompletions(prefix: string) {
			return ["setup", "sync", "models", "test", "dashboard", "config", "help"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
		},
		async handler(args: string, ctx: any) {
			const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = subRaw?.toLowerCase() ?? "";
			config = loadConfig(agentHome);

			try {
				if (!sub) return showStatus(ctx, agentHome, config);
				if (sub === "help") return ctx.ui.notify(helpText(), "info");

				if (sub === "setup") {
					const next = await runSetup(ctx, pi, agentHome, streamOmni);
					if (next) config = next;
					return;
				}

				if (sub === "sync") {
					await sync(ctx);
					return;
				}

				if (sub === "models") {
					const models = await discoverModels(config).catch(() => []);
					return ctx.ui.notify(
						[`OmniRoute models (${models.length})`, "", ...modelLines(models, rest.join(" "))].join("\n"),
						"info",
					);
				}

				if (sub === "test") {
					const model = rest.join(" ");
					if (!model) return ctx.ui.notify("Usage: /omni test <model>", "warning");
					const result = await testChat(config, model);
					return ctx.ui.notify(`Test ${model}: ${result}`, "info");
				}

				if (sub === "dashboard" || sub === "dash") {
					return ctx.ui.notify(`OmniRoute dashboard: ${config.serverUrl}`, "info");
				}

				if (sub === "config") {
					return ctx.ui.notify(
						[
							`Config:   ${configPath(agentHome)}`,
							`Models:   ${modelsJsonPath(agentHome)}`,
							`Configured: ${existsSync(configPath(agentHome)) ? "yes" : "no"}`,
							`Server:   ${config.serverUrl}`,
							`Provider: ${config.providerName}`,
						].join("\n"),
						"info",
					);
				}

				ctx.ui.notify(`Unknown /omni command '${sub}'.\n\n${helpText()}`, "warning");
			} catch (error) {
				ctx.ui.notify(`OmniRoute error: ${(error as Error).message}`, "error");
			}
		},
	});
}
