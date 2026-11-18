import { once } from "node:events";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import net, { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS,
  SCREEN_PROXY_TTL_MS,
  SCREEN_RELAY_HEADER,
} from "@rakazo/core/node/screen-capability";
import { deferred } from "@rakazo/core/test-async";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScreenRelay,
  issueScreenRelayCredential,
  openScreenRelayCredential,
  relayRequestPath,
  relayUpgradePath,
  screenAnswer,
  screenRelayExpiry,
  screenRelayTarget,
} from "./screen-relay.js";

const SECRET = "test-supervisor-token";
const BOOT = "2026-01-02T03:04:05.000Z";
const CONTAINER_ID = "a".repeat(64);
const NOW = 1_000_000;
const WINDOW_MS = SCREEN_PROXY_TTL_MS - REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS;
const WINDOW_END = (Math.floor(NOW / WINDOW_MS) + 1) * WINDOW_MS;
const PAGE = "<!doctype html><title>computer</title>";
const MODULE = "export const rfb = 1;";

const target = {
  botId: "bot",
  spaceId: "space",
  containerId: CONTAINER_ID,
  boot: BOOT,
  port: "6080",
  token: "view-token",
};

const pagePath = "/embed.html?path=websockify%3Ftoken%3Dview-token&view_only=true";

function containerInfo(
  options: {
    boot?: string;
    id?: string;
    labels?: Record<string, string>;
    port?: number;
    running?: boolean;
  } = {},
) {
  const {
    id = CONTAINER_ID,
    port,
    boot = BOOT,
    running = true,
    labels = {
      "rakazo.botId": "bot",
      "rakazo.spaceId": "space",
      "rakazo.managed": "true",
      "rakazo.homeMode": "remote",
    },
  } = options;
  return {
    Id: id,
    Config: { Image: "rakazo/computer:local", Labels: labels },
    State: { Running: running, StartedAt: boot },
    HostConfig: { NetworkMode: "bridge" },
    NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } },
  } as unknown as Docker.ContainerInspectInfo;
}

const open: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (open.length) await open.pop()?.();
});

async function listen(server: Server | net.Server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A bare TCP screen: no HTTP of its own, so a test sends exactly its bytes and then closes. */
function tcpScreen(onConnection: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    onConnection(socket);
  });
  open.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return server;
}

