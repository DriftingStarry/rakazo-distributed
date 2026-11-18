import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { containerCreateOptions } from "../computer-spec.js";
import {
  assertVolumeSubpathSupport,
  computerHomeMountMatches,
  computerHomeStorage,
  computerNetworkOwnerFor,
  containerHomeMode,
  homeVolumeMatches,
  labelsHomeMode,
  resolveComputerHomeMode,
  resolveProvisionHomePath,
} from "./home.js";

describe("computer home mode", () => {
  it("replaces a computer whose home placement does not match its mode", () => {
    const home = { Type: "bind", Source: "/data/x", Target: "/home/rakazo" };
    const hostConfig = (mounts: unknown[], binds?: string[]) =>
      ({ HostConfig: { Mounts: mounts, Binds: binds } }) as unknown as Pick<
        Docker.ContainerInspectInfo,
        "HostConfig"
      >;
    expect(computerHomeMountMatches(hostConfig([home]), "remote", undefined)).toBe(false);
    expect(
      computerHomeMountMatches(hostConfig([], ["/data/x:/home/rakazo"]), "remote", undefined),
    ).toBe(false);
    expect(computerHomeMountMatches(hostConfig([]), "remote", undefined)).toBe(true);
    // A local computer still compares the home volume it was created with.
    const homeVolume = { name: "appdata", subpath: "homes/x" };
    const volume = {
      Type: "volume",
      Source: homeVolume.name,
      Target: "/home/rakazo",
      VolumeOptions: { Subpath: homeVolume.subpath },
    };
    expect(computerHomeMountMatches(hostConfig([volume]), "local", homeVolume)).toBe(true);
    expect(computerHomeMountMatches(hostConfig([]), "local", homeVolume)).toBe(false);
  });

  it("reads a computer from before the mode label as local", () => {
    const legacy = { Config: { Labels: { "rakazo.managed": "true" } } };
    expect(containerHomeMode(legacy as unknown as Docker.ContainerInspectInfo)).toBe("local");
    expect(labelsHomeMode(undefined)).toBe("local");
    expect(labelsHomeMode({ "rakazo.homeMode": "remote" })).toBe("remote");
  });

  it("opts into remote mode only with an explicit flag", () => {
    expect(resolveComputerHomeMode(undefined)).toBe("local");
    expect(resolveComputerHomeMode("")).toBe("local");
    expect(resolveComputerHomeMode("false")).toBe("local");
    expect(resolveComputerHomeMode(" true ")).toBe("remote");
    expect(() => resolveComputerHomeMode("yes")).toThrow(/must be true or false/);
  });

  it("refuses provisioning that does not match the supervisor's mode", () => {
    expect(resolveProvisionHomePath("local", "/data/homes/bot")).toBe("/data/homes/bot");
    expect(() => resolveProvisionHomePath("local", undefined)).toThrow(/requires its path/);
    expect(resolveProvisionHomePath("remote", undefined)).toBeUndefined();
    expect(() => resolveProvisionHomePath("remote", "/data/homes/bot")).toThrow(
      /takes no home path/,
    );
  });
});

describe("computer home storage", () => {
  const runtime = (mount: object) => ({ Mounts: [mount] }) as Docker.ContainerInspectInfo;
  it("keeps named volumes native and exposes only the bot subdirectory", () => {
    const storage = computerHomeStorage(
      "/data/homes/bot",
      "/data",
      runtime({
        Type: "volume",
        Name: "example_appdata",
        Source: "/var/lib/docker/volumes/example_appdata/_data",
        Destination: "/data",
      }),
    );
    const options = containerCreateOptions({
      name: "bot",
      image: "computer",
      botId: "bot",
      spaceId: "space",
      ...storage,
    });
    expect(options.HostConfig.Binds).toBeUndefined();
    expect(options.HostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: "example_appdata",
        Target: "/home/rakazo",
        VolumeOptions: { NoCopy: true, Subpath: "homes/bot" },
      },
    ]);
    expect(homeVolumeMatches(options.HostConfig.Mounts, storage.homeVolume!)).toBe(true);
    expect(homeVolumeMatches(undefined, storage.homeVolume!)).toBe(false);
    expect(
      homeVolumeMatches(options.HostConfig.Mounts, {
        name: "example_appdata",
        subpath: "homes/other",
      }),
    ).toBe(false);
  });
  it("preserves native host paths and translates supervisor bind mounts", () => {
    expect(computerHomeStorage("/data/homes/bot", "/data", undefined)).toEqual({
      homePath: "/data/homes/bot",
    });
    expect(
      computerHomeStorage(
        "/data/homes/bot",
        "/data",
        runtime({ Type: "bind", Source: "/srv/data", Destination: "/data" }),
      ),
    ).toEqual({ homePath: "/srv/data/homes/bot" });
  });
  it("rejects paths outside the volume and missing volume names", () => {
    for (const home of ["/data", "/other", "/data/../other"])
      expect(() => computerHomeStorage(home, "/data", undefined)).toThrow();
    expect(() =>
      computerHomeStorage(
        "/data/homes/bot",
        "/data",
        runtime({ Type: "volume", Destination: "/data" }),
      ),
    ).toThrow(/no name/);
  });
  it("derives the network owner from where computer homes live, without exposing it", () => {
    const volume = (name: string) =>
      runtime({
        Type: "volume",
        Name: name,
        Source: `/var/lib/docker/volumes/${name}/_data`,
        Destination: "/data",
      });
    const owner = computerNetworkOwnerFor("/data", volume("example_appdata"));
    expect(owner).toMatch(/^[0-9a-f]{32}$/);
    expect(computerNetworkOwnerFor("/data", volume("example_appdata"))).toBe(owner);
    expect(computerNetworkOwnerFor("/data", volume("other_appdata"))).not.toBe(owner);
    const hostRun = computerNetworkOwnerFor("/srv/install-a/data", undefined);
    expect(computerNetworkOwnerFor("/srv/install-b/data", undefined)).not.toBe(hostRun);
    expect(
      computerNetworkOwnerFor(
        "/data",
        runtime({ Type: "bind", Source: "/srv/install-a/data", Destination: "/data" }),
      ),
    ).toBe(hostRun);
  });
  it("fails closed on daemons that could ignore volume subpaths", () => {
    for (const version of ["1.44", "", "invalid", "0.99"])
      expect(() => assertVolumeSubpathSupport(version)).toThrow(/Docker Engine 26/);
    for (const version of ["1.45", "1.46", "2.0"])
      expect(() => assertVolumeSubpathSupport(version)).not.toThrow();
  });
});
