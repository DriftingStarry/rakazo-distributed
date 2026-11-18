import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { computerResourceLimits } from "./computer-spec.js";
import {
  computerEgressSetting,
  computerHomeMode,
  docker,
  ensureComputerImage,
  screenNetworkMode,
  supervisorToken,
} from "./context.js";
import { computerEgressMode, ensureRestrictedEgressEnforced } from "./egress.js";
import { reclaimIdleComputerNetworks } from "./networks.js";
import { supervisorApp } from "./routes.js";
import { createScreenRelay } from "./screen-relay.js";

export { supervisorApp };

/**
 * The supervisor's own API on a Node listener. The configured hostname builds the URL of a request
 * that arrives without a Host header, which is what the former `serve({ hostname })` did for this
 * app; without it Node's adapter refuses such a request as missing its host.
 */
export function supervisorApiListener(hostname: string) {
  return getRequestListener(supervisorApp.fetch, { hostname });
}

async function startSupervisor() {
  const logger = await createRootLogger(SERVICE_NAMES.supervisor);
  // Resolve the ceilings before binding the port. They are otherwise parsed inside
  // containerCreateOptions, so a malformed RAKAZO_COMPUTER_* value would let the supervisor start
  // and pass its healthcheck, then fail the first POST /computers with a 500 that reads like a
  // Docker problem. Failing here names the variable while the deployment is still coming up.
  computerResourceLimits();
  if (computerEgressSetting === "auto" && screenNetworkMode !== "internal") {
    // Settle the mode before the first provision rather than on it.
    void ensureComputerImage()
      .then(ensureRestrictedEgressEnforced)
      .catch((error) => logger.error("computer egress probe failed", error));
  } else if (computerEgressMode === "restricted" && screenNetworkMode !== "internal") {
    // Report a missing host ruleset at startup too, not only on the first provision.
    void ensureComputerImage()
      .then(ensureRestrictedEgressEnforced)
      .then(() => logger.info("restricted computer egress verified"))
      .catch((error) => logger.error("restricted computer egress unavailable", error));
  }
  void reclaimIdleComputerNetworks().catch((error) => {
    logger.error("computer network reclaim failed", error);
  });
  const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
  const hostname = process.env.SUPERVISOR_HOST ?? "127.0.0.1";
  // A computer whose home stays in its container may be reached over the network, so its screens
  // come back through this listener: the one address the deployment already calls.
  const relay =
    computerHomeMode === "remote"
      ? createScreenRelay({ secret: supervisorToken, homeMode: computerHomeMode, docker })
      : undefined;
  const api = supervisorApiListener(hostname);
  const server = createServer((request, response) => {
    if (relay?.handles(request)) void relay.request(request, response);
    else void api(request, response);
  });
  relay?.attach(server);
  server.listen(port, hostname, () => {
    logger.info("supervisor listening", { "http.host": hostname, "http.port": port });
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await closeListeningServer(server);
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

function closeListeningServer(server: {
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // A rejected startup keeps Node's default: the error is printed and the process exits.
  void startSupervisor();
}
