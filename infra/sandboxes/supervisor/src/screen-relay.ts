import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import {
  REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS,
  SCREEN_PROXY_TTL_MS,
  SCREEN_RELAY_HEADER,
} from "@rakazo/core/node/screen-capability";
import { getLogger } from "@rakazo/logging";
import type Docker from "dockerode";
import { COMPUTER_IMAGE, screenRelayPath, screenUrlWithToken } from "./computer-spec.js";
import type { ComputerHomeMode } from "./computers/home.js";
import { screenPublishTarget } from "./readiness.js";
import { isManagedComputer, labeledSpaceId } from "./supervisor-logic.js";

/**
 * What a relay credential names: one screen of one computer, opened with one socket token. The
 * supervisor relays nothing a credential does not name, so no caller can choose an upstream.
 *
 * The token is what separates view, control and terminal: each is a different websockify token on
 * the computer, so the credential needs no policy of its own. A computer's screen reaches the
 * browser through this supervisor instead of its own address.
 */
export interface ScreenRelayTarget {
  botId: string;
  spaceId: string;
  containerId: string;
  /** The container's start time: a credential stops working once that computer restarts. */
  boot: string;
  /** The container port serving the screen, as a Docker port key names it. */
  port: string;
  /** The container's own websockify token, which is what the screen was opened with. */
  token: string;
}

interface ScreenRelayClaims extends ScreenRelayTarget {
  expiresAt: number;
}

export interface ScreenRelayOptions {
  /** The service token: a relay credential is signed from it under its own domain. */
  secret: string;
  /** The mode of the computers this supervisor manages; a relay serves only its own. */
  homeMode: ComputerHomeMode;
  docker: Pick<Docker, "getContainer">;
  now?: () => number;
  /** How long a screen may send nothing while a page or file is fetched (see RELAY_IDLE_TIMEOUT_MS). */
  idleTimeoutMs?: number;
  /** How long a screen's socket may take to connect and answer (see RELAY_HANDSHAKE_TIMEOUT_MS). */
  handshakeTimeoutMs?: number;
}

export interface ScreenRelay {
  /** Whether this request is a screen relay rather than a call to the supervisor's own API. */
  handles(request: IncomingMessage): boolean;
  /** GET or HEAD of the screen page and the files it loads. */
  request(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** The page's WebSocket, from the browser through the server proxy. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  /** Answer the upgrades on this listener; Node drops one nobody listens for. */
  attach(server: http.Server): void;
}

const RELAY_DOMAIN = "rakazo screen relay credential v1";
const RELAY_WINDOW_MS = SCREEN_PROXY_TTL_MS - REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS;
/**
 * A screen that answers nothing for this long, or stops sending mid-answer, is not answering: the
 * caller is cut off instead of held open with a frame that never fills.
 */
const RELAY_IDLE_TIMEOUT_MS = 20_000;
/**
 * A screen's socket has this long to connect and answer the upgrade. It is not a limit on the
 * stream: once the screen answers, an open screen stays open however long it is idle.
 */
const RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;
const RELAY_BASE = "http://screen-relay.invalid";
const RELAY_PAGE = "/embed.html";
const RELAY_SOCKET = "/websockify";
/** The files the image's screen page and noVNC load, and nothing else. */
const RELAY_FILES = new Set([RELAY_PAGE, "/clipboard-bridge.js", "/mobile-keyboard.js"]);
const RELAY_DIRECTORIES = ["/core/", "/vendor/"];
const RELAY_FORWARDED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-length",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "pragma",
  "range",
  "user-agent",
]);
const RELAY_UPGRADE_HEADERS = [
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "user-agent",
];
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
// A screen cannot set or clear cookies for the origin it shares with the supervisor's API.
const WITHHELD_HEADERS = new Set(["set-cookie", "set-cookie2", "clear-site-data"]);

/**
 * When a credential issued now runs out. A screen capability sealed from it expires with the
 * window it was issued in, so this is that window's end plus one more, and the same screen seals to
 * the same credential all window: re-reading a screen URL never rotates it under an open viewer.
 */
export function screenRelayExpiry(now = Date.now()) {
  return (
    (Math.floor(now / RELAY_WINDOW_MS) + 2) * RELAY_WINDOW_MS +
    REMOTE_SCREEN_CAPABILITY_MIN_REMAINING_MS
  );
}

