import { createOmniExtension, type OmniPI } from "./shared.ts";

export default async function (pi: OmniPI): Promise<void> {
  await createOmniExtension(pi, {
    homeEnvVar: "PI_HOME",
    defaultHome: "~/.pi/agent",
  });
}
