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
import { homedir } from "os";

function modelsJsonPath(): string {
	return process.env.PI_HOME
		? `${process.env.PI_HOME}/models.json`
		: `${homedir()}/.pi/agent/models.json`;
}

function readModelsJson(): any {
	const fs = require("fs");
	return JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
}

function getOmniUrl(): string {
	try {
		const url = readModelsJson()?.providers?.omni?.baseUrl;
		if (url) return url.replace(/\/$/, "");
	} catch {}
	return "http://127.0.0.1:20128";
}

function getApiKey(): string {
	try {
		return readModelsJson()?.providers?.omni?.apiKey || "";
	} catch {
		return "";
	}
}

function isOmniConfigured(): boolean {
	try {
		return !!readModelsJson()?.providers?.omni;
	} catch {
		return false;
	}
}

let OMNI_URL = getOmniUrl();
let DASHBOARD_URL = OMNI_URL;

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

async function checkOmniRouteHealth(): Promise<boolean> {
	try {
		const res = await fetch(`${OMNI_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
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

function isPiChatModel(model: any): boolean {
	if (!model || typeof model !== "object") return true;
	const output = normalizeModalities(model.output_modalities ?? model.output);
	if (String(model.type || "chat").toLowerCase() === "image") return false;
	return output.length === 0 || output.includes("text");
}

function isWebSyncedModel(id: string, name?: string): boolean {
	return `${id} ${name || ""}`.toLowerCase().includes("-web");
}

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
			api: "openai-completions",
		};

		if (isWebSyncedModel(id, m.name)) synced.tool_calling = false;

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

				const apiKey = await ctx.ui.input(
					"OmniRoute API Key",
					"Enter your API key or press enter to leave blank"
				);
				if (apiKey === undefined) return;

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
