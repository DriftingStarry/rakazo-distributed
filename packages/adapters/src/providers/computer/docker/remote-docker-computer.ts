import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computers/computer-provider-descriptor.js";
import { optional } from "../../../computers/computer-provider-descriptor.js";

/**
 * A computer on a supervisor the deployment does not host, reached only over its origin. The
 * supervisor keeps the home in the computer's own writable layer: it has no server directory to
 * mount, so a replacement restores the workspace from the last saved checkpoint instead.
 */
export const remoteDockerComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: true,
    inPlaceUpdate: true,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: true,
    storedHomeIsBackup: false,
  },
  // Without an origin there is nowhere to run computers; a malformed one cannot be ignored.
  unavailable: (source) => {
    const origin = optional(source.SANDBOX_SUPERVISOR_URL);
    if (!origin) return true;
    remoteDockerSupervisorOrigin(origin);
    return source.NODE_ENV === "production" && !optional(source.SANDBOX_SUPERVISOR_TOKEN);
  },
  async create(opts) {
    const origin = remoteDockerSupervisorOrigin(opts.supervisorUrl);
    const { DockerSandboxProvider } = await import("./docker-sandbox.js");
    return new DockerSandboxProvider(origin, opts.supervisorToken, "remote-docker");
  },
};

/**
 * The origin of the remote supervisor. It must be explicit and an http(s) origin with no
 * credentials, query, fragment or path, so where a call goes is decided by the deployment alone.
 */
export function remoteDockerSupervisorOrigin(configured: string | undefined): string {
  const value = configured?.trim();
  if (!value) throw new Error("SANDBOX_SUPERVISOR_URL must name the remote supervisor's origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The constructor's own error quotes the value it could not read, so it is dropped: a
    // malformed origin may carry a credential, and this message is logged and shown.
    throw new Error("SANDBOX_SUPERVISOR_URL must be an http(s) origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SANDBOX_SUPERVISOR_URL must be an http(s) origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "SANDBOX_SUPERVISOR_URL must be an origin, with no credentials, query, fragment or path",
    );
  }
  return url.origin;
}