function close(server: Server | net.Server) {
  open.push(
    () =>
      new Promise<void>((resolve) => {
        // An upgraded socket belongs to no request any more, so it never closes by itself.
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
}

/** A computer's screen on loopback: the page, one module, and a socket that echoes. */
async function fakeScreen() {
  const seen: Array<{
    authorization?: string;
    host?: string;
    origin?: string;
    path: string;
    relay?: string;
  }> = [];
  const server = createServer((request, response) => {
    seen.push({
      path: request.url ?? "",
      host: request.headers.host,
      origin: request.headers.origin,
      authorization: request.headers.authorization,
      relay: request.headers[SCREEN_RELAY_HEADER] as string | undefined,
    });
    if ((request.url ?? "").startsWith("/embed.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
      return;
    }
    if ((request.url ?? "").startsWith("/core/rfb.js")) {
      response.writeHead(200, {
        "cache-control": "max-age=60",
        "content-type": "text/javascript",
        "set-cookie": "screen=1",
      });
      response.end(MODULE);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("missing");
  });
  server.on("upgrade", (request, socket) => {
    seen.push({
      path: request.url ?? "",
      host: request.headers.host,
      origin: request.headers.origin,
    });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    // Like a socket server, this one ends with whoever ends and echoes what it is sent.
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end());
    socket.on("error", () => undefined);
  });
  const port = await listen(server);
  close(server);
  return { port, seen };
}

async function relayUnderTest(
  options: {
    info?: () => Promise<Docker.ContainerInspectInfo>;
    now?: () => number;
    secret?: string;
    idleTimeoutMs?: number;
    handshakeTimeoutMs?: number;
  } = {},
) {
  const docker = {
    getContainer: vi.fn((id: string) => ({
      inspect: options.info ?? (async () => containerInfo({ id })),
    })),
  };
  const relay = createScreenRelay({
    secret: options.secret ?? SECRET,
    homeMode: "remote",
    docker: docker as unknown as Pick<Docker, "getContainer">,
    now: options.now ?? (() => NOW),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
  });
  const server = createServer((request, response) => {
    if (relay.handles(request)) void relay.request(request, response);
    else {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
    }
  });
  relay.attach(server);
  const port = await listen(server);
  close(server);
  return { url: `http://127.0.0.1:${port}`, port, docker };
}

function credentialHeaders(claims = target, secret = SECRET) {
  return { [SCREEN_RELAY_HEADER]: issueScreenRelayCredential(claims, secret, NOW) };
}

/** One handshake written by hand, so a request header and its refusal are both visible. */
async function handshake(port: number, path: string, headers: Record<string, string>) {
  const socket = connect(port, "127.0.0.1");
  open.push(() => socket.destroy());
  socket.on("error", () => undefined);
  await once(socket, "connect");
  const received: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {
    received.push(chunk);
  });
  const text = () => Buffer.concat(received).toString("latin1");
  // TCP may split a handshake or echo across chunks. Wait for the full answer or a closed socket.
  const nextAnswer = async (test: () => boolean) => {
    if (test() || socket.destroyed) return;
    const answer = deferred<void>();
    const onData = () => {
      if (test()) answer.resolve();
    };
    const onClose = () => answer.resolve();
    socket.on("data", onData);
    socket.once("close", onClose);
    try {
      await answer.promise;
    } finally {
      socket.off("data", onData);
      socket.off("close", onClose);
    }
  };
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"),
  );
  await nextAnswer(() => text().includes("\r\n\r\n") || socket.destroyed);
  const head = text();
  const status = Number(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
  const boundary = head.indexOf("\r\n\r\n") + 4;
  return {
    status,
    socket,
    echoed: async (value: string) => {
      if (value) socket.write(value);
      await nextAnswer(() => text().slice(boundary).includes(value));
      return text().slice(boundary);
    },
  };
}

describe("screen relay credentials", () => {
  it("seals one screen of one computer and opens it back", () => {
    const credential = issueScreenRelayCredential(target, SECRET, NOW);
    expect(openScreenRelayCredential(credential, SECRET, NOW)).toEqual({
      ...target,
      expiresAt: screenRelayExpiry(NOW),
    });
  });

  it("keeps the same credential all window, so re-reading a screen URL does not rotate it", () => {
    const first = issueScreenRelayCredential(target, SECRET, NOW);
    expect(issueScreenRelayCredential(target, SECRET, WINDOW_END - 1)).toBe(first);
    expect(issueScreenRelayCredential(target, SECRET, WINDOW_END)).not.toBe(first);
    // Every other screen and token is somebody else's credential; the token is what separates
    // the view, control and terminal of one screen.
    for (const other of [
      { ...target, token: "control-token" },
      { ...target, token: "terminal-token" },
      { ...target, containerId: "b".repeat(64) },
      { ...target, boot: "2026-01-03T00:00:00.000Z" },
      { ...target, port: "6090" },
    ]) {
      expect(issueScreenRelayCredential(other, SECRET, NOW), JSON.stringify(other)).not.toBe(first);
    }
  });

  it("outlives the screen capability sealed from it", () => {
    const claims = openScreenRelayCredential(
      issueScreenRelayCredential(target, SECRET, NOW),
      SECRET,
      NOW,
    );
    // The capability sealed at the same moment runs out a window sooner.
    expect(claims?.expiresAt).toBeGreaterThan(NOW + SCREEN_PROXY_TTL_MS);
    expect(
      openScreenRelayCredential(
        issueScreenRelayCredential(target, SECRET, NOW),
        SECRET,
        claims!.expiresAt,
      ),
    ).toBeNull();
  });

  it("refuses a tampered, foreign, expired or malformed credential", () => {
    const credential = issueScreenRelayCredential(target, SECRET, NOW);
    const [payload = "", signature = ""] = credential.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...target, token: "control-token", expiresAt: screenRelayExpiry(NOW) }),
    ).toString("base64url");
    expect(openScreenRelayCredential(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
    expect(
      openScreenRelayCredential(`${payload}.${"A".repeat(signature.length)}`, SECRET, NOW),
    ).toBeNull();
    expect(openScreenRelayCredential(credential, "another-supervisor-token", NOW)).toBeNull();
    expect(openScreenRelayCredential(credential, SECRET, screenRelayExpiry(NOW))).toBeNull();
    for (const value of [undefined, "", "nope", `${payload}.`, `${payload}.${signature}.extra`])
      expect(openScreenRelayCredential(value, SECRET, NOW), String(value)).toBeNull();
  });

  it("names the container a screen was set up in, and nothing without one", () => {
    const info = containerInfo();
    expect(screenRelayTarget(info, { port: "6080", token: "view-token" })).toEqual(target);
    expect(() =>
      screenRelayTarget({ ...info, State: { Running: true } } as Docker.ContainerInspectInfo, {
        port: "6080",
        token: "view-token",
      }),
    ).toThrow(/no managed container/);
  });
});

describe("screen relay paths", () => {
  it("relays the page and the files it loads, at the token this credential names", () => {
    expect(relayRequestPath(pagePath, "view-token")).toBe(pagePath);
    expect(relayRequestPath("/core/rfb.js", "view-token")).toBe("/core/rfb.js");
    expect(relayRequestPath("/vendor/pako.js?v=2", "view-token")).toBe("/vendor/pako.js?v=2");
    expect(relayRequestPath("/clipboard-bridge.js", "view-token")).toBe("/clipboard-bridge.js");
  });

  it("relays nothing else, whoever asks", () => {
    for (const path of [
      undefined,
      "/computers/container-1/exec",
      "/health",
      "/app/ui.js",
      "/app/",
      "/core/rfb.js/../../computers",
      "/core/%2e%2e/computers",
      "http://elsewhere.example.test/embed.html",
      "/websockify?token=view-token",
    ])
      expect(relayRequestPath(path, "view-token"), String(path)).toBeNull();
    // The page may only be told about the socket this credential names.
    expect(
      relayRequestPath("/embed.html?path=websockify%3Ftoken%3Dcontrol-token", "view-token"),
    ).toBeNull();
    expect(relayRequestPath("/embed.html", "view-token")).toBeNull();
  });

  it("upgrades only the socket this credential names", () => {
    expect(relayUpgradePath("/websockify?token=view-token", "view-token")).toBe(
      "/websockify?token=view-token",
    );
    expect(relayUpgradePath("/websockify?token=control-token", "view-token")).toBeNull();
    expect(relayUpgradePath("/websockify", "view-token")).toBeNull();
    expect(relayUpgradePath(pagePath, "view-token")).toBeNull();
  });
});

describe("screen answers", () => {
  it("keeps a local supervisor's published screen URL as it is", () => {
    const published = "http://127.0.0.1:49152/embed.html";
    expect(
      screenAnswer({
        mode: "local",
        publishedUrl: published,
        token: "view-token",
        secret: SECRET,
        info: containerInfo(),
        port: "6080",
      }),
    ).toEqual({
      url: "http://127.0.0.1:49152/embed.html?path=websockify%3Ftoken%3Dview-token",
    });
  });

  it("answers for a remote supervisor with its relay path and a credential for that screen", () => {
    const answer = screenAnswer({
      mode: "remote",
      publishedUrl: "http://127.0.0.1:49152/embed.html",
      token: "view-token",
      secret: SECRET,
      info: containerInfo(),
      port: "6080",
    });
    expect(answer.url).toBe("/embed.html?path=websockify%3Ftoken%3Dview-token");
    expect(openScreenRelayCredential(answer.relayCredential, SECRET, NOW)).toMatchObject(target);
  });
});

describe("screen relay", () => {
  it("relays the page and the files it loads to the computer it names", async () => {
    const screen = await fakeScreen();
    const relay = await relayUnderTest({ info: async () => containerInfo({ port: screen.port }) });
    const page = await fetch(`${relay.url}${pagePath}`, { headers: credentialHeaders() });
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toBe(PAGE);
    const module = await fetch(`${relay.url}/core/rfb.js`, { headers: credentialHeaders() });
    expect(module.status).toBe(200);
    await expect(module.text()).resolves.toBe(MODULE);
    // A screen answers with its own headers, but cannot set cookies for this origin.
    expect(module.headers.get("cache-control")).toBe("max-age=60");
    expect(module.headers.get("set-cookie")).toBeNull();
    // Neither the service bearer nor the relay's own credential reaches the computer.
    expect(screen.seen).toEqual([
      {
        path: pagePath,
        host: `127.0.0.1:${screen.port}`,
        origin: `http://127.0.0.1:${screen.port}`,
        authorization: undefined,
        relay: undefined,
      },
      {
        path: "/core/rfb.js",
        host: `127.0.0.1:${screen.port}`,
        origin: `http://127.0.0.1:${screen.port}`,
        authorization: undefined,
        relay: undefined,
      },
    ]);
  });

  it("answers a HEAD without a body", async () => {
    const screen = await fakeScreen();
    const relay = await relayUnderTest({ info: async () => containerInfo({ port: screen.port }) });
    const head = await fetch(`${relay.url}${pagePath}`, {
      method: "HEAD",
      headers: credentialHeaders(),
    });
    expect(head.status).toBe(200);
    await expect(head.text()).resolves.toBe("");
  });

  it("refuses what the credential does not name", async () => {
    const screen = await fakeScreen();
    const relay = await relayUnderTest({ info: async () => containerInfo({ port: screen.port }) });
    const cases: Array<[string, RequestInit, number]> = [
      // No credential at all is not even a relay request; a bad one is refused here.
      ["/embed.html?path=websockify%3Ftoken%3Dview-token", { headers: {} }, 401],
      [
        `/embed.html?path=websockify%3Ftoken%3Dview-token`,
        { headers: { [SCREEN_RELAY_HEADER]: "forged" } },
        403,
      ],
      [
        `/embed.html?path=websockify%3Ftoken%3Dview-token`,
        { method: "POST", headers: credentialHeaders() },
        405,
      ],
      [
        `/embed.html?path=websockify%3Ftoken%3Dcontrol-token`,
        { headers: credentialHeaders() },
        404,
      ],
      ["/computers/container-1/exec", { headers: credentialHeaders() }, 404],
      ["/core/../computers/container-1/exec", { headers: credentialHeaders() }, 404],
    ];
    for (const [path, init, status] of cases) {
      const response = await fetch(`${relay.url}${path}`, init);
      expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(status);
      await response.arrayBuffer();
    }
    expect(screen.seen).toEqual([]);
  });

  it("refuses an expired or foreign credential", async () => {
    const screen = await fakeScreen();
    const expired = await relayUnderTest({
      info: async () => containerInfo({ port: screen.port }),
      now: () => screenRelayExpiry(NOW),
    });
    const response = await fetch(`${expired.url}${pagePath}`, { headers: credentialHeaders() });
    expect(response.status).toBe(403);
    await response.arrayBuffer();

    const foreign = await relayUnderTest({
      info: async () => containerInfo({ port: screen.port }),
      secret: "another-supervisor-token",
    });
    const rejected = await fetch(`${foreign.url}${pagePath}`, { headers: credentialHeaders() });
    expect(rejected.status).toBe(403);
    await rejected.arrayBuffer();
    expect(screen.seen).toEqual([]);
  });

  it("refuses a computer that restarted, moved, or is no longer this bot's", async () => {
    const screen = await fakeScreen();
    const inspected: Array<Docker.ContainerInspectInfo> = [
      containerInfo({ port: screen.port, boot: "2026-01-03T00:00:00.000Z" }),
      containerInfo({ port: screen.port, running: false }),
      containerInfo({ port: screen.port, id: "b".repeat(64) }),
      containerInfo({ port: screen.port, labels: { "rakazo.botId": "other" } }),
      containerInfo({ port: screen.port, labels: { "rakazo.homeMode": "local" } }),
    ];
    let index = 0;
    const relay = await relayUnderTest({
      info: async () => {
        const info = inspected[index++];
        if (!info) throw new Error("no such container");
        return info;
      },
    });
    for (let attempt = 0; attempt < inspected.length + 1; attempt += 1) {
      const response = await fetch(`${relay.url}${pagePath}`, { headers: credentialHeaders() });
      expect(response.status, String(attempt)).toBe(404);
      await response.arrayBuffer();
    }
    expect(screen.seen).toEqual([]);
  });

  it("answers when the computer's screen is not taking connections", async () => {
    const gone = createServer();
    const port = await listen(gone);
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    const relay = await relayUnderTest({ info: async () => containerInfo({ port }) });
    const response = await fetch(`${relay.url}${pagePath}`, { headers: credentialHeaders() });
    expect(response.status).toBe(502);
    await response.arrayBuffer();
  });

  it("answers the caller when the computer's screen never answers at all", async () => {
    // A screen that takes the connection and then says nothing would hold this caller open until
    // its own client gave up, so the deadline answers here instead.
    const silent = tcpScreen(() => undefined);
    const port = await listen(silent);
    const relay = await relayUnderTest({
      info: async () => containerInfo({ port }),
      idleTimeoutMs: 50,
    });
    const response = await fetch(`${relay.url}${pagePath}`, { headers: credentialHeaders() });
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe("Screen unavailable\n");
  });

  it("relays the screen's socket and ends it with either side", async () => {
    const screen = await fakeScreen();
    const relay = await relayUnderTest({ info: async () => containerInfo({ port: screen.port }) });
    const socket = await handshake(relay.port, "/websockify?token=view-token", credentialHeaders());
    expect(socket.status).toBe(101);
    await expect(socket.echoed("ping")).resolves.toBe("ping");
    expect(screen.seen).toEqual([
      {
        path: "/websockify?token=view-token",
        host: `127.0.0.1:${screen.port}`,
        origin: `http://127.0.0.1:${screen.port}`,
      },
    ]);
  });

  it("refuses a socket for another token, or anything but the socket", async () => {
    const screen = await fakeScreen();
    const relay = await relayUnderTest({ info: async () => containerInfo({ port: screen.port }) });
    for (const [path, status] of [
      ["/websockify?token=control-token", 404],
      ["/websockify", 404],
      [pagePath, 404],
    ] as const) {
      const refused = await handshake(relay.port, path, credentialHeaders());
      expect(refused.status, path).toBe(status);
    }
    const forged = await handshake(relay.port, "/websockify?token=view-token", {
      [SCREEN_RELAY_HEADER]: "forged",
    });
    expect(forged.status).toBe(403);
    expect(screen.seen).toEqual([]);
  });
});

describe("screen relay bounds", () => {
  // Short enough to keep these tests quick, long enough that a loaded test runner still lets the
  // screen answer before the deadline.
  const idleTimeoutMs = 200;

  it("keeps waiting for a caller that is slow to read, instead of calling the pause a stall", async () => {
    // A caller that stops reading fills this relay's answer, which pauses the screen upstream. That
    // is the caller's pace, not a stalled screen: after several idle deadlines with nothing read,
    // the whole answer is still there, and only then does the caller take it.
    const body = "x".repeat(8 * 1024 * 1024);
    const slow = createServer((_request, response) => {
      response.writeHead(200, {
        "content-length": String(body.length),
        "content-type": "text/plain",
      });
      response.end(body);
    });
    const port = await listen(slow);
    close(slow);
    const relay = await relayUnderTest({
      info: async () => containerInfo({ port }),
      idleTimeoutMs,
    });
    const socket = connect(relay.port, "127.0.0.1");
    open.push(() => socket.destroy());
    let failure: Error | undefined;
    socket.on("error", (error) => {
      failure = error;
    });
    try {
      await once(socket, "connect");
      socket.write(
        [
          `GET ${pagePath} HTTP/1.1`,
          `Host: 127.0.0.1:${relay.port}`,
          "connection: close",
          ...Object.entries(credentialHeaders()).map(([name, value]) => `${name}: ${value}`),
          "",
          "",
        ].join("\r\n"),
      );
      const received: Buffer[] = [];
      // The answer's head arrives at once; from then on this caller takes nothing at all.
      socket.once("data", (chunk: Buffer) => {
        received.push(chunk);
        socket.pause();
      });
      await once(socket, "data");
      // Nothing is read for four deadlines, so the answer stays full and the screen stays paused.
      await delay(idleTimeoutMs * 4);
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      const closed = once(socket, "close");
      socket.resume();
      await closed;
      const answer = Buffer.concat(received).toString("latin1");
      expect(failure).toBeUndefined();
      expect(answer).toMatch(/^HTTP\/1\.1 200/);
      expect(answer.slice(answer.indexOf("\r\n\r\n") + 4)).toBe(body);
    } finally {
      socket.destroy();
    }
  });

  it("ends a screen answer that goes quiet partway through", async () => {
    // A screen that sends its headers and then stops would hold the caller open with half a page.
    const quiet = createServer((_request, response) => {
      response.writeHead(200, {
        "content-length": String(PAGE.length),
        "content-type": "text/html; charset=utf-8",
      });
      response.write(PAGE.slice(0, 10));
    });
    const port = await listen(quiet);
    close(quiet);
    const relay = await relayUnderTest({
      info: async () => containerInfo({ port }),
      idleTimeoutMs,
    });
    const page = await fetch(`${relay.url}${pagePath}`, { headers: credentialHeaders() });
    expect(page.status).toBe(200);
    await expect(page.text()).rejects.toThrow();
  });

  it("cuts the caller off when the screen's answer fails partway through", async () => {
    // A screen that dies mid-answer would otherwise leave this caller waiting for the rest. The
    // answer promises more than it sends, then closes, as a screen killed partway through does.
    const broken = tcpScreen((socket) => {
      socket.end(
        [
          "HTTP/1.1 200 OK",
          "content-type: text/html; charset=utf-8",
          `content-length: ${PAGE.length}`,
          "",
          PAGE.slice(0, 5),
        ].join("\r\n"),
      );
    });
    const port = await listen(broken);
    const relay = await relayUnderTest({ info: async () => containerInfo({ port }) });
    const page = await fetch(`${relay.url}${pagePath}`, { headers: credentialHeaders() });
    const answer = await page.text().then(
      (text) => text,
      (error: unknown) => error,
    );
    expect(answer).toBeInstanceOf(Error);
  });

  it("gives up on a screen socket that never answers the upgrade", async () => {
    // The computer accepts the connection and says nothing: the browser's socket must not stay
    // open waiting for an answer that is not coming.
    const silent = tcpScreen(() => undefined);
    const port = await listen(silent);
    const relay = await relayUnderTest({
      info: async () => containerInfo({ port }),
      handshakeTimeoutMs: 50,
    });
    const socket = await handshake(relay.port, "/websockify?token=view-token", credentialHeaders());
    expect(socket.status).toBeNaN();
    expect(socket.socket.destroyed).toBe(true);
  });

  it("does not time out a screen socket that already answered", async () => {
    // The deadline is the handshake's: an established screen stays open however long it is idle.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const screen = await fakeScreen();
      const relay = await relayUnderTest({
        info: async () => containerInfo({ port: screen.port }),
        handshakeTimeoutMs: 50,
      });
      const socket = await handshake(
        relay.port,
        "/websockify?token=view-token",
        credentialHeaders(),
      );
      expect(socket.status).toBe(101);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(socket.echoed("ping")).resolves.toBe("ping");
    } finally {
      vi.useRealTimers();
    }
  });
});
