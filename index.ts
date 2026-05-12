/**
 * OmniRoute Manager — Pi Coding Agent Extension
 *
 * Manages OmniRoute (https://github.com/diegosouzapw/OmniRoute) from within
 * pi (https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
 *
 * Features:
 *   - Status bar shows which model actually served each response (via call logs)
 *   - Warns on startup if any provider connections need re-authentication
 *   - /omni commands for managing combos, providers, and model sync
 *
 * Commands:
 *   /omni                  — Status dashboard: health, combos, provider issues
 *   /omni combos           — Manage combos: edit models, create, delete
 *   /omni providers        — Browse providers, models & add new ones
 *   /omni health           — Call log analysis + config diagnostics & auto-fix
 *   /omni sync             — Sync all OmniRoute models to pi's Ctrl+P picker
 *   /omni setup            — Setup OmniRoute URL and API key
 *   /omni dashboard        — Show OmniRoute web dashboard URL
 *
 * Installation:
 *   1. Copy this file to ~/.pi/agent/extensions/omniroute-manager.ts
 *   2. Ensure OmniRoute is running
 *   3. Run /omni setup to configure URL and API key
 *   4. Start pi — the extension auto-loads and shows OmniRoute status.
 *
 * License: MIT
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";

function getOmniUrl(): string {
	try {
		const fs = require("fs");
		const data = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		const url = data?.providers?.omni?.baseUrl;
		if (url) return url.replace(/\/$/, "");
	} catch {}
	return "http://127.0.0.1:20128";
}

let OMNI_URL = getOmniUrl();
let DASHBOARD_URL = OMNI_URL;

function isOmniConfigured(): boolean {
	try {
		const fs = require("fs");
		const data = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		return !!data?.providers?.omni;
	} catch {
		return false;
	}
}

















// ────────────────────────── helpers ──────────────────────────

function modelsJsonPath(): string {
	return process.env.PI_HOME
		? `${process.env.PI_HOME}/models.json`
		: `${homedir()}/.pi/agent/models.json`;
}

function getApiKey(): string {
	try {
		const fs = require("fs");
		const data = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		return data?.providers?.omni?.apiKey || "";
	} catch {
		return "";
	}
}

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
	if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
	const text = await res.text();
	if (!text) return {};
	return JSON.parse(text);
}

// ────────────────────────── health ──────────────────────────

async function checkOmniRouteHealth(): Promise<boolean> {
	try {
		const res = await fetch(`${OMNI_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

// ────────────────────────── combos ──────────────────────────

interface Combo {
	id: string;
	name: string;
	models: (string | { model: string; weight: number })[];
	strategy: string;
	isActive?: boolean;
}

async function listCombos(): Promise<Combo[]> {
	try {
		const data = await api("/api/combos");
		return data?.combos || data || [];
	} catch {
		return [];
	}
}

function comboLine(c: Combo, idx: number): string {
	const on = c.isActive !== false;
	const flag = on ? "✅" : "⬜";
	const count = c.models.length;
	return `${flag} ${idx + 1}. ${c.name}  [${c.strategy}, ${count} model${count !== 1 ? "s" : ""}]`;
}

// ────────────────────────── providers & connections ──────────────────────────

interface Connection {
	id: string;
	provider: string;
	authType: string;
	name: string;
	isActive: boolean;
	testStatus?: string;
	lastError?: string;
	errorCode?: string;
	projectId?: string;
	tokenExpiresAt?: string;
	expiresAt?: string;
	providerSpecificData?: { prefix?: string; nodeName?: string; baseUrl?: string };
}

interface ProviderNode {
	id: string;
	type: string;
	name: string;
	prefix: string;
	baseUrl: string;
}

interface ProviderGroup {
	displayName: string;
	prefix: string;
	connections: Connection[];
	nodeId?: string;
}

async function listConnections(): Promise<Connection[]> {
	try {
		const data = await api("/api/providers");
		return data?.connections || [];
	} catch {
		return [];
	}
}

async function listProviderNodes(): Promise<ProviderNode[]> {
	try {
		const data = await api("/api/provider-nodes");
		return data?.nodes || [];
	} catch {
		return [];
	}
}

async function getProviderModels(connectionId: string): Promise<string[]> {
	try {
		const data = await api(`/api/providers/${connectionId}/models`);
		const models = data?.models || [];
		return models.map((m: any) => (typeof m === "string" ? m : m.id || m.name || String(m)));
	} catch {
		return [];
	}
}

function getDisconnectedProviders(connections: Connection[]): Connection[] {
	return connections.filter(
		(c) =>
			c.isActive &&
			(c.testStatus === "error" ||
				c.testStatus === "expired" ||
				c.errorCode === "refresh_failed" ||
				(c.lastError && c.lastError.includes("refresh failed")))
	);
}

function groupProviders(connections: Connection[], nodes: ProviderNode[]): ProviderGroup[] {
	const groups = new Map<string, ProviderGroup>();
	const nodeMap = new Map<string, ProviderNode>();
	for (const n of nodes) nodeMap.set(n.id, n);

	for (const c of connections) {
		const psd = c.providerSpecificData || {};
		let displayName = psd.nodeName || c.provider;
		let prefix = psd.prefix || "";

		if (!psd.nodeName) {
			displayName = c.provider.charAt(0).toUpperCase() + c.provider.slice(1);
		}

		const key = displayName;
		if (!groups.has(key)) {
			groups.set(key, { displayName, prefix, connections: [], nodeId: undefined });
		}
		const g = groups.get(key)!;
		g.connections.push(c);

		if (c.provider.startsWith("openai-compatible-") || c.provider.startsWith("anthropic-compatible-")) {
			const node = nodeMap.get(c.provider);
			if (node) {
				g.prefix = node.prefix;
				g.nodeId = node.id;
			}
		}
	}

	return Array.from(groups.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ────────────────────────── model picker ──────────────────────────

/** Multi-select model picker with grouped browsing by provider. */
async function pickModelsLoop(
	ctx: any,
	allModels: { id: string; name: string }[],
	currentModels: string[]
): Promise<string[] | null> {
	// Filter: only real models (must have provider/model format), skip combos
	// Also deduplicate aliases — prefer short prefixes (cx/ over codex/, kr/ over kiro/)
	const seen = new Map<string, string>(); // modelName → shortest prefixed ID
	for (const m of allModels) {
		if (!m.id.includes("/")) continue;
		const modelName = m.id.split("/").slice(1).join("/");
		const existing = seen.get(modelName);
		if (!existing || m.id.length < existing.length) {
			seen.set(modelName, m.id);
		}
	}
	const dedupedIds = new Set(seen.values());

	// Build a map to normalize any alias to its canonical (shortest) form
	const toCanonical = new Map<string, string>();
	for (const m of allModels) {
		if (!m.id.includes("/")) continue;
		const modelName = m.id.split("/").slice(1).join("/");
		const canonical = seen.get(modelName);
		if (canonical) toCanonical.set(m.id, canonical);
	}

	// Normalize currentModels to canonical form so ✅ marks show correctly
	const selected = new Set<string>(
		currentModels.map((m) => toCanonical.get(m) || m)
	);

	// Group models by provider
	const byProvider = new Map<string, string[]>();
	for (const id of dedupedIds) {
		const provider = id.split("/")[0];
		if (!byProvider.has(provider)) byProvider.set(provider, []);
		byProvider.get(provider)!.push(id);
	}
	const providers = Array.from(byProvider.keys()).sort();

	let picking = true;
	while (picking) {
		const summary = selected.size > 0
			? Array.from(selected).join(", ")
			: "(none)";

		// Top-level: pick a provider to browse, or finish
		const providerOpts = [
			`── Done (${selected.size} models selected) ──`,
			...providers.map((p) => {
				const models = byProvider.get(p)!;
				const count = models.filter((m) => selected.has(m)).length;
				const tag = count > 0 ? ` [${count} selected]` : "";
				return `${p}/ (${models.length} models)${tag}`;
			}),
		];

		const providerPick = await ctx.ui.select(`Models: ${summary}`, providerOpts);
		if (!providerPick || providerPick.startsWith("── Done")) {
			picking = false;
			continue;
		}

		// Extract provider name from "provider/ (N models) [X selected]"
		const providerName = providerPick.split("/")[0];
		const models = byProvider.get(providerName);
		if (!models) continue;

		// Browse models within this provider
		let browsingProvider = true;
		while (browsingProvider) {
			const modelOpts = [
				"← Back to providers",
				...models.map((m) => `${selected.has(m) ? "✅" : "⬜"} ${m}`),
			];

			const selectedCount = models.filter((m) => selected.has(m)).length;
			const modelPick = await ctx.ui.select(
				`${providerName}/ — ${selectedCount}/${models.length} selected`,
				modelOpts
			);

			if (!modelPick || modelPick === "← Back to providers") {
				browsingProvider = false;
			} else {
				const modelId = modelPick.replace(/^[✅⬜] /, "");
				if (selected.has(modelId)) {
					selected.delete(modelId);
				} else {
					selected.add(modelId);
				}
			}
		}
	}
	return selected.size > 0 ? Array.from(selected) : null;
}

