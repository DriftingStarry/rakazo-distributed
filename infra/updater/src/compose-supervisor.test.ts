import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The standalone supervisor keeps another deployment's bot computers on its own Docker host. It
 * holds that host's Docker socket, which is root-equivalent, so its published surface and the
 * hardening the production stack applies are checked here rather than left to review.
 */

interface ComposeService {
  image?: string;
  pull_policy?: string;
  command?: unknown;
  environment?: Record<string, unknown>;
  env_file?: unknown;
  volumes?: string[];
  ports?: unknown[];
  networks?: string[];
  network_mode?: string;
  depends_on?: Record<string, { condition?: string }>;
  security_opt?: string[];
  logging?: { driver?: string; options?: Record<string, string> };
  pids_limit?: number;
  mem_limit?: string;
  user?: string;
  init?: boolean;
  restart?: string;
  healthcheck?: { test?: unknown };
}

interface ComposeFile {
  name?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, { internal?: boolean }> | null;
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const composeDir = path.join(repoRoot, "infra/compose");

/** A Compose value read from the environment, with the file's own fallback. */
function variable(name: string, fallback: string): string {
  return `\${${name}:-${fallback}}`;
}

/** A published image: the repository variable plus its release-tag variable. */
function image(repository: string, repositoryFallback: string, tag: string): string {
  return `${variable(repository, repositoryFallback)}:${variable(tag, "latest")}`;
}

function readCompose(file: string): ComposeFile {
  return parse(readFileSync(path.join(composeDir, file), "utf8"), { merge: true }) as ComposeFile;
}

const supervisorStack = readCompose("docker-compose.supervisor.yml");
const productionBase = readCompose("docker-compose.prod.yml");

describe("the standalone supervisor compose file", () => {
  it("runs the published app and computer images, pulling the computer first", () => {
    expect(Object.keys(supervisorStack.services).sort()).toEqual(["computer", "supervisor"]);
    const supervisor = supervisorStack.services.supervisor;
    const computer = supervisorStack.services.computer;
    expect(supervisor?.image).toBe(
      image("RAKAZO_IMAGE", "ghcr.io/elie222/rakazo/app", "RAKAZO_IMAGE_TAG"),
    );
    expect(String(supervisor?.command)).toContain("sandbox-supervisor");
    expect(computer?.image).toBe(
      image(
        "RAKAZO_COMPUTER_IMAGE",
        "ghcr.io/elie222/rakazo/computer",
        "RAKAZO_COMPUTER_IMAGE_TAG",
      ),
    );
    expect(computer?.pull_policy).toBe("missing");
    expect(computer?.command).toEqual(["true"]);
    expect(computer?.restart).toBe("no");
    expect(supervisor?.depends_on?.computer?.condition).toBe("service_completed_successfully");
  });

  it("serves another deployment: container homes, relayed screens, a required shared token", () => {
    const environment = supervisorStack.services.supervisor?.environment ?? {};
    expect(environment.SANDBOX_SUPERVISOR_REMOTE).toBe("true");
    expect(environment.SANDBOX_SCREEN_NETWORK).toBe("isolated");
    expect(environment.DOCKER_SOCKET).toBe("/var/run/docker.sock");
    expect(environment.SANDBOX_SUPERVISOR_TOKEN).toContain("SANDBOX_SUPERVISOR_TOKEN:?");
    // The listener takes every interface inside its own container; the host bind below decides
    // where it is actually exposed.
    expect(environment.SUPERVISOR_HOST).toBe("0.0.0.0");
  });

  it("publishes exactly one port, on an address the operator must name", () => {
    const services = Object.entries(supervisorStack.services);
    expect(services.filter(([, service]) => service.ports?.length)).toHaveLength(1);
    const ports = supervisorStack.services.supervisor?.ports ?? [];
    expect(ports).toHaveLength(1);
    // No `:-` fallback: a missing bind address fails before anything starts, so the port is never
    // published on every interface by omission.
    expect(ports[0]).toMatch(/^\$\{SANDBOX_SUPERVISOR_BIND:\?[^}]+\}:7091:7091$/u);
    expect(String(ports[0])).not.toContain("0.0.0.0:");
  });

  it("keeps computer egress restricted until the host rules are installed", () => {
    const environment = supervisorStack.services.supervisor?.environment ?? {};
    expect(environment.SANDBOX_COMPUTER_EGRESS).toBe(
      variable("SANDBOX_COMPUTER_EGRESS", "restricted"),
    );
  });

  it("matches the production hardening and keeps Docker access on the supervisor only", () => {
    const supervisor = supervisorStack.services.supervisor;
    const computer = supervisorStack.services.computer;
    expect(supervisor?.user).toBe("root");
    expect(supervisor?.init).toBe(true);
    expect(supervisor?.restart).toBe("unless-stopped");
    expect(supervisor?.security_opt).toEqual(["no-new-privileges:true"]);
    expect(supervisor?.pids_limit).toBe(256);
    expect(supervisor?.mem_limit).toBe("512m");
    expect(supervisor?.logging).toEqual({
      driver: "local",
      options: { "max-size": "10m", "max-file": "3" },
    });
    expect(supervisor?.env_file).toBeUndefined();
    expect(supervisor?.volumes).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
    expect(JSON.stringify(supervisor?.healthcheck?.test)).toContain("7091/health");
    // The one-shot image pull never runs a container on the host network or with the socket.
    expect(computer?.network_mode).toBe("none");
    expect(computer?.volumes).toBeUndefined();
    expect(computer?.ports).toBeUndefined();
  });
});

describe("the production stack with a supervisor on another host", () => {
  it("keeps remote-docker on the base file, with no local supervisor or Docker socket", () => {
    expect(productionBase.services.supervisor).toBeUndefined();
    for (const name of ["api", "worker"]) {
      const environment = productionBase.services[name]?.environment ?? {};
      // The deployment picks the provider and names the remote origin in .env; the base file only
      // passes both through, so the local-Docker overlay is not layered for this topology.
      expect(environment.SANDBOX_PROVIDER).toBe(variable("SANDBOX_PROVIDER", "e2b"));
      expect(environment).toHaveProperty("SANDBOX_SUPERVISOR_URL", null);
      expect(environment).toHaveProperty("SANDBOX_SUPERVISOR_TOKEN", null);
    }
    const withSocket = Object.entries(productionBase.services).filter(([, service]) =>
      (service.volumes ?? []).some((volume) => volume.includes("docker.sock")),
    );
    expect(withSocket.map(([name]) => name)).toEqual(["updater"]);
  });

  it("lets the web server reach the supervisor origin for relayed screens", () => {
    // The API seals the supervisor's relay URL into the screen capability and the web server is
    // what fetches it, so web needs egress like the API and worker do, not an internal network.
    expect(productionBase.services.web?.networks).toContain("app");
    expect(productionBase.networks?.app?.internal).not.toBe(true);
  });
});
