import assert from "node:assert/strict";
import test from "node:test";
import { formatTelemetryStatus, parseGatewayTelemetry, tokensPerSecondFromUsage, wrapFetchCaptureTelemetry } from "../telemetry.ts";

test("reads tok/s from usage and omits zero or latency-derived values", () => {
  assert.equal(tokensPerSecondFromUsage({ tokens_per_second: 42.5 }), 42.5);
  assert.equal(tokensPerSecondFromUsage({ tokens_per_second: 0 }), undefined);
  assert.equal(tokensPerSecondFromUsage({ output_tokens: 100, latency_ms: 2000 }), undefined);
});

test("parses present headers and leaves absent telemetry empty", () => {
  const present = parseGatewayTelemetry(new Headers({
    "x-omniroute-tokens-per-second": "18.2",
    "x-omniroute-model": "omni/claude-opus",
    "x-omniroute-provider": "anthropic",
    "x-omniroute-response-cost": "0.012",
  }), { model: "alias" });
  assert.equal(present.tokensPerSecond, 18.2);
  assert.equal(present.model, "omni/claude-opus");
  assert.equal(present.provider, "anthropic");
  assert.equal(present.cost, 0.012);
  const absent = parseGatewayTelemetry(new Headers(), {});
  assert.deepEqual(absent, {});
  assert.equal(formatTelemetryStatus(absent), "tok/s unavailable");
});

test("uses body model when routed model header is absent", () => {
  const routed = parseGatewayTelemetry(new Headers(), { model: "omni/gpt-sol", usage: { tokens_per_second: 9 } });
  assert.equal(routed.model, "omni/gpt-sol");
  assert.equal(routed.tokensPerSecond, 9);
});

test("fetch wrapper captures inference URLs only", async () => {
  const seen: string[] = [];
  const inner = (async (_input: RequestInfo | URL) => new Response("{}", { headers: { "x-omniroute-tokens-per-second": "11" } })) as typeof fetch;
  const wrapped = wrapFetchCaptureTelemetry(inner, (t) => { if (t.tokensPerSecond) seen.push(String(t.tokensPerSecond)); });
  await wrapped("https://omniroute.example/v1/models");
  await wrapped("https://omniroute.example/v1/chat/completions");
  assert.deepEqual(seen, ["11"]);
});