// ────────────────────────── doctor diagnostics ──────────────────────────

interface DoctorIssue {
	severity: "error" | "warning" | "info";
	message: string;
	fix?: () => Promise<string>; // returns result message
}

/** Find combos with conn:-prefixed models and build fixes to replace with provider-level IDs */
function findConnPrefixedCombos(combos: Combo[], connections: Connection[]): DoctorIssue[] {
	const issues: DoctorIssue[] = [];
	const connMap = new Map(connections.map((c) => [c.id, c]));

	for (const combo of combos) {
		const models = combo.models.map((m) => (typeof m === "string" ? m : m.model));
		const connModels = models.filter((m) => m.startsWith("conn:"));
		if (connModels.length === 0) continue;

		// Build replacement: resolve conn:UUID/model → provider/model
		const replacements = new Map<string, string>();
		for (const cm of connModels) {
			const match = cm.match(/^conn:([^/]+)\/(.+)$/);
			if (!match) continue;
			const [, connId, modelName] = match;
			const conn = connMap.get(connId);
			const provider = conn?.provider || "unknown";
			replacements.set(cm, `${provider}/${modelName}`);
		}

		const fixedModels = models.map((m) => replacements.get(m) || m);
		// Deduplicate — multiple conn: entries may resolve to the same provider/model
		const uniqueModels = fixedModels.filter((m, i) => fixedModels.indexOf(m) === i);

		issues.push({
			severity: "error",
			message: `Combo "${combo.name}" uses ${connModels.length} connection-pinned model(s) (conn:…). ` +
				`These fail when that specific account's token expires. ` +
				`Fix: replace with provider-level IDs so OmniRoute can pick any healthy account.`,
			fix: async () => {
				await api(`/api/combos/${combo.id}`, {
					method: "PUT",
					body: JSON.stringify({ models: uniqueModels }),
				});
				return `✅ Fixed "${combo.name}": ${connModels.length} conn: refs → ${uniqueModels.join(", ")}`;
			},
		});
	}
	return issues;
}

/** Find antigravity accounts missing projectId and offer to deprioritize */
function findMissingProjectIds(connections: Connection[]): DoctorIssue[] {
	const broken = connections.filter((c) => c.provider === "antigravity" && c.isActive && !c.projectId);
	const healthy = connections.filter((c) => c.provider === "antigravity" && c.isActive && c.projectId);

	return broken.map((c) => ({
		severity: "warning" as const,
		message: `Antigravity account "${c.name}" is missing projectId — Google will reject requests with 400. ` +
			(healthy.length > 0
				? `${healthy.length} other antigravity account(s) are healthy. `
				: `Consider using Gemini AI Studio (API key) instead — it doesn't need a projectId. `) +
			`Reconnect in dashboard: ${DASHBOARD_URL} → Providers → disconnect & reconnect.`,
	}));
}

