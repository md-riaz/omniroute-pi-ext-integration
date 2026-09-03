import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { registerGatewayTelemetry } from "./telemetry.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Local CLI interface — no import from either CLI package ──────────────────
export interface OmniPI {
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
}

type SyncedModel = {
	id: string;
	name: string;
	owned_by?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
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
const PROVIDER_API = "openai-completions";
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

// ─── Connection log (text file for infra debugging) ───────────────────────────
// Every health check and request that fails — and any health check that is
// abnormally slow — is appended as one JSON line per event, e.g.:
//   {"time":"...","event":"health","context":"interval","attempt":0,"ok":false,"ms":5194,"server":"https://...","error":"TimeoutError: The operation was aborted due to timeout"}
// Timings make server-side cold starts / edge latency visible; error fields
// (incl. fetch cause, e.g. ECONNRESET, ETIMEDOUT, TLS errors) distinguish
// server problems from local network issues. Capped to keep the file small.
const CONNECTION_LOG_MAX_BYTES = 256 * 1024;
const CONNECTION_LOG_MAX_LINES = 1000;
const CONNECTION_LOG_SLOW_MS = 1_000;

function connectionLogPath(agentHome: string): string {
	return join(agentHome, EXTENSION_STATE_DIR, "connection.log");
}

function errorBrief(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause = (err as { cause?: unknown }).cause;
	const causeMsg = cause instanceof Error ? cause.message : undefined;
	return [err.name, err.message, causeMsg].filter(Boolean).join(": ");
}

function appendConnectionLog(agentHome: string, entry: Record<string, unknown>): void {
	try {
		const path = connectionLogPath(agentHome);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { flag: "a" });
		let size = 0;
		try {
			size = statSync(path).size;
		} catch {}
		if (size > CONNECTION_LOG_MAX_BYTES) {
			const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			writeFileSync(path, lines.slice(-CONNECTION_LOG_MAX_LINES).join("\n") + "\n");
		}
	} catch {
		// logging must never break normal operation
	}
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

async function requestJson(config: OmniConfig, path: string, init: RequestInit = {}, timeoutMs = 10_000, agentHome?: string): Promise<any> {
	const started = Date.now();
	let res: Response;
	try {
		res = await fetch(`${config.serverUrl}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", ...authHeaders(config), ...(init.headers ?? {}) },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		if (agentHome)
			appendConnectionLog(agentHome, {
				event: "request",
				path,
				ok: false,
				timeoutMs,
				ms: Date.now() - started,
				server: config.serverUrl,
				error: errorBrief(err),
			});
		throw err;
	}
	const text = await res.text();
	if (!res.ok) {
		if (agentHome)
			appendConnectionLog(agentHome, {
				event: "request",
				path,
				ok: false,
				ms: Date.now() - started,
				status: res.status,
				server: config.serverUrl,
				error: (text || res.statusText).slice(0, 200),
			});
		throw Object.assign(new Error(`${res.status}: ${text || res.statusText}`), { status: res.status });
	}
	return text ? JSON.parse(text) : {};
}

// The origin can cold-start on the first request after idle (observed >5s
// via a proxy), so a tight timeout reports a false "unreachable" while real
// requests succeed. Match requestJson's 10s timeout and retry once: the first
// attempt warms the origin, the retry then succeeds in the common case.
async function checkHealth(agentHome: string, config: OmniConfig, context = "health"): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const started = Date.now();
		try {
			const res = await fetch(`${config.serverUrl}/v1/models`, {
				headers: authHeaders(config),
				signal: AbortSignal.timeout(10_000),
			});
			const ms = Date.now() - started;
			// The health check only needs the status code — release the body
			// stream (cancel, not read) so the socket/connection is freed
			// whether this attempt succeeds, fails, or is retried.
			try {
				await res.body?.cancel();
			} catch {
				// body teardown must never change the health result
			}
			if (res.ok) {
				// log slow successes — the cold-start signal that once caused
				// false "unreachable" status
				if (ms > CONNECTION_LOG_SLOW_MS)
					appendConnectionLog(agentHome, { event: "health", context, attempt, ok: true, ms, server: config.serverUrl });
				return true;
			}
			appendConnectionLog(agentHome, {
				event: "health",
				context,
				attempt,
				ok: false,
				ms,
				status: res.status,
				server: config.serverUrl,
				error: (res.statusText || `HTTP ${res.status}`).slice(0, 200),
			});
		} catch (err) {
			appendConnectionLog(agentHome, {
				event: "health",
				context,
				attempt,
				ok: false,
				ms: Date.now() - started,
				server: config.serverUrl,
				error: errorBrief(err),
			});
			// cold start / transient network blip — retry once
		}
	}
	return false;
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
async function fetchSyncedModels(config: OmniConfig, agentHome?: string): Promise<SyncedModel[]> {
	const data = await requestJson(config, "/v1/models", {}, 10_000, agentHome);
	const rawModels: any[] = Array.isArray(data?.data) ? data.data : [];
	const results: SyncedModel[] = [];

	for (const m of rawModels) {
		const id = typeof m === "string" ? m : m?.id;
		if (!id || !isPiChatModel(m)) continue;

		const synced: SyncedModel = { id, name: m.name ?? id, owned_by: m.owned_by };

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
		api: PROVIDER_API,
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
		api: PROVIDER_API,
		reasoning: id === "auto/coding" || id === "auto/smart",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

async function discoverModels(config: OmniConfig, agentHome?: string): Promise<ProviderModelConfig[]> {
	const synced = await fetchSyncedModels(config, agentHome);
	const syncedIds = new Set(synced.map((m) => m.id));
	const autoModels = AUTO_MODELS.filter((id) => !syncedIds.has(id)).map(buildAutoModel);
	return [...autoModels, ...synced.map(buildProviderModelConfig)];
}

function buildProviderEntry(config: OmniConfig, models: ProviderModelConfig[]): any {
	return {
		baseUrl: `${config.serverUrl}/v1`,
		apiKey: config.apiKey || "omniroute-public",
		api: PROVIDER_API,
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

async function registerOmniProvider(pi: OmniPI, agentHome: string, config: OmniConfig): Promise<ProviderModelConfig[]> {
	const models = await discoverModels(config, agentHome);
	pi.registerProvider(config.providerName, buildProviderEntry(config, models));
	persistModelsJson(agentHome, config, models);
	return models;
}

function reloadProviderFromModelsJson(pi: OmniPI, agentHome: string, config: OmniConfig): void {
	try {
		const provider = readModelsJson(agentHome)?.providers?.[config.providerName];
		if (!provider) return;
		pi.registerProvider(config.providerName, {
			...provider,
			api: PROVIDER_API,
			models: Array.isArray(provider.models)
				? provider.models.map((model: any) => ({
						...model,
						api: PROVIDER_API,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...model.cost },
					}))
				: provider.models,
		});
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
	const ok = await checkHealth(agentHome, config, "status");
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
		"/omni log [lines]      Show connection log (default 25)",
		"/omni test <model>     Smoke-test /v1/chat/completions",
		"/omni dashboard        Show OmniRoute dashboard URL",
		"/omni config           Show config paths and current settings",
		"/omni help             Show this help",
	].join("\n");
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function runSetup(ctx: any, pi: OmniPI, agentHome: string): Promise<OmniConfig | undefined> {
	const current = loadConfig(agentHome);
	const serverUrl = await ctx.ui.input("OmniRoute server URL", current.serverUrl);
	if (serverUrl === undefined) return undefined;
	const apiKey = await ctx.ui.input(
		"OmniRoute API key",
		current.apiKey ? "(press enter to keep current)" : "(optional — press enter to skip)",
	);
	if (apiKey === undefined) return undefined;

	const next = sanitizeConfig({ ...current, serverUrl, apiKey: apiKey || current.apiKey });

	if (!(await checkHealth(agentHome, next, "setup"))) {
		ctx.ui.notify(`Cannot reach ${next.serverUrl}/v1/models.`, "error");
		return undefined;
	}

	saveConfig(agentHome, next);
	const models = await registerOmniProvider(pi, agentHome, next);
	;(ctx as any).modelRegistry?.refresh?.();
	ctx.ui.notify(`Saved. Synced ${models.length} model(s).`, "info");
	return next;
}

async function testChat(config: OmniConfig, model: string, agentHome?: string): Promise<string> {
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
		agentHome,
	);
	const content = data?.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : JSON.stringify(data).slice(0, 200);
}

// ─── Factory ──────────────────────────────────────────────────────────────────
export async function createOmniExtension(pi: OmniPI, opts: AgentHomeOptions): Promise<void> {
	const agentHome = resolveAgentHome(opts);
	let config = loadConfig(agentHome);
	let healthTimer: ReturnType<typeof setInterval> | undefined;

	async function sync(ctx?: any): Promise<number> {
		config = loadConfig(agentHome);
		const models = await registerOmniProvider(pi, agentHome, config);
		;(ctx as any)?.modelRegistry?.refresh?.();
		ctx?.ui.notify(`OmniRoute synced ${models.length} model(s).`, "info");
		return models.length;
	}

	// On load: re-register from existing models.json (no network call)
	reloadProviderFromModelsJson(pi, agentHome, config);
	registerGatewayTelemetry(pi);

	pi.on("session_start", async (_event: any, ctx: any) => {
		config = loadConfig(agentHome);
		if (!existsSync(configPath(agentHome)) && !process.env.OMNIROUTE_URL) {
			ctx.ui.setStatus("omni", "OmniRoute unconfigured");
			ctx.ui.notify("OmniRoute loaded. Run /omni setup to connect.", "warning");
			return;
		}
		const ok = await checkHealth(agentHome, config, "session_start");
		ctx.ui.setStatus("omni", ok ? undefined : "OmniRoute unreachable");
		if (!ok) ctx.ui.notify(`OmniRoute unreachable at ${config.serverUrl}. Run /omni sync after reconnecting.`, "warning");
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = setInterval(async () => {
			ctx.ui.setStatus("omni", (await checkHealth(agentHome, loadConfig(agentHome), "interval")) ? undefined : "OmniRoute unreachable");
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
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const ok = await checkHealth(agentHome, cfg, "tool");
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
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const models = await registerOmniProvider(pi, agentHome, cfg);
			return {
				content: [{ type: "text" as const, text: `OmniRoute synced ${models.length} model(s).` }],
				details: { count: models.length, provider: cfg.providerName },
			};
		},
	});

	pi.registerCommand("omni", {
		description: "OmniRoute: /omni [setup|sync|models|test|dashboard|config|log|help]",
		getArgumentCompletions(prefix: string) {
			return ["setup", "sync", "models", "test", "dashboard", "config", "log", "help"]
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
					const next = await runSetup(ctx, pi, agentHome);
					if (next) config = next;
					return;
				}

				if (sub === "sync") {
					await sync(ctx);
					return;
				}

				if (sub === "models") {
					const models = await discoverModels(config, agentHome).catch(() => []);
					return ctx.ui.notify(
						[`OmniRoute models (${models.length})`, "", ...modelLines(models, rest.join(" "))].join("\n"),
						"info",
					);
				}

				if (sub === "log") {
					const n = Math.min(200, Math.max(1, parseInt(rest[0] ?? "25", 10) || 25));
					const path = connectionLogPath(agentHome);
					let lines: string[] = [];
					try {
						lines = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-n);
					} catch {}
					if (!lines.length) return ctx.ui.notify(`No connection log entries at ${path} yet.`, "info");
					return ctx.ui.notify(
						[`OmniRoute connection log (${lines.length} shown, latest first):`, "", ...lines.reverse()].join("\n"),
						"info",
					);
				}

				if (sub === "test") {
					const model = rest.join(" ");
					if (!model) return ctx.ui.notify("Usage: /omni test <model>", "warning");
					const result = await testChat(config, model, agentHome);
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
							`Log:      ${connectionLogPath(agentHome)}`,
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
