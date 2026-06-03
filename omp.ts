// Runtime CLI: @oh-my-pi/pi-coding-agent — same ExtensionAPI surface as @earendil-works/pi-coding-agent
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOmniExtension } from "./shared.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  await createOmniExtension(pi, {
    homeEnvVar: "OMP_HOME",
    defaultHome: "~/.omp/agent",
  });
}
