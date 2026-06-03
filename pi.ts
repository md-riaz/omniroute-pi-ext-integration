import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOmniExtension } from "./shared.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  await createOmniExtension(pi, {
    homeEnvVar: "PI_HOME",
    defaultHome: "~/.pi/agent",
  });
}
