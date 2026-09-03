/** Parse gateway-resolved OmniRoute telemetry. Never invent tok/s from latency. */

export const OMNIROUTE_TELEMETRY_HEADERS = {
  tokensPerSecond: "x-omniroute-tokens-per-second",
  model: "x-omniroute-model",
  provider: "x-omniroute-provider",
  responseCost: "x-omniroute-response-cost",
  tokensIn: "x-omniroute-tokens-in",
  tokensOut: "x-omniroute-tokens-out",
  cache: "x-omniroute-cache",
  fallbackAttempts: "x-omniroute-fallback-attempts",
} as const;

const INFERENCE_PATH = /\/v1\/(chat\/completions|responses|messages)(?:\?|$)/i;

export type GatewayTelemetry = {
  tokensPerSecond?: number;
  model?: string;
  provider?: string;
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  cache?: string;
  fallbackAttempts?: number;
};

function positiveNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function tokensPerSecondFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  return positiveNumber(record.tokens_per_second ?? record.tokensPerSecond);
}

export function parseGatewayTelemetry(headers: Headers, body: unknown): GatewayTelemetry {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const usage = record.usage;
  const usageRecord = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const telemetry: GatewayTelemetry = {};
  const toks = positiveNumber(header(headers, OMNIROUTE_TELEMETRY_HEADERS.tokensPerSecond)) ?? tokensPerSecondFromUsage(usage);
  if (toks !== undefined) telemetry.tokensPerSecond = toks;
  const model = header(headers, OMNIROUTE_TELEMETRY_HEADERS.model) ?? (typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined);
  if (model) telemetry.model = model;
  const provider = header(headers, OMNIROUTE_TELEMETRY_HEADERS.provider);
  if (provider) telemetry.provider = provider;
  const costObj = usageRecord.cost;
  const costTotal = costObj && typeof costObj === "object" ? positiveNumber((costObj as Record<string, unknown>).total) : undefined;
  const cost = positiveNumber(header(headers, OMNIROUTE_TELEMETRY_HEADERS.responseCost)) ?? positiveNumber(usageRecord.cost) ?? costTotal;
  if (cost !== undefined) telemetry.cost = cost;
  const tokensIn = positiveNumber(header(headers, OMNIROUTE_TELEMETRY_HEADERS.tokensIn)) ?? positiveNumber(usageRecord.prompt_tokens ?? usageRecord.input_tokens);
  if (tokensIn !== undefined) telemetry.tokensIn = tokensIn;
  const tokensOut = positiveNumber(header(headers, OMNIROUTE_TELEMETRY_HEADERS.tokensOut)) ?? positiveNumber(usageRecord.completion_tokens ?? usageRecord.output_tokens);
  if (tokensOut !== undefined) telemetry.tokensOut = tokensOut;
  const cache = header(headers, OMNIROUTE_TELEMETRY_HEADERS.cache);
  if (cache) telemetry.cache = cache;
  const fallbackAttempts = positiveNumber(header(headers, OMNIROUTE_TELEMETRY_HEADERS.fallbackAttempts));
  if (fallbackAttempts !== undefined) telemetry.fallbackAttempts = fallbackAttempts;
  return telemetry;
}

export function formatTelemetryStatus(t: GatewayTelemetry | undefined): string {
  if (!t || Object.keys(t).length === 0) return "tok/s unavailable";
  const parts = [t.tokensPerSecond !== undefined ? "tok/s " + t.tokensPerSecond.toFixed(1) : "tok/s unavailable"];
  if (t.cost !== undefined) parts.push("cost " + String(t.cost));
  if (t.model) parts.push(t.model);
  if (t.provider) parts.push(t.provider);
  return parts.join(" | ");
}

export function wrapFetchCaptureTelemetry(fetchImpl: typeof fetch, onCapture: (t: GatewayTelemetry) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (INFERENCE_PATH.test(url)) onCapture(parseGatewayTelemetry(response.headers, undefined));
    return response;
  };
}

type PiLike = { on(event: string, handler: (event: any, ctx: any) => any): void };

export function registerGatewayTelemetry(pi: PiLike): void {
  let captured: GatewayTelemetry | undefined;
  let restoreFetch: (() => void) | undefined;
  const install = () => {
    if (restoreFetch) return;
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = wrapFetchCaptureTelemetry(originalFetch, (t) => { captured = t; });
    restoreFetch = () => { globalThis.fetch = originalFetch; };
  };
  pi.on("session_start", (() => { captured = undefined; install(); }));
  pi.on("session_shutdown", (() => { restoreFetch?.(); restoreFetch = undefined; captured = undefined; }));
  pi.on("agent_settled", ((event: unknown, ctx: unknown) => {
    const payload = event as { messages?: Array<{ usage?: unknown }> };
    const ui = ctx as { hasUI?: boolean; ui?: { notify?: (m: string, t?: string) => void; setStatus?: (k: string, v?: string) => void } };
    const fromUsage = (payload.messages ?? []).map((m) => tokensPerSecondFromUsage(m.usage)).find((v) => v !== undefined);
    if (captured && fromUsage !== undefined && captured.tokensPerSecond === undefined) captured = { ...captured, tokensPerSecond: fromUsage };
    const line = formatTelemetryStatus(captured);
    if (ui.hasUI) ui.ui?.notify?.(line, "info");
    ui.ui?.setStatus?.("omni-telemetry", captured && Object.keys(captured).length ? line : undefined);
    captured = undefined;
  }));
}
