/**
 * Where a computer's home lives and which volume or host path backs it: the mode a supervisor
 * serves, the request it accepts, and the mount a container must carry for it.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type Docker from "dockerode";

/**
 * Where this supervisor keeps a computer's home: on the server's data directory (local, the
 * default), or inside the container's own writable layer (remote) for a supervisor another
 * deployment runs, which never sees the server's filesystem.
 */
export type ComputerHomeMode = "local" | "remote";

/** Label naming the mode. A computer created before the label reads as local, the only mode then. */
export const COMPUTER_HOME_MODE_LABEL = "rakazo.homeMode";

/**
 * `SANDBOX_SUPERVISOR_REMOTE=true` opts this supervisor into serving a deployment elsewhere, so
 * it refuses anything it can only do with the server's home: no bind mount, no volume subpath.
 */
export function resolveComputerHomeMode(
  value = process.env.SANDBOX_SUPERVISOR_REMOTE,
): ComputerHomeMode {
  const configured = value?.trim().toLowerCase();
  if (!configured || configured === "false") return "local";
  if (configured === "true") return "remote";
  throw new Error("SANDBOX_SUPERVISOR_REMOTE must be true or false");
}

export function containerHomeMode(
  info: Pick<Docker.ContainerInspectInfo, "Config">,
): ComputerHomeMode {
  return labelsHomeMode(info.Config.Labels);
}

/** The same answer for a container's labels alone, as a list entry carries them. */
export function labelsHomeMode(labels: Record<string, string> | undefined): ComputerHomeMode {
  return labels?.[COMPUTER_HOME_MODE_LABEL] === "remote" ? "remote" : "local";
}

/**
 * The home path a provision request carries, or none for a remote computer. A local supervisor
 * mounts it into the container and cannot work without it; a remote one keeps the home in the
 * container and refuses a path it would silently ignore.
 */
export function resolveProvisionHomePath(
  mode: ComputerHomeMode,
  homePath: string | undefined,
): string | undefined {
  if (mode === "remote") {
    if (homePath !== undefined) {
      throw new Error(
        "A remote supervisor keeps computer homes in the container and takes no home path",
      );
    }
    return undefined;
  }
  if (!homePath)
    throw new Error("A local supervisor mounts the server's home and requires its path");
  return homePath;
}

/**
 * Owner label for this install's computer networks, which can share a Docker host
 * with other installs that name theirs the same way. It is derived from where the
 * computer homes live (see computerHomeStorage) and hashed to keep host paths out.
 */
export function computerNetworkOwnerFor(
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
) {
  const mount = info?.Mounts.find((entry) => entry.Destination === dataDir);
  const root =
    mount?.Type === "volume" ? `volume:${mount.Name}` : `path:${mount?.Source ?? dataDir}`;
  return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

export function computerHomeStorage(
  serviceHomePath: string,
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
): { homePath: string; homeVolume?: { name: string; subpath: string } } {
  const relative = path.relative(dataDir, serviceHomePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("computer home must be inside the data directory");
  }
  const mount = info?.Mounts.find((entry) => entry.Destination === dataDir);
  if (mount?.Type === "volume") {
    if (!mount.Name) throw new Error("computer data volume has no name");
    return { homePath: serviceHomePath, homeVolume: { name: mount.Name, subpath: relative } };
  }
  return { homePath: mount?.Source ? path.join(mount.Source, relative) : serviceHomePath };
}

export function assertVolumeSubpathSupport(apiVersion: string) {
  const match = /^(\d+)\.(\d+)$/.exec(apiVersion);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 45)) {
    throw new Error("Docker Engine 26+ (API 1.45+) is required for bot home volume subpaths");
  }
}

export function homeVolumeMatches(
  mounts: Docker.ContainerInspectInfo["HostConfig"]["Mounts"],
  volume: { name: string; subpath: string },
) {
  return (
    mounts?.some(
      (mount) =>
        mount.Target === "/home/rakazo" &&
        mount.Type === "volume" &&
        mount.Source === volume.name &&
        mount.VolumeOptions?.Subpath === volume.subpath &&
        !mount.ReadOnly,
    ) ?? false
  );
}

/**
 * Whether a computer carries the home placement its mode requires. A local one compares the home
 * volume it was created with; a remote one was created with no /home/rakazo mount at all, so its
 * home is the container's own writable layer.
 */
export function computerHomeMountMatches(
  info: Pick<Docker.ContainerInspectInfo, "HostConfig">,
  mode: ComputerHomeMode,
  homeVolume: { name: string; subpath: string } | undefined,
) {
  if (mode === "remote") {
    const mountedAtHome =
      (info.HostConfig.Mounts ?? []).some((mount) => mount.Target === "/home/rakazo") ||
      (info.HostConfig.Binds ?? []).some((bind) => /:\/home\/rakazo(?::|$)/.test(bind));
    return !mountedAtHome;
  }
  return !homeVolume || homeVolumeMatches(info.HostConfig.Mounts, homeVolume);
}
