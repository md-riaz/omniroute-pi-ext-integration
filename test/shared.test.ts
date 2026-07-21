import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOmniExtension, sanitizeAutoSyncIntervalMs, sanitizeConfig } from "../shared.ts";

test("normalizes legacy Pi catalog API identifiers when reloading models.json", async () => {
  const agentHome = mkdtempSync(join(tmpdir(), "omniroute-agent-extension-test-"));
  const envName = "OMNIROUTE_TEST_HOME";
  const previousHome = process.env[envName];
  process.env[envName] = agentHome;

  writeFileSync(
    join(agentHome, "models.json"),
    JSON.stringify({
      providers: {
        omni: {
          baseUrl: "http://127.0.0.1:20128/v1",
          apiKey: "test-key",
          api: "omni-prompt-tools",
          models: [
            { id: "gpt-test", name: "GPT Test", api: "omni-prompt-tools" },
            {
              id: "gpt-partial-cost",
              name: "GPT Partial Cost",
              api: "omni-prompt-tools",
              cost: { input: 1.25 },
            },
          ],
        },
      },
    }),
  );

  const registrations: Array<{ name: string; config: any }> = [];
  const pi = {
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
    registerTool() {},
    registerCommand() {},
    on() {},
  };

  try {
    await createOmniExtension(pi, { homeEnvVar: envName, defaultHome: "~/.unused" });

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].name, "omni");
    assert.equal(registrations[0].config.api, "openai-completions");
    assert.equal(registrations[0].config.models[0].api, "openai-completions");
    assert.deepEqual(registrations[0].config.models[0].cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual(registrations[0].config.models[1].cost, {
      input: 1.25,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  } finally {
    if (previousHome === undefined) delete process.env[envName];
    else process.env[envName] = previousHome;
    rmSync(agentHome, { recursive: true, force: true });
  }
});

test("sanitizeAutoSyncIntervalMs defaults and clamps", () => {
  assert.equal(sanitizeAutoSyncIntervalMs(undefined), 300_000);
  assert.equal(sanitizeAutoSyncIntervalMs(0), 0);
  assert.equal(sanitizeAutoSyncIntervalMs(30_000), 60_000); // min 60s
  assert.equal(sanitizeAutoSyncIntervalMs(120_000), 120_000);
  assert.equal(sanitizeAutoSyncIntervalMs("nope"), 300_000);
});

test("sanitizeConfig accepts autoSyncIntervalMs and env override", () => {
  const previous = process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MS;
  try {
    delete process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MS;
    const cfg = sanitizeConfig({
      serverUrl: "https://omniroute.example",
      apiKey: "k",
      providerName: "omni",
      autoSyncIntervalMs: 0,
    });
    assert.equal(cfg.autoSyncIntervalMs, 0);

    process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MS = "180000";
    const cfgEnv = sanitizeConfig({
      serverUrl: "https://omniroute.example",
      apiKey: "k",
      providerName: "omni",
    });
    assert.equal(cfgEnv.autoSyncIntervalMs, 180_000);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MS;
    else process.env.OMNIROUTE_AUTO_SYNC_INTERVAL_MS = previous;
  }
});

test("registers /omni autosync command", async () => {
  const agentHome = mkdtempSync(join(tmpdir(), "omniroute-agent-extension-autosync-"));
  const envName = "OMNIROUTE_TEST_HOME_AUTOSYNC";
  const previousHome = process.env[envName];
  process.env[envName] = agentHome;
  const commands: string[] = [];
  const pi = {
    registerProvider() {},
    registerTool() {},
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
  };
  try {
    await createOmniExtension(pi, { homeEnvVar: envName, defaultHome: agentHome });
    assert.ok(commands.includes("omni"));
  } finally {
    if (previousHome === undefined) delete process.env[envName];
    else process.env[envName] = previousHome;
    rmSync(agentHome, { recursive: true, force: true });
  }
});