export function issueScreenRelayCredential(
  target: ScreenRelayTarget,
  secret: string,
  now = Date.now(),
) {
  const payload = Buffer.from(
    JSON.stringify({
      botId: target.botId,
      spaceId: target.spaceId,
      containerId: target.containerId,
      boot: target.boot,
      port: target.port,
      token: target.token,
      expiresAt: screenRelayExpiry(now),
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function openScreenRelayCredential(
  credential: string | undefined,
  secret: string,
  now = Date.now(),
): ScreenRelayClaims | null {
  const [payload, signature, extra] = (credential ?? "").split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", relayKey(secret)).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return relayClaims(parsed, now);
}

/**
 * What a credential for this screen names, read from the container it was just set up in: the
 * labels that say whose computer it is, its ID, and the boot its screen belongs to.
 */
export function screenRelayTarget(
  info: Docker.ContainerInspectInfo,
  screen: { port: string; token: string },
): ScreenRelayTarget {
  const labels = info.Config.Labels ?? {};
  const botId = labels["rakazo.botId"];
  const spaceId = labeledSpaceId(labels);
  const boot = info.State?.StartedAt;
  if (!botId || !spaceId || !info.Id || !boot)
    throw new Error("computer screen has no managed container to relay");
  return { botId, spaceId, containerId: info.Id, boot, ...screen };
}

/**
 * What a screen or terminal answer carries. A local supervisor publishes the address the web server
 * proxies, unchanged. One another deployment reaches over the network relays through itself instead:
 * it answers with a path on itself and a credential naming that one screen, which the adapter seals
 * server-side and only the server proxy ever sends.
 */
export function screenAnswer(answer: {
  mode: ComputerHomeMode;
  publishedUrl: string;
  token: string;
  secret: string;
  info: Docker.ContainerInspectInfo;
  port: string;
}) {
  if (answer.mode !== "remote")
    return { url: screenUrlWithToken(answer.publishedUrl, answer.token) };
  return {
    url: screenRelayPath(answer.token),
    relayCredential: issueScreenRelayCredential(
      screenRelayTarget(answer.info, { port: answer.port, token: answer.token }),
      answer.secret,
    ),
  };
}

/** The path a relayed page or file request reaches the computer at, or null if it is not one. */
export function relayRequestPath(url: string | undefined, token: string) {
  const parsed = relayPath(url);
  if (!parsed || parsed.pathname === RELAY_SOCKET) return null;
  if (
    !RELAY_FILES.has(parsed.pathname) &&
    !RELAY_DIRECTORIES.some((directory) => parsed.pathname.startsWith(directory))
  )
    return null;
  // The page is told which socket to open; it may only be the one this credential names.
  if (parsed.pathname === RELAY_PAGE && socketToken(parsed.searchParams.get("path")) !== token)
    return null;
  return `${parsed.pathname}${parsed.search}`;
}

/** The path a relayed WebSocket upgrade reaches the computer at, or null if it is not one. */
export function relayUpgradePath(url: string | undefined, token: string) {
  const parsed = relayPath(url);
  if (!parsed || parsed.pathname !== RELAY_SOCKET) return null;
  return parsed.searchParams.get("token") === token ? `${parsed.pathname}${parsed.search}` : null;
}

export function createScreenRelay(options: ScreenRelayOptions): ScreenRelay {
  const now = () => options.now?.() ?? Date.now();
  const idleTimeoutMs = options.idleTimeoutMs ?? RELAY_IDLE_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? RELAY_HANDSHAKE_TIMEOUT_MS;
  const claimsOf = (request: IncomingMessage) =>
    openScreenRelayCredential(relayCredential(request.headers), options.secret, now());

  async function destinationOf(claims: ScreenRelayClaims) {
    let info: Docker.ContainerInspectInfo;
    try {
      info = await options.docker.getContainer(claims.containerId).inspect();
    } catch {
      return undefined;
    }
    // The credential names a screen of one computer; the container must still be that computer,
    // on the boot it was issued for, so a replaced or restarted one needs a new credential.
    if (
      info.Id !== claims.containerId ||
      !isManagedComputer(info, claims.botId, claims.spaceId, COMPUTER_IMAGE, options.homeMode) ||
      !info.State?.Running ||
      info.State.StartedAt !== claims.boot
    )
      return undefined;
    const target = await screenPublishTarget(info, claims.port);
    const port = Number(target?.port);
    if (!target || !Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined;
    return { host: target.host, port };
  }

  async function request(incoming: IncomingMessage, response: ServerResponse) {
    try {
      const claims = claimsOf(incoming);
      if (!claims) return refuse(incoming, response, 403, "credential");
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        return refuse(incoming, response, 405, "method");
      }
      const path = relayRequestPath(incoming.url, claims.token);
      if (!path) return refuse(incoming, response, 404, "path");
      const destination = await destinationOf(claims);
      if (!destination) return refuse(incoming, response, 404, "computer");
      if (response.destroyed) return;
      relayHttp(incoming, response, destination, path, idleTimeoutMs);
    } catch (error) {
      // A screen port that cannot be resolved is this screen being unavailable, not the server
      // failing a request it could have answered.
      logFailure("resolve", error);
      refuse(incoming, response, 502, "resolve");
    }
  }

  async function upgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer) {
    // Node drops its own socket error handler on upgrade, so a reset with no listener is fatal.
    socket.on("error", () => undefined);
    try {
      const claims = claimsOf(incoming);
      if (!claims) return endSocket(socket, 403, "credential");
      if (incoming.method !== "GET") return endSocket(socket, 405, "method");
      const path = relayUpgradePath(incoming.url, claims.token);
      if (!path) return endSocket(socket, 404, "path");
      const destination = await destinationOf(claims);
      if (!destination) return endSocket(socket, 404, "computer");
      if (socket.destroyed) return;
      relayUpgrade(incoming, socket, head, destination, path, handshakeTimeoutMs);
    } catch (error) {
      logFailure("resolve", error);
      endSocket(socket, 502, "resolve");
    }
  }

  return {
    handles: (incoming) => isRelayRequest(incoming.headers),
    request,
    upgrade,
    attach(server) {
      server.on("upgrade", (incoming, socket, head) => void upgrade(incoming, socket, head));
    },
  };
}

function logFailure(reason: string, error?: unknown) {
  getLogger().warn("screen relay failed", {
    "screen.relay_reason": reason,
    ...(error === undefined
      ? {}
      : { "error.message": error instanceof Error ? error.message : String(error) }),
  });
}

function relayKey(secret: string) {
  // The same service token seals a different kind of value here: the domain keeps a relay
  // credential from ever standing for anything else the supervisor signs.
  return createHmac("sha256", secret).update(RELAY_DOMAIN).digest();
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", relayKey(secret)).update(payload).digest("base64url");
}

/** Whether this request is for the relay rather than the supervisor's own API. */
function isRelayRequest(headers: IncomingHttpHeaders) {
  return headers[SCREEN_RELAY_HEADER] !== undefined;
}

/** The credential it carries; a header sent twice is nobody's credential. */
function relayCredential(headers: IncomingHttpHeaders) {
  const value = headers[SCREEN_RELAY_HEADER];
  return Array.isArray(value) ? undefined : value;
}

function relayClaims(value: unknown, now: number): ScreenRelayClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  const text = (name: string, longest: number) => {
    const field = claims[name];
    return typeof field === "string" && field.length > 0 && field.length <= longest ? field : null;
  };
  const botId = text("botId", 200);
  const spaceId = text("spaceId", 200);
  const containerId = text("containerId", 200);
  const boot = text("boot", 200);
  const token =
    typeof claims.token === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(claims.token)
      ? claims.token
      : null;
  const port =
    typeof claims.port === "string" && /^\d{1,5}$/.test(claims.port) ? claims.port : null;
  const expiresAt =
    typeof claims.expiresAt === "number" && Number.isSafeInteger(claims.expiresAt)
      ? claims.expiresAt
      : null;
  if (!botId || !spaceId || !containerId || !boot || !token || !port || !expiresAt) return null;
  if (expiresAt <= now) return null;
  return { botId, spaceId, containerId, boot, port, token, expiresAt };
}

function relayPath(url: string | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url, RELAY_BASE);
    return parsed.origin === RELAY_BASE ? parsed : null;
  } catch {
    return null;
  }
}

