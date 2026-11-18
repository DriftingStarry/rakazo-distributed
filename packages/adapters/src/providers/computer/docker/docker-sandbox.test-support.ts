import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { simpleCommand } from "../../../computers/screens/linux-desktop.test-support.js";

/**
 * An in-memory computer supervisor on a local port: computers that run until deleted, and a shell
 * that understands `env`, `echo` and `printenv`. A remote one keeps each home in the computer and
 * refuses a provision request that names a server home path, as a remote supervisor does.
 */
export async function emulatedDockerSupervisor(options: { homeMode?: "local" | "remote" } = {}) {
  const homeMode = options.homeMode ?? "local";
  const computers = new Set<string>();
  const provisions: Array<{ homePath?: string }> = [];
  let sequence = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const [, collection, id, action] = (request.url ?? "").split("?")[0]!.split("/");
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (collection !== "computers") return send(404, { error: "not found" });
      if (request.method === "POST" && !id) {
        const provision = JSON.parse(body) as { homePath?: string };
        provisions.push(provision);
        if (homeMode === "remote" && provision.homePath !== undefined) {
          return send(500, { error: "a remote supervisor keeps computer homes in the container" });
        }
        if (homeMode === "local" && !provision.homePath) {
          return send(500, { error: "a local supervisor requires the computer home path" });
        }
        const created = `computer-${++sequence}`;
        computers.add(created);
        return send(200, { id: created });
      }
      if (!id || !computers.has(id)) return send(404, { error: "computer not found" });
      if (request.method === "DELETE" && !action) {
        computers.delete(id);
        return send(200, {});
      }
      if (request.method === "POST" && action === "exec") {
        const { argv, env } = JSON.parse(body) as { argv: string[]; env?: Record<string, string> };
        const { exitCode = 0, stdout = "" } = simpleCommand(argv, env ?? {});
        return send(200, { stdout, stderr: "", code: exitCode });
      }
      return send(200, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    computers,
    provisions,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
