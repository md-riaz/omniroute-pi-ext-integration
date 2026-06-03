import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createOmniExtension } from "./shared.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  await createOmniExtension(pi, {
    homeEnvVar: "OMP_HOME",
    defaultHome: "~/.omp/agent",
  });
}
