import { syncOmniModelsForAgentHome } from "../shared.ts";

const homeEnvVar = process.argv[2] || "PI_HOME";
const defaultHome = process.argv[3] || "~/.pi/agent";

const registrations: any[] = [];
const pi = {
  registerProvider(name: string, config: any) {
    registrations.push({ name, config });
  },
  registerTool() {},
  registerCommand() {},
  on() {},
};

const count = await syncOmniModelsForAgentHome(pi as any, {
  homeEnvVar,
  defaultHome,
});
console.log(
  JSON.stringify({
    ok: true,
    count,
    provider: registrations[0]?.name || null,
  }),
);
