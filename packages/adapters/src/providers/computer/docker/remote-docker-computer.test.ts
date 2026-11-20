import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ScreenCapabilityScope } from "@rakazo/core/node/screen-capability";
import {
  openScreenCapability,
  SCREEN_RELAY_HEADER,
  sealScreenCapability,
} from "@rakazo/core/node/screen-capability";
import { describe, expect, it, vi } from "vitest";
import { dockerComputer } from "./docker-computer.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { emulatedDockerSupervisor } from "./docker-sandbox.test-support.js";
import { remoteDockerComputer, remoteDockerSupervisorOrigin } from "./remote-docker-computer.js";

const context: AdapterContext = {
  operationId: "remote-docker-test",
  traceId: "remote-docker-test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

const computer = { id: "computer", botId: "bot", providerRef: "computer" } as const;
const screenCapabilityScope: ScreenCapabilityScope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 2,
  computerGeneration: 3,
  controlLeaseId: null,
};

/** The answer a supervisor that relays its screens gives: a path on itself and a credential. */
const relayedScreen = {
  screenUrl: "/embed.html?path=websockify%3Ftoken%3Dview-token",
  relayCredential: "relay-credential",
};

describe("remoteDockerSupervisorOrigin", () => {
  it("keeps an explicit http or https origin", () => {
    expect(remoteDockerSupervisorOrigin("http://127.0.0.1:7091")).toBe("http://127.0.0.1:7091");
    expect(remoteDockerSupervisorOrigin(" https://supervisor.example.test ")).toBe(
      "https://supervisor.example.test",
    );
    expect(remoteDockerSupervisorOrigin("https://supervisor.example.test/")).toBe(
      "https://supervisor.example.test",
    );
  });

  it("refuses a missing, relative or non-http origin", () => {
    for (const value of [undefined, "", "  ", "supervisor.example.test", "ftp://host"]) {
      expect(() => remoteDockerSupervisorOrigin(value), String(value)).toThrow(
        /SANDBOX_SUPERVISOR_URL/,
      );
    }
  });

  it("refuses anything beyond an origin", () => {
    for (const value of [
      "https://user:secret@supervisor.example.test",
      "https://supervisor.example.test/?token=secret",
      "https://supervisor.example.test/computers",
      "https://supervisor.example.test/#screen",
    ]) {
      expect(() => remoteDockerSupervisorOrigin(value), value).toThrow(/origin/);
    }
  });

  it("never repeats a malformed origin back in the error it throws", () => {
    // A configured origin can carry a credential, so neither the message nor anything chained to
    // it may quote the value that could not be read.
    const malformed = "https://user:secret-token@[supervisor.example.test";
    let thrown: unknown;
    try {
      remoteDockerSupervisorOrigin(malformed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toBe("SANDBOX_SUPERVISOR_URL must be an http(s) origin");
    expect(error.cause).toBeUndefined();
    expect(`${error.message}${String(error.cause)}`).not.toContain("secret-token");
  });
});

describe("remote Docker provider definition", () => {
  it("keeps each computer's home in the computer, which the server may write", () => {
    expect(remoteDockerComputer.capabilities).toMatchObject({
      serverHomeMount: "never",
      serverOwnsStoredTeamHome: true,
      storedHomeIsBackup: false,
    });
    // Ordinary Docker keeps using the server's home, unchanged.
    expect(dockerComputer.capabilities).toMatchObject({
      serverHomeMount: "always",
      serverOwnsStoredTeamHome: false,
      storedHomeIsBackup: true,
    });
  });

  it("has nowhere to run without an origin and fails on a malformed one", () => {
    expect(remoteDockerComputer.unavailable?.({})).toBe(true);
    expect(remoteDockerComputer.unavailable?.({ SANDBOX_SUPERVISOR_URL: " " })).toBe(true);
    expect(() =>
      remoteDockerComputer.unavailable?.({ SANDBOX_SUPERVISOR_URL: "ftp://host" }),
    ).toThrow(/SANDBOX_SUPERVISOR_URL/);
    expect(
      remoteDockerComputer.unavailable?.({
        SANDBOX_SUPERVISOR_URL: "https://supervisor.example.test",
      }),
    ).toBe(false);
  });

  it("needs the supervisor token in production, as Docker does", () => {
    const production = {
      NODE_ENV: "production",
      SANDBOX_SUPERVISOR_URL: "https://supervisor.example.test",
    };
    expect(remoteDockerComputer.unavailable?.(production)).toBe(true);
    expect(
      remoteDockerComputer.unavailable?.({
        ...production,
        SANDBOX_SUPERVISOR_TOKEN: "production-supervisor-token-32-chars",
      }),
    ).toBe(false);
  });
});

describe("remote Docker sandbox", () => {
  it("provisions without a server home path and reports its own kind", async () => {
    const supervisor = await emulatedDockerSupervisor({ homeMode: "remote" });
    try {
      const provider = new DockerSandboxProvider(
        supervisor.url,
        "test-supervisor-token",
        "remote-docker",
      );
      expect(provider.describe().id).toBe("remote-docker");
      const computer = await provider.provision(
        { botId: "bot", homePath: "/data/homes/bot" },
        context,
      );
      expect(computer).toMatchObject({ kind: "remote-docker", botId: "bot", fresh: true });
      expect(supervisor.provisions).toEqual([{ botId: "bot", spaceId: "space" }]);
    } finally {
      await supervisor.close();
    }
  });

  it("still sends the home path to a local Docker supervisor", async () => {
    const supervisor = await emulatedDockerSupervisor({ homeMode: "local" });
    try {
      const provider = new DockerSandboxProvider(supervisor.url, "test-supervisor-token");
      const computer = await provider.provision(
        { botId: "bot", homePath: "/data/homes/bot" },
        context,
      );
      expect(computer.kind).toBe("docker");
      expect(supervisor.provisions).toEqual([
        { botId: "bot", homePath: "/data/homes/bot", spaceId: "space" },
      ]);
    } finally {
      await supervisor.close();
    }
  });

  it("ignores a running computer that belongs to the other supervisor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new DockerSandboxProvider(
        "https://supervisor.example.test",
        "test-supervisor-token",
        "remote-docker",
      );
      await expect(
        provider.isRunning(
          { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
          context,
        ),
      ).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks for no redirects and treats a supervisor's 3xx as a failure", async () => {
    const fetchMock = vi.fn(async () => Response.redirect("https://elsewhere.example.test", 307));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new DockerSandboxProvider(
        "https://supervisor.example.test",
        "test-supervisor-token",
        "remote-docker",
      );
      await expect(
        provider.provision({ botId: "bot", homePath: "/data/homes/bot" }, context),
      ).rejects.toThrow(/sandbox provision failed: 307/);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://supervisor.example.test/computers",
        expect.objectContaining({ redirect: "error" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("remote Docker screens", () => {
  it("shows a remote screen through the supervisor's own origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(relayedScreen)),
    );
    try {
      const provider = new DockerSandboxProvider(
        "https://supervisor.example.test",
        "test-supervisor-token",
        "remote-docker",
      );
      const session = await provider.connectScreen(
        { ...computer, kind: "remote-docker" },
        { view: "stream" },
        context,
      );
      expect(session.url).toBe(
        "https://supervisor.example.test/embed.html?path=websockify%3Ftoken%3Dview-token",
      );
      // The credential is the provider's own, and only the server proxy ever sends it.
      expect(session.headers).toEqual({ [SCREEN_RELAY_HEADER]: "relay-credential" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a remote terminal through the same relay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          terminalUrl: "/embed.html?path=websockify%3Ftoken%3Dterminal-token",
          relayCredential: "terminal-credential",
        }),
      ),
    );
    try {
      const provider = new DockerSandboxProvider(
        "https://supervisor.example.test",
        "test-supervisor-token",
        "remote-docker",
      );
      await expect(
        provider.connectTerminal(
          { ...computer, kind: "remote-docker" },
          { controlToken: "human-control", cwd: "" },
          context,
        ),
      ).resolves.toEqual({
        url: "https://supervisor.example.test/embed.html?path=websockify%3Ftoken%3Dterminal-token",
        headers: { [SCREEN_RELAY_HEADER]: "terminal-credential" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a local supervisor's published address and adds no credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          screenUrl: "http://127.0.0.1:49152/embed.html?path=websockify%3Ftoken%3Dview-token",
        }),
      ),
    );
    try {
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-supervisor-token");
      const session = await provider.connectScreen(
        { ...computer, kind: "docker" },
        { view: "stream" },
        context,
      );
      expect(session.url).toBe(
        "http://127.0.0.1:49152/embed.html?path=websockify%3Ftoken%3Dview-token",
      );
      expect(session.headers).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["https://supervisor.example.test", "http://10.0.0.5:7091"])(
    "seals a relayed screen into a capability the proxy opens (%s)",
    async (origin) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(relayedScreen)),
      );
      try {
        const provider = new DockerSandboxProvider(
          origin,
          "test-supervisor-token",
          "remote-docker",
        );
        const session = await provider.connectScreen(
          { ...computer, kind: "remote-docker" },
          { view: "stream" },
          context,
        );
        const sealed = new URL(
          sealScreenCapability(
            session.url!,
            "screen-proxy-secret",
            "https://app.example",
            screenCapabilityScope,
            100,
            session.headers,
          ),
        );
        // Only the relay's own page and socket are reachable, both on the supervisor's origin.
        const supervisor = new URL(origin);
        const page = openScreenCapability(
          `${sealed.pathname}${sealed.search}`,
          "screen-proxy-secret",
          1_000,
        );
        expect(page?.target).toMatchObject({
          protocol: supervisor.protocol,
          hostname: supervisor.hostname,
          // https needs no port; a plain one must be a private address on a port a screen allows.
          port: Number(supervisor.port || (supervisor.protocol === "https:" ? 443 : 80)),
          path: "/embed.html?path=websockify%3Ftoken%3Dview-token&view_only=true",
          headers: { [SCREEN_RELAY_HEADER]: "relay-credential" },
        });
        const socket = openScreenCapability(
          sealed.pathname.replace("/embed.html", "/websockify"),
          "screen-proxy-secret",
          1_000,
        );
        expect(socket?.target.path).toBe("/websockify?token=view-token");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