/** Find combos where all models depend on a single provider that has issues */
function findFragileCombos(combos: Combo[], connections: Connection[]): DoctorIssue[] {
	const issues: DoctorIssue[] = [];

	// Check which providers have healthy accounts
	const healthyProviders = new Set<string>();
	for (const c of connections) {
		if (c.isActive && c.testStatus === "active") {
			// For antigravity, only count if it has projectId
			if (c.provider === "antigravity" && !c.projectId) continue;
			healthyProviders.add(c.provider);
		}
	}

	// Check if gemini (AI Studio) is available as an alternative
	const hasGemini = healthyProviders.has("gemini");

	for (const combo of combos) {
		if (combo.isActive === false) continue;
		const models = combo.models.map((m) => (typeof m === "string" ? m : m.model));
		const providers = models.map((m) => m.split("/")[0]);
		const uniqueProviders = providers.filter((p, i) => providers.indexOf(p) === i);

		// All models use antigravity and it's broken
		const allAntigravity = uniqueProviders.length === 1 && uniqueProviders[0] === "antigravity";
		if (allAntigravity && !healthyProviders.has("antigravity") && hasGemini) {
			issues.push({
				severity: "error",
				message: `Combo "${combo.name}" uses only antigravity models (which have projectId issues). ` +
					`Gemini AI Studio is available and working — swap to gemini/ models?`,
				fix: async () => {
					// Map antigravity model names to gemini equivalents
					const mapped = models.map((m) => {
						const modelName = m.split("/").slice(1).join("/");
						return `gemini/${modelName}`;
					});
					// Verify the gemini models exist
					let available: string[] = [];
					try {
						const data = await api("/v1/models");
						available = (data?.data || []).map((m: any) => m.id).filter(Boolean);
					} catch {}
					const valid = mapped.filter((m) => available.includes(m));
					if (valid.length === 0) {
						// Fall back to popular gemini models
						valid.push("gemini/gemini-2.5-pro");
						if (combo.strategy === "round-robin") valid.push("gemini/gemini-2.5-flash");
					}
					await api(`/api/combos/${combo.id}`, {
						method: "PUT",
						body: JSON.stringify({ models: valid }),
					});
					return `✅ Fixed "${combo.name}": switched to ${valid.join(", ")}`;
				},
			});
		}

		// Combo has models from providers with zero healthy accounts
		const deadProviders = uniqueProviders.filter((p) => !healthyProviders.has(p));
		if (deadProviders.length > 0 && !allAntigravity) {
			const aliveModels = models.filter((m) => !deadProviders.includes(m.split("/")[0]));
			if (aliveModels.length === 0) {
				issues.push({
					severity: "warning",
					message: `Combo "${combo.name}" has no models from healthy providers ` +
						`(broken: ${deadProviders.join(", ")}). All requests will fail.`,
				});
			} else if (deadProviders.length > 0) {
				issues.push({
					severity: "info",
					message: `Combo "${combo.name}" includes models from unhealthy providers ` +
						`(${deadProviders.join(", ")}). These will be skipped at runtime.`,
				});
			}
		}
	}
	return issues;
}

/** Check if the pi models.json API key is configured (info-level only — OmniRoute
 *  doesn't enforce keys on the Anthropic /v1/messages endpoint that pi uses). */
function checkApiKey(): DoctorIssue[] {
	const key = getApiKey();
	if (!key) {
		return [{
			severity: "info",
			message: `No API key in models.json. This is fine for the /v1/messages endpoint pi uses.`,
		}];
	}
	return [];
}

/** Find combos with no models */
function findEmptyCombos(combos: Combo[]): DoctorIssue[] {
	return combos
		.filter((c) => c.models.length === 0)
		.map((c) => ({
			severity: "error" as const,
			message: `Combo "${c.name}" has no models. It will fail if selected. ` +
				`Add models in the dashboard: ${DASHBOARD_URL}`,
		}));
}

/** Check for accounts with expired or soon-to-expire tokens */
function findExpiringAccounts(connections: Connection[]): DoctorIssue[] {
	const issues: DoctorIssue[] = [];
	const now = Date.now();
	for (const c of connections) {
		if (!c.isActive) continue;
		
		const expiry = c.expiresAt || c.tokenExpiresAt;
		if (expiry) {
			const exp = new Date(expiry).getTime();
			if (exp < now) {
				issues.push({
					severity: "warning",
					message: `Account "${c.name}" (${c.provider}) session expired. Reconnect in dashboard.`,
				});
			} else if (exp < now + 1000 * 60 * 60 * 24) { // expires within 24h
				issues.push({
					severity: "info",
					message: `Account "${c.name}" (${c.provider}) session expires soon (within 24h).`,
				});
			}
		}
	}
	return issues;
}

// ────────────────────────── call log (resolved model tracking) ──────────────────────────

interface CallLog {
	id: string;
	model: string;
	provider: string;
	account: string;
	comboName?: string;
	status: number;
}

async function getLastCallLog(): Promise<CallLog | null> {
	try {
		const logs: CallLog[] = await api("/api/usage/call-logs?limit=1");
		return logs?.[0] || null;
	} catch {
		return null;
	}
}

// ────────────────────────── model sync ──────────────────────────

async function getAllModelsFromOmniRoute(): Promise<{ id: string; name: string }[]> {
	const results: { id: string; name: string }[] = [];

	// Models from built-in providers
	try {
		const data = await api("/v1/models");
		const models = data?.data || [];
		for (const m of models) {
			const id = typeof m === "string" ? m : m.id;
			if (id) results.push({ id, name: humanName(id) });
		}
	} catch {}

	// Models from custom provider nodes (OpenAI-compatible, etc.)
	try {
		const [connections, nodes] = await Promise.all([listConnections(), listProviderNodes()]);
		for (const node of nodes) {
			const nodeConns = connections.filter((c) => c.provider === node.id && c.isActive);
			for (const conn of nodeConns) {
				const models = await getProviderModels(conn.id);
				for (const modelId of models) {
					const prefixedId = `${node.prefix}/${modelId}`;
					if (!results.find((r) => r.id === prefixedId)) {
						results.push({ id: prefixedId, name: humanName(prefixedId) });
					}
				}
			}
		}
	} catch {}

	// Combos as selectable models
	try {
		const combos = await listCombos();
		for (const c of combos) {
			if (!results.find((r) => r.id === c.name)) {
				results.push({ id: c.name, name: c.name });
			}
		}
	} catch {}

	return results.sort((a, b) => a.name.localeCompare(b.name));
}

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