/** The token a page's `path` parameter names, read the way the page reads it. */
function socketToken(path: string | null) {
  if (!path) return null;
  try {
    return new URL(path, RELAY_BASE).searchParams.get("token");
  } catch {
    return null;
  }
}

/** A refusal, which a HEAD carries without a body like any other answer. */
function refuse(
  incoming: IncomingMessage,
  response: ServerResponse,
  status: number,
  reason: string,
) {
  getLogger().warn("screen relay refused", {
    "screen.relay_reason": reason,
    "http.status": status,
  });
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(incoming.method === "HEAD" ? undefined : "Screen unavailable\n");
}

function endSocket(socket: Duplex, status: number, reason: string) {
  getLogger().warn("screen relay upgrade refused", {
    "screen.relay_reason": reason,
    "http.status": status,
  });
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
  );
}

function hostHeader(destination: { host: string; port: number }) {
  const host = destination.host.includes(":") ? `[${destination.host}]` : destination.host;
  return `${host}:${destination.port}`;
}

/** The computer's own origin: the page and its socket are served from it, not from this one. */
function destinationOrigin(destination: { host: string; port: number }) {
  return `http://${hostHeader(destination)}`;
}

/** Only what a screen page and its socket need reach the computer; nothing else is passed on. */
function relayHeaders(headers: IncomingHttpHeaders, destination: { host: string; port: number }) {
  const forwarded = Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value != null && RELAY_FORWARDED_HEADERS.has(name.toLowerCase()),
    ),
  ) as http.OutgoingHttpHeaders;
  forwarded.host = hostHeader(destination);
  forwarded.origin = destinationOrigin(destination);
  return forwarded;
}

function responseHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => {
      const field = name.toLowerCase();
      return value != null && !HOP_BY_HOP_HEADERS.has(field) && !WITHHELD_HEADERS.has(field);
    }),
  ) as http.OutgoingHttpHeaders;
}

function relayHttp(
  incoming: IncomingMessage,
  response: ServerResponse,
  destination: { host: string; port: number },
  path: string,
  idleTimeoutMs: number,
) {
  // A screen that never answers, or stops sending partway through, would hold the caller open with
  // a frame that never fills. Any byte from it restarts the wait, so only a stalled one ends.
  let ended = false;
  let reported = false;
  // A caller too slow to take the body pauses the screen, which is not a stall: the wait stands
  // still until the caller drains again, then starts over from there.
  let suspended = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const stopIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  // One failure is one log line: the body failing and the request erroring are the same event.
  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    logFailure(reason);
  };
  /**
   * Ends this caller here. The request's own error is not what answers for a screen that never
   * did: a request this process destroys does not always emit one, so it would leave the caller
   * open with nothing. A caller already reading a body is cut off; one still waiting gets a 502.
   */
  const fail = (reason: string) => {
    if (ended) return;
    ended = true;
    stopIdle();
    upstream.destroy();
    report(reason);
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(incoming.method === "HEAD" ? undefined : "Screen unavailable\n");
  };
  /** The wait restarts from now on every byte from the screen and every drain of the caller. */
  const restartIdle = () => {
    if (ended || suspended) return;
    stopIdle();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      fail("timeout");
    }, idleTimeoutMs);
  };
  const suspendIdle = () => {
    suspended = true;
    stopIdle();
  };
  const resumeIdle = () => {
    suspended = false;
    restartIdle();
  };
  const upstream = http.request(
    {
      host: destination.host,
      port: destination.port,
      method: incoming.method,
      path,
      headers: relayHeaders(incoming.headers, destination),
    },
    (answer) => {
      if (response.destroyed) {
        ended = true;
        stopIdle();
        answer.destroy();
        return;
      }
      response.writeHead(answer.statusCode ?? 502, responseHeaders(answer.headers));
      // A HEAD answer carries no body, and framing it as if it did would hang the caller.
      if (incoming.method === "HEAD") {
        ended = true;
        stopIdle();
        answer.resume();
        response.end();
        return;
      }
      answer.on("data", restartIdle);
      answer.once("end", () => {
        ended = true;
        stopIdle();
      });
      answer.on("pause", suspendIdle);
      response.on("drain", resumeIdle);
      // A screen that dies mid-answer would leave this caller waiting for bytes that never come,
      // so the answer ends here instead: the caller is cut off rather than left with half a page.
      answer.once("error", () => fail("upstream"));
      answer.once("close", () => {
        if (!answer.complete) fail("upstream");
      });
      restartIdle();
      answer.pipe(response);
    },
  );
  upstream.on("error", () => fail("upstream"));
  upstream.once("close", stopIdle);
  // A browser that goes away first takes the computer's request with it, and is nobody's failure.
  response.once("close", () => {
    ended = true;
    stopIdle();
    upstream.destroy();
  });
  restartIdle();
  upstream.end();
}

function relayUpgrade(
  incoming: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  destination: { host: string; port: number },
  path: string,
  handshakeTimeoutMs: number,
) {
  const upstream = net.connect(destination.port, destination.host);
  // A screen that never connects, or never answers the upgrade, would hold the browser's socket
  // open with nothing on it. The deadline is the handshake's alone: once the screen answers, the
  // stream belongs to the browser and no timer runs on it.
  const handshakeTimer = setTimeout(() => {
    logFailure("handshake");
    upstream.destroy();
    socket.destroy();
  }, handshakeTimeoutMs);
  const handshakeDone = () => clearTimeout(handshakeTimer);
  upstream.once("connect", () => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${hostHeader(destination)}`,
      `Origin: ${destinationOrigin(destination)}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
    ];
    for (const name of RELAY_UPGRADE_HEADERS) {
      const value = incoming.headers[name];
      if (value != null) lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    // The screen's first byte is its answer to the upgrade, so the deadline ends there.
    upstream.once("data", handshakeDone);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => {
    logFailure("upstream");
    socket.destroy();
  });
  upstream.once("close", () => {
    handshakeDone();
    socket.destroy();
  });
  socket.once("close", () => {
    handshakeDone();
    upstream.destroy();
  });
}