// ════════════════════════════════════════════════════════════
// Extension entry point
// ════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	let healthInterval: ReturnType<typeof setInterval> | undefined;
	let lastSeenLogId = ""; // ID of the most recent call log entry we've already displayed

	// ── Show resolved model in status bar after each response ──

	pi.on("message_end", async (event: any, ctx: any) => {
		try {
			const msg = event.message as any;
			if (msg?.role !== "assistant") return;

			// Wait briefly for OmniRoute to log the call, then check.
			// Two attempts: 500ms and 1500ms. Avoids the old 15×300ms poll loop.
			let log: CallLog | null = null;

			for (const delay of [500, 1000]) {
				await new Promise((r) => setTimeout(r, delay));
				const candidate = await getLastCallLog();
				if (candidate && candidate.id !== lastSeenLogId) {
					log = candidate;
					break;
				}
			}

			if (log) {
				lastSeenLogId = log.id;
				const combo = log.comboName ? `${log.comboName} → ` : "";
				const acct = log.account ? ` · ${log.account}` : "";
				const ok = log.status === 200;
				const suffix = ok ? "" : ` ✗${log.status}`;
				ctx.ui.setStatus("omni", `${combo}${log.model} (${log.provider}${acct})${suffix}`);
			}
		} catch {}
	});

	// ── Show predicted routing when model selection changes ──

	pi.on("model_select", async (event: any, ctx: any) => {
		try {
			const modelId = (event.model as any)?.id ?? "";
			if (!modelId) return;

			// Check if the selected model is a combo
			const combos = await listCombos();
			const combo = combos.find((c) => c.name === modelId);

			if (!combo) {
				// Plain model, just show it
				ctx.ui.setStatus("omni", `→ ${modelId}`);
				return;
			}

			// For combos, show the ordered model list so user knows what to expect
			const models = combo.models.map((m) =>
				typeof m === "string" ? m : m.model
			);
			const preview = models.slice(0, 3).join(" › ");
			const more = models.length > 3 ? ` +${models.length - 3}` : "";
			ctx.ui.setStatus("omni", `${combo.name} [${combo.strategy}]: ${preview}${more}`);
		} catch {}
	});

	// ── Startup: health check + disconnected provider warnings ──

	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!isOmniConfigured()) {
			ctx.ui.setStatus("omni", "OmniRoute (unconfigured)");
			ctx.ui.notify("OmniRoute is unconfigured. Run /omni setup to connect it.", "warning");
			return;
		}

		const healthy = await checkOmniRouteHealth();
		ctx.ui.setStatus("omni", healthy ? "OmniRoute ✓" : "OmniRoute ✗");

		if (healthy) {
			const [combos, conns] = await Promise.all([listCombos(), listConnections()]);
			const active = combos.filter((c) => c.isActive !== false).length;
			const disconnected = getDisconnectedProviders(conns);

			ctx.ui.notify(`OmniRoute ready — ${combos.length} combos (${active} active)`, "info");

			if (disconnected.length > 0) {
				const names = disconnected
					.map((c) => {
						const psd = c.providerSpecificData || {};
						return `  ❌ ${psd.nodeName || c.provider}: ${c.name} — ${c.lastError || c.errorCode || "disconnected"}`;
					})
					.join("\n");
				ctx.ui.notify(
					`⚠️ ${disconnected.length} provider(s) need re-authentication:\n${names}\n\nOpen ${DASHBOARD_URL} → Providers to re-connect.`,
					"warning"
				);
			}

			// Proactive diagnostics on startup
			const issues = [
				...checkApiKey(),

				...findConnPrefixedCombos(combos, conns),
				...findEmptyCombos(combos),
				...findFragileCombos(combos, conns),
				...findMissingProjectIds(conns),
				...findExpiringAccounts(conns),
			];
			const fixable = issues.filter((i) => i.fix);
			const warnings = issues.filter((i) => !i.fix && i.severity !== "info");

			if (fixable.length > 0) {
				ctx.ui.notify(
					`⚠️ ${fixable.length} auto-fixable issue(s) detected. Run /omni doctor to diagnose & fix.`,
					"warning"
				);
			}
			if (warnings.length > 0) {
				for (const w of warnings) {
					ctx.ui.notify(`⚠️ ${w.message}`, "warning");
				}
			}
		} else {
			ctx.ui.notify(
				`OmniRoute not reachable at ${OMNI_URL}\n\nCheck your URL setting or run /omni setup.`,
				"warning"
			);
		}

		// Periodic health check — only update status if OmniRoute goes down
		// (avoids overwriting the resolved model display)
		healthInterval = setInterval(async () => {
			const h = await checkOmniRouteHealth();
			if (!h) ctx.ui.setStatus("omni", "OmniRoute ✗");
		}, 60_000);
	});

	pi.on("session_shutdown", async () => {
		if (healthInterval) clearInterval(healthInterval);
	});

	// ── /omni command ──

	pi.registerCommand("omni", {
		description: "OmniRoute: /omni [combos|providers|health|limits|sync|setup|dashboard]",
		getArgumentCompletions(prefix: string) {
			return ["combos", "providers", "health", "limits", "sync", "setup", "dashboard"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		async handler(args: string, ctx: any) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "";

			// ──────────────── /omni (status dashboard) ────────────────

			if (!sub) {
				const [healthy, combos, conns] = await Promise.all([
					checkOmniRouteHealth(),
					listCombos(),
					listConnections(),
				]);

				const active = combos.filter((c) => c.isActive !== false).length;
				const activeConns = conns.filter((c) => c.isActive).length;
				const disconnected = getDisconnectedProviders(conns);

				const lines = [
					"═══ OmniRoute Status ═══",
					"",
					`  OmniRoute: ${healthy ? "✅ healthy" : "❌ DOWN"} (${OMNI_URL})`,
					"",
					"─── Combos ───",
					"",
					...combos.map((c, i) => "  " + comboLine(c, i)),
					...(combos.length === 0 ? ["  (none — create in dashboard)"] : []),
					"",
					"─── Providers ───",
					"",
					`  ${activeConns}/${conns.length} connections active`,
				];

				if (disconnected.length > 0) {
					lines.push("");
					lines.push("  ⚠️  Needs re-auth:");
					for (const c of disconnected) {
						const psd = c.providerSpecificData || {};
						lines.push(`    ❌ ${psd.nodeName || c.provider}: ${c.name}`);
					}
					lines.push(`    → Open ${DASHBOARD_URL} → Providers`);
				}

				lines.push(
					"",
					"─── Commands ───",
					"",
					"  /omni combos          Manage combos: edit, create, delete",
					"  /omni providers       Browse providers, models & add new ones",
					"  /omni health          Call log analysis + config diagnostics & auto-fix",
					"  /omni sync            Sync models to Ctrl+P picker",
					"  /omni setup-key       Create OmniRoute API key & save to models.json",
					"  /omni dashboard       Dashboard URL",
				);

				ctx.ui.notify(lines.join("\n"), "info");
				ctx.ui.setStatus("omni", healthy ? "OmniRoute ✓" : "OmniRoute ✗");
				return;
			}

			// ──────────────── /omni combos ────────────────

			if (sub === "combos") {
				let browsing = true;
				while (browsing) {
					const combos = await listCombos();
					const liveId = ctx.model?.id ?? "";

					const options = combos.map((c) => {
						const on = c.isActive !== false ? "✅" : "⬜";
						const live = c.name === liveId ? " 🔴" : "";
						const models = c.models.map((m) => typeof m === "string" ? m : m.model);
						const preview = models.slice(0, 3).join(", ");
						const more = models.length > 3 ? ` +${models.length - 3}` : "";
						return `${on} ${c.name} [${c.strategy} · ${c.models.length}]${live}  →  ${preview}${more}`;
					});
					options.push("── New Combo ──");
					options.push("── Done ──");

					const pick = await ctx.ui.select("Combos — select to manage:", options);
					if (!pick || pick === "── Done ──") {
						browsing = false;
						continue;
					}

					if (pick === "── New Combo ──") {
						const name = await ctx.ui.input("Combo name:");
						if (!name) continue;
						const strategy = await ctx.ui.select("Strategy:", ["priority", "round-robin", "random", "least-latency"]);
						if (!strategy) continue;

						// Sync models then pick
						ctx.ui.notify("Syncing models from OmniRoute…", "info");
						const allModels = await getAllModelsFromOmniRoute();
						const selected = await pickModelsLoop(ctx, allModels, []);
						if (!selected || selected.length === 0) continue;

						try {
							await api("/api/combos", {
								method: "POST",
								body: JSON.stringify({ name, strategy, models: selected }),
							});
							ctx.ui.notify(`✅ Created combo "${name}" with ${selected.length} models`, "info");
						} catch (e: any) {
							ctx.ui.notify(`Failed: ${e.message}`, "error");
						}
						continue;
					}

					// Selected an existing combo
					const idx = options.indexOf(pick);
					if (idx < 0 || idx >= combos.length) continue;
					const combo = combos[idx];

					// Show current models + actions for this combo
					let managingCombo = true;
					while (managingCombo) {
						// Refresh combo state
						const refreshed = await listCombos();
						const current = refreshed.find((c) => c.id === combo.id) || combo;
						const currentModels = current.models.map((m) => typeof m === "string" ? m : m.model);

						const opts = [
							...currentModels.map((m) => `  ❌ Remove: ${m}`),
							"  ➕ Add models from providers…",
							"──────────",
							current.isActive !== false ? "⬜ Disable combo" : "✅ Enable combo",
							"🔴 Set as active model",
							`📋 Strategy: ${current.strategy}`,
							"🗑️ Delete combo",
							"← Back",
						];

						const action = await ctx.ui.select(
							`${current.name} [${current.strategy} · ${currentModels.length} models]:`,
							opts
						);
						if (!action || action === "← Back") {
							managingCombo = false;
							continue;
						}

						if (action === "──────────") continue;

						if (action.startsWith("  ❌ Remove:")) {
							const modelToRemove = action.replace("  ❌ Remove: ", "");
							const updated = currentModels.filter((m) => m !== modelToRemove);
							if (updated.length === 0) {
								ctx.ui.notify("Can't remove the last model — delete the combo instead.", "warning");
								continue;
							}
							try {
								await api(`/api/combos/${current.id}`, {
									method: "PUT",
									body: JSON.stringify({ models: updated }),
								});
								ctx.ui.notify(`Removed ${modelToRemove}`, "info");
							} catch (e: any) {
								ctx.ui.notify(`Failed: ${e.message}`, "error");
							}
						} else if (action.includes("Add models")) {
							ctx.ui.notify("Syncing models from OmniRoute…", "info");
							const allModels = await getAllModelsFromOmniRoute();
							const selected = await pickModelsLoop(ctx, allModels, currentModels);
							if (!selected || selected.length === 0) continue;
							try {
								await api(`/api/combos/${current.id}`, {
									method: "PUT",
									body: JSON.stringify({ models: selected }),
								});
								ctx.ui.notify(`✅ Updated "${current.name}" — ${selected.length} models`, "info");
							} catch (e: any) {
								ctx.ui.notify(`Failed: ${e.message}`, "error");
							}
						} else if (action.includes("Disable") || action.includes("Enable")) {
							const newState = current.isActive === false;
							try {
								await api(`/api/combos/${current.id}`, {
									method: "PUT",
									body: JSON.stringify({ isActive: newState }),
								});
								ctx.ui.notify(`${current.name} ${newState ? "enabled" : "disabled"}`, "info");
							} catch (e: any) {
								ctx.ui.notify(`Failed: ${e.message}`, "error");
							}
						} else if (action.includes("Set as active")) {
							const model = ctx.modelRegistry.getAll().find((m: any) => m.id === current.name);
							if (!model) {
								ctx.ui.notify(`"${current.name}" not in model list — run /omni sync first`, "warning");
							} else {
								await pi.setModel(model);
								ctx.ui.setStatus("omni", `🔴 ${current.name}`);
								ctx.ui.notify(`Active model → ${current.name}`, "info");
							}
						} else if (action.includes("Strategy")) {
							const strategy = await ctx.ui.select("Strategy:", ["priority", "round-robin", "random", "least-latency"]);
							if (!strategy) continue;
							try {
								await api(`/api/combos/${current.id}`, {
									method: "PUT",
									body: JSON.stringify({ strategy }),
								});
								ctx.ui.notify(`✅ "${current.name}" strategy → ${strategy}`, "info");
							} catch (e: any) {
								ctx.ui.notify(`Failed: ${e.message}`, "error");
							}
						} else if (action.includes("Delete")) {
							const confirm = await ctx.ui.select(`Delete "${current.name}"? This cannot be undone.`, ["Yes — delete", "No — cancel"]);
							if (confirm?.startsWith("Yes")) {
								try {
									await api(`/api/combos/${current.id}`, { method: "DELETE" });
									ctx.ui.notify(`Deleted "${current.name}"`, "info");
									managingCombo = false;
								} catch (e: any) {
									ctx.ui.notify(`Failed: ${e.message}`, "error");
								}
							}
						}
					}
				}
				return;
			}

			// ──────────────── /omni providers ────────────────

			if (sub === "providers") {
				const [conns, nodes] = await Promise.all([listConnections(), listProviderNodes()]);
				const groups = groupProviders(conns, nodes);

				const providerOptions = groups.map((g) => {
					const activeCount = g.connections.filter((c) => c.isActive).length;
					const totalCount = g.connections.length;
					const prefixStr = g.prefix ? ` (${g.prefix}/)` : "";
					const hasErrors = g.connections.some(
						(c) => c.testStatus === "error" || c.testStatus === "expired"
					);
					const statusEmoji = hasErrors ? "❌" : activeCount === totalCount ? "✅" : activeCount > 0 ? "⚠️" : "⬜";
					return `${statusEmoji} ${g.displayName}${prefixStr}  [${activeCount}/${totalCount} active]`;
				});
				providerOptions.push("── Add OpenAI-compatible provider ──");
				providerOptions.push("── Back ──");

				let browsing = true;
				while (browsing) {
					const choice = await ctx.ui.select("Select a provider to see details:", providerOptions);
					if (!choice || choice === "── Back ──") {
						browsing = false;
						continue;
					}

					if (choice === "── Add OpenAI-compatible provider ──") {
						const name = await ctx.ui.input("Provider name", "e.g. Together, Fireworks");
						if (!name) continue;
						const prefix = await ctx.ui.input("Short prefix (used as prefix/model-name)", "e.g. tog, fw");
						if (!prefix) continue;
						const baseUrl = await ctx.ui.input("Base URL (OpenAI-compatible /v1 endpoint)");
						if (!baseUrl) continue;
						const apiKey = await ctx.ui.input("API key");
						if (!apiKey) continue;
						try {
							const nodeRes = await api("/api/provider-nodes", {
								method: "POST",
								body: JSON.stringify({ name, prefix, apiType: "chat", baseUrl, type: "openai-compatible" }),
							});
							const nodeId = nodeRes?.node?.id;
							if (!nodeId) throw new Error("No node ID returned");
							await api("/api/providers", {
								method: "POST",
								body: JSON.stringify({ provider: nodeId, apiKey, name: `${name} API Key` }),
							});
							ctx.ui.notify(`✅ Added: ${name} (${prefix}/)\nRun /omni sync to add models to Ctrl+P`, "info");
						} catch (e: any) {
							ctx.ui.notify(`Failed: ${e.message}`, "error");
						}
						continue;
					}

					const idx = providerOptions.indexOf(choice);
					if (idx < 0 || idx >= groups.length) continue;

					const group = groups[idx];
					const lines = [
						`═══ ${group.displayName} ═══`,
						"",
						"─── Accounts ───",
					];

					for (const c of group.connections) {
						const status =
							c.testStatus === "active" ? "✅" :
							c.testStatus === "unknown" ? "⚪" :
							c.testStatus === "error" || c.testStatus === "expired" ? "❌" : "⚠️";
						lines.push(`  ${status} ${c.name} [${c.authType}] ${c.isActive ? "active" : "disabled"}`);
						if (c.lastError) {
							lines.push(`     └─ ${c.lastError}`);
							if (c.authType === "oauth" || c.errorCode === "refresh_failed") {
								lines.push(`     └─ Re-authenticate at ${DASHBOARD_URL} → Providers`);
							}
						}
					}

					const activeConn = group.connections.find((c) => c.isActive);
					if (activeConn) {
						lines.push("");
						lines.push("─── Models ───");
						const models = await getProviderModels(activeConn.id);
						if (models.length > 0) {
							const prefix = group.prefix || group.displayName.toLowerCase();
							lines.push(`  ${models.length} models (use as ${prefix}/<name>)`);
							lines.push("");
							const maxShow = 30;
							for (let i = 0; i < Math.min(models.length, maxShow); i++) {
								lines.push(`  • ${prefix}/${models[i]}`);
							}
							if (models.length > maxShow) {
								lines.push(`  ... and ${models.length - maxShow} more`);
							}
						} else {
							lines.push("  (models listed via /v1/models — run /omni sync to add to Ctrl+P)");
						}
					}

					if (group.nodeId) {
						const node = nodes.find((n) => n.id === group.nodeId);
						if (node) {
							lines.push("");
							lines.push("─── Node Config ───");
							lines.push(`  Base URL: ${node.baseUrl}`);
							lines.push(`  Prefix:   ${node.prefix}/`);
							lines.push(`  Type:     ${node.type}`);
						}
					}

					lines.push("");
					lines.push(`Full management: ${DASHBOARD_URL} → Providers`);
					ctx.ui.notify(lines.join("\n"), "info");
				}
				return;
			}

			// ──────────────── /omni sync ────────────────

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
							"Add one first — see the extension header docs for the format.",
							"error"
						);
						return;
					}

					const oldCount = config.providers.omni.models?.length || 0;
					config.providers.omni.models = allModels;
					fs.writeFileSync(path, JSON.stringify(config, null, 2));
	

					// Reload registry immediately — no restart needed
					ctx.modelRegistry.refresh();

					ctx.ui.notify(
						`✅ Synced ${allModels.length} models to Ctrl+P (was ${oldCount})`,
						"info"
					);
				} catch (e: any) {
					ctx.ui.notify(`Sync failed: ${e.message}`, "error");
				}
				return;
			}

			// ──────────────── /omni health (merged log-review + doctor) ────────────────

			if (sub === "health" || sub === "log-review" || sub === "logreview" || sub === "doctor" || sub === "doc") {
				ctx.ui.notify("Running health check…", "info");

				try {
					const [combos, rawLogs] = await Promise.all([
						listCombos(),
						api("/api/usage/call-logs?limit=200"),
					]);

					// Filter to inference calls only
					const logs: any[] = (rawLogs as any[]).filter(
						(l: any) => l.path === "/v1/messages"
					);

					if (!logs.length) {
						ctx.ui.notify("No call log history yet.", "info");
						return;
					}

					// Build per-model stats keyed by "provider/model" as OmniRoute logs them
					interface ModelStats {
						attempts: number;
						successes: number;
						onlyContextErrors: boolean; // all failures are 413 (too large)
						errors: Record<string, number>;
						totalDuration: number;
						errorMessages: string[];
					}
					const stats = new Map<string, ModelStats>();

					for (const log of logs) {
						const key = `${log.provider}/${log.model}`;
						if (!stats.has(key)) {
							stats.set(key, {
								attempts: 0, successes: 0, onlyContextErrors: true,
								errors: {}, totalDuration: 0, errorMessages: [],
							});
						}
						const s = stats.get(key)!;
						s.attempts++;
						s.totalDuration += log.duration ?? 0;
						if (log.status === 200) {
							s.successes++;
							s.onlyContextErrors = false;
						} else {
							const code = String(log.status);
							s.errors[code] = (s.errors[code] ?? 0) + 1;
							const errMsg: string = log.error ?? "";
							// 413 = context too large — model works, session is just too big
							if (log.status !== 413) s.onlyContextErrors = false;
							if (errMsg && !s.errorMessages.find((m) => m === errMsg.slice(0, 80))) {
								s.errorMessages.push(errMsg.slice(0, 80));
							}
						}
					}

					// Known prefix aliases: short combo prefix → full OmniRoute log provider name
					const prefixMap: Record<string, string> = {
						cx: "codex", kr: "kiro", kmc: "kimi-coding", qw: "qwen", ali: "alibaba",
					};

					// Match a combo model ID to call log stats.
					// Tries exact match first, then resolves prefix aliases.
					const findStats = (modelId: string): ModelStats | undefined => {
						// Exact match
						if (stats.has(modelId)) return stats.get(modelId);
						// Resolve alias: cx/gpt-5.4 → codex/gpt-5.4
						const prefix = modelId.split("/")[0];
						const modelName = modelId.split("/").slice(1).join("/");
						const longPrefix = prefixMap[prefix];
						if (longPrefix) {
							const aliased = `${longPrefix}/${modelName}`;
							if (stats.has(aliased)) return stats.get(aliased);
						}
						// Reverse alias: codex/gpt-5.4 → check if logged as cx/gpt-5.4
						for (const [short, long] of Object.entries(prefixMap)) {
							if (prefix === long) {
								const aliased = `${short}/${modelName}`;
								if (stats.has(aliased)) return stats.get(aliased);
							}
						}
						return undefined;
					};

					// Build report per combo
					const lines: string[] = ["═══ OmniRoute Log Review ═══", `(last ${logs.length} inference calls)`, ""];
					const removals: Array<{ comboId: string; comboName: string; modelId: string }> = [];

					for (const combo of combos) {
						lines.push(`─── ${combo.name} [${combo.strategy}] ───`);
						const comboModels = combo.models.map((m) =>
							typeof m === "string" ? m : m.model
						);

						for (const modelId of comboModels) {
							const s = findStats(modelId);

							if (!s) {
								lines.push(`  ❓ ${modelId}  (no history)`);
								continue;
							}

							const rate = Math.round((s.successes / s.attempts) * 100);
							const avgMs = Math.round(s.totalDuration / s.attempts);
							const errSummary = Object.entries(s.errors)
								.map(([code, n]) => `${code}×${n}`)
								.join(", ");

							if (s.successes === 0 && s.onlyContextErrors) {
								// All failures are 413 — model works, context was too large
								lines.push(`  ⚠️  ${modelId}`);
								lines.push(`     context too large for free tier (${s.attempts}× 413) — works in shorter sessions`);
							} else if (s.successes === 0) {
								// Genuinely broken
								lines.push(`  ❌ ${modelId}`);
								lines.push(`     0/${s.attempts} success · ${errSummary}`);
								if (s.errorMessages[0]) lines.push(`     "${s.errorMessages[0]}"`);
								lines.push(`     → suggest remove`);
								removals.push({ comboId: combo.id, comboName: combo.name, modelId });
							} else if (rate < 60) {
								lines.push(`  ⚠️  ${modelId}`);
								lines.push(`     ${s.successes}/${s.attempts} success (${rate}%) · avg ${avgMs}ms · ${errSummary}`);
							} else if (avgMs > 30000) {
								lines.push(`  ⏱  ${modelId}`);
								lines.push(`     ${rate}% success · avg ${Math.round(avgMs / 1000)}s (slow)`);
							} else {
								lines.push(`  ✅ ${modelId}`);
								lines.push(`     ${rate}% success · avg ${avgMs}ms`);
							}
						}

						lines.push("");
					}

					ctx.ui.notify(lines.join("\n"), "info");

					if (removals.length === 0) return;

					// Fetch all available models from OmniRoute once for replacement suggestions
					let availableModels: string[] = [];
					try {
						const data = await api("/v1/models");
						availableModels = (data?.data ?? []).map((m: any) =>
							typeof m === "string" ? m : m.id
						).filter(Boolean);
					} catch {}

					// For each broken model, ask: remove or replace?
					// Track pending edits: comboId → { remove: Set, add: string[] }
					const edits = new Map<string, { id: string; name: string; remove: Set<string>; add: string[] }>();

					for (const r of removals) {
						// Models already in this combo (to avoid suggesting duplicates)
						const currentCombo = combos.find((c) => c.id === r.comboId);
						const alreadyIn = new Set(
							(currentCombo?.models ?? []).map((m) =>
								typeof m === "string" ? m : m.model
							)
						);

						// Suggest models from the same provider prefix
						const brokenPrefix = r.modelId.split("/")[0];
						const suggestions = availableModels.filter(
							(m) => m.startsWith(`${brokenPrefix}/`) && !alreadyIn.has(m) && m !== r.modelId
						).slice(0, 8);

						// Also offer models from other providers as alternatives
						const otherSuggestions = availableModels.filter(
							(m) => !m.startsWith(`${brokenPrefix}/`) && !alreadyIn.has(m)
						).slice(0, 6);

						const options = [
							`❌ Remove (no replacement)`,
							...(suggestions.length ? ["── Same provider ──", ...suggestions.map((m) => `→ ${m}`)] : []),
							...(otherSuggestions.length ? ["── Other providers ──", ...otherSuggestions.map((m) => `→ ${m}`)] : []),
							"⏭ Skip (keep as-is)",
						];

						const choice = await ctx.ui.select(
							`[${r.comboName}] ${r.modelId} — remove or replace?`,
							options
						);

						if (!choice || choice === "⏭ Skip (keep as-is)" || choice.startsWith("──")) continue;

						if (!edits.has(r.comboId)) {
							edits.set(r.comboId, { id: r.comboId, name: r.comboName, remove: new Set(), add: [] });
						}
						const edit = edits.get(r.comboId)!;
						edit.remove.add(r.modelId);

						if (choice.startsWith("→ ")) {
							edit.add.push(choice.slice(2));
						}
						// "Remove" → remove only, no add
					}

					if (edits.size === 0) return;

					// Apply all edits
					const allCombos = await listCombos();
					const results: string[] = [];

					for (const { id, name, remove, add } of edits.values()) {
						const combo = allCombos.find((c) => c.id === id);
						if (!combo) continue;

						const kept = combo.models
							.map((m) => (typeof m === "string" ? m : m.model))
							.filter((m) => !remove.has(m));
						const updated = [...kept, ...add];

						try {
							await api(`/api/combos/${id}`, {
								method: "PUT",
								body: JSON.stringify({ models: updated }),
							});
							const removedList = [...remove].join(", ");
							const addedList = add.length ? ` · added ${add.join(", ")}` : "";
							results.push(`✅ ${name}: removed ${removedList}${addedList}`);
						} catch (e: any) {
							results.push(`❌ ${name}: ${e.message}`);
						}
					}

					ctx.ui.notify(results.join("\n"), "info");
				} catch (e: any) {
					ctx.ui.notify(`Log review failed: ${e.message}`, "error");
				}

				// ── Config diagnostics (formerly /omni doctor) ──
				ctx.ui.notify("Running config diagnostics…", "info");
				try {
					const [dCombos, dConns] = await Promise.all([listCombos(), listConnections()]);
					const issues = [
						...checkApiKey(),
						...findConnPrefixedCombos(dCombos, dConns),
						...findEmptyCombos(dCombos),
						...findFragileCombos(dCombos, dConns),
						...findMissingProjectIds(dConns),
						...findExpiringAccounts(dConns),
					];

					if (issues.length === 0) {
						ctx.ui.notify("✅ Config diagnostics: no issues found.", "info");
					} else {
						const diagLines = ["═══ Config Diagnostics ═══", ""];
						for (let i = 0; i < issues.length; i++) {
							const issue = issues[i];
							const icon = issue.severity === "error" ? "❌" : issue.severity === "warning" ? "⚠️" : "ℹ️";
							const fixTag = issue.fix ? " [auto-fixable]" : "";
							diagLines.push(`${icon} ${i + 1}. ${issue.message}${fixTag}`);
							diagLines.push("");
						}
						ctx.ui.notify(diagLines.join("\n"), "info");

						const fixable = issues.filter((i) => i.fix);
						if (fixable.length > 0) {
							const fixChoice = await ctx.ui.select(
								`${fixable.length} issue(s) can be auto-fixed. Proceed?`,
								["Yes — fix all", "Pick individually", "No — skip"]
							);
							if (fixChoice?.startsWith("Yes")) {
								const fixResults: string[] = [];
								for (const issue of fixable) {
									try { fixResults.push(await issue.fix!()); }
									catch (e: any) { fixResults.push(`❌ Fix failed: ${e.message}`); }
								}
								ctx.ui.notify(fixResults.join("\n"), "info");
							} else if (fixChoice === "Pick individually") {
								for (const issue of fixable) {
									const apply = await ctx.ui.select(issue.message, ["Fix this", "Skip"]);
									if (apply === "Fix this") {
										try { ctx.ui.notify(await issue.fix!(), "info"); }
										catch (e: any) { ctx.ui.notify(`❌ Fix failed: ${e.message}`, "error"); }
									}
								}
							}
						}
					}
				} catch (e: any) {
					ctx.ui.notify(`Diagnostics failed: ${e.message}`, "error");
				}
				return;
			}

			// ──────────────── /omni setup ────────────────

			if (sub === "setup") {
				const fs = require("fs");
				const path = modelsJsonPath();

				// Get OmniRoute URL
				const urlInput = await ctx.ui.input(
					"OmniRoute URL",
					"e.g. http://localhost:20128"
				);
				if (!urlInput) return;
				const baseUrl = urlInput.trim().replace(/\/$/, "");

				// Test connectivity
				try {
					const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
					if (!res.ok) {
						ctx.ui.notify(`OmniRoute unreachable at ${baseUrl} (${res.status})`, "error");
						return;
					}
				} catch (e: any) {
					ctx.ui.notify(`OmniRoute unreachable at ${baseUrl}: ${e.message}`, "error");
					return;
				}

				// Ask for API Key
				const apiKey = await ctx.ui.input(
					"OmniRoute API Key",
					"Enter your API key or press enter to leave blank"
				);
				if (apiKey === undefined) return;

				// Save configuration
				try {
					let config: any = {};
					try {
						config = JSON.parse(fs.readFileSync(path, "utf8"));
					} catch {}

					if (!config.providers) config.providers = {};
					config.providers.omni = {
						baseUrl,
						api: "openai-completions",
						apiKey: apiKey.trim(),
						models: [],
					};

					fs.writeFileSync(path, JSON.stringify(config, null, 2));

					OMNI_URL = baseUrl;
					DASHBOARD_URL = baseUrl;

					ctx.ui.notify(
						`✅ OmniRoute setup complete and saved to models.json\n\nRun /omni sync to pull models into the Ctrl+P picker.`,
						"info"
					);
				} catch (e: any) {
					ctx.ui.notify(`Failed to save to models.json: ${e.message}`, "error");
				}
				return;
			}

			// ──────────────── /omni dashboard ────────────────

			if (sub === "dashboard" || sub === "dash") {
				ctx.ui.notify(
					[
						`OmniRoute Dashboard: ${DASHBOARD_URL}`,
						"",
						"Open in your browser for:",
						"  • Create/edit combos with model reordering",
						"  • Provider OAuth re-authentication",
						"  • Add built-in provider accounts",
						"  • Model analytics & request metrics",
						"  • Request logs & debugging",
					].join("\n"),
					"info"
				);
				return;
			}

			// ──────────────── /omni limits ────────────────

			if (sub === "limits" || sub === "quota" || sub === "usage") {
				try {
					ctx.ui.setStatus("omni", "Fetching quotas…");
					const data = await api("/api/usage/quota");
					const providers = data?.providers || [];
					const lines: string[] = ["═══ OmniRoute Usage Quotas ═══", ""];

					if (providers.length === 0) {
						lines.push("No active provider connections found.");
					}

					for (const p of providers) {
						const pct = typeof p.percentRemaining === "number"
							? Math.round(p.percentRemaining) : 100;
						const filled = Math.round((100 - pct) / 5);
						const bar = "█".repeat(filled) + "░".repeat(20 - filled);
						const reset = p.resetAt
							? ` · resets ${p.resetAt.slice(0, 16).replace("T", " ")}`
							: "";
						const token = p.tokenStatus !== "valid"
							? ` ⚠️ token:${p.tokenStatus}` : "";

						if (pct <= 0) {
							lines.push(`  ❌ ${p.provider}/${p.name}: EXHAUSTED${reset}`);
						} else if (pct <= 20) {
							lines.push(`  ⚠️  ${p.provider}/${p.name}: [${bar}] ${pct}% left${reset}${token}`);
						} else {
							lines.push(`  ${p.provider}/${p.name}: [${bar}] ${pct}% left${reset}${token}`);
						}
					}

					lines.push("");
					ctx.ui.notify(lines.join("\\n"), "info");
					ctx.ui.setStatus("omni", "OmniRoute ✓");
				} catch (e: any) {
					ctx.ui.notify(`Failed to fetch limits: ${e.message}`, "error");
					ctx.ui.setStatus("omni", "OmniRoute ✓");
				}
				return;
			}

			// ──────────────── Unknown ────────────────

			ctx.ui.notify(
				`Unknown: /omni ${sub}\n\nAvailable: combos, providers, health, limits, sync, setup-key, dashboard`,
				"warning"
			);
		},
	});
}
