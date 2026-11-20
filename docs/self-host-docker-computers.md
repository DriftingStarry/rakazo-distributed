# Docker computers

Limit what each local Docker computer can use, keep it off your network, and share host folders
with it.

The Docker supervisor is not published as its own image. In this stack it runs from the app image and
is never exposed: it stays on the internal Compose network and holds the Docker socket because
access to it is equivalent to control of the Docker host. Docker sandboxes require
`SANDBOX_SUPERVISOR_TOKEN` (API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen
capabilities (API and web proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

The one exception is below: a supervisor serving another host publishes one port, on a private
address that only the app host reaches.

A deployment can also keep the supervisor on a separate Docker host with
[`SANDBOX_PROVIDER=remote-docker`](#supervisor-on-another-host).

## Supervisor on another host

The API, worker and web app can run on one host while the supervisor and its bot computers run on
another Docker host (`SANDBOX_PROVIDER=remote-docker`).
[`docker-compose.supervisor.yml`](../infra/compose/docker-compose.supervisor.yml) starts that
supervisor from the app image, with a computer image of the same commit and the same hardening the
production stack applies.

The supervisor host holds the Docker socket, which is root-equivalent there, and every bot
computer that deployment runs. Use a host dedicated to it, not a machine that also runs the app
database or unrelated containers.

### On the supervisor host

The host needs Linux with Docker Engine 26 or newer and the Compose plugin. Where Docker Engine runs
in a Linux VM (Docker Desktop, OrbStack), the egress rules below belong in that VM; see
[Docker in a Linux VM](#docker-in-a-linux-vm).

1. Install the restricted-egress host rules once, from this checkout. Computers refuse to start
   until this check passes, and the firewall returns after a reboot.

   ```bash
   sudo bash infra/compose/restrict-computer-egress.sh
   ```

   Where the rules cannot be installed, set `SANDBOX_COMPUTER_EGRESS=open` in the host's `.env`
   only when that network access is intended and the host is isolated; the
   [restricted computer egress](#restricted-computer-egress) section covers what it allows.

2. Create this host's environment file from the tracked example. Every command below runs from the
   root of this checkout, so the stack is the one these docs describe:

   ```bash
   cp infra/compose/.env.supervisor.example infra/compose/.env
   ```

3. Generate the shared token privately, for example with `openssl rand -hex 32`, and put the same
   value in this host's `.env` and in the app host's `.env`. It is the only secret the two hosts
   share: never reuse `BETTER_AUTH_SECRET`, `SCREEN_PROXY_SECRET` or a provider key, and do not
   paste it into a shell history, ticket or chat. Keep both `.env` files readable only by their
   owner and the Compose process.

4. Build both images from this checkout, then set the bind address, the shared token and the tags
   in `infra/compose/.env`:

   ```bash
   docker build -f infra/compose/Dockerfile -t ghcr.io/elie222/rakazo/app:local .
   docker build -t rakazo/computer:local infra/sandboxes/computer
   ```

   ```env
   SANDBOX_SUPERVISOR_BIND=10.0.0.5
   SANDBOX_SUPERVISOR_TOKEN=<the shared token>
   RAKAZO_IMAGE_TAG=local
   RAKAZO_COMPUTER_IMAGE=rakazo/computer
   RAKAZO_COMPUTER_IMAGE_TAG=local
   ```

   `SANDBOX_SUPERVISOR_BIND` has no default; Compose refuses to start without it. Never use
   `0.0.0.0` or a public address: that publishes a root-equivalent API to the internet. Loopback
   (`127.0.0.1`) is only for a smoke test on the host itself, or behind a local TLS tunnel.

   The two sides speak one supervisor contract, so both hosts run the app image from the same
   commit. The app host builds the same commit too, or loads the image built here with `docker save`
   and `docker load`. The computer image only runs on this host, but it comes from that commit as
   well: older and newer images are not tested together.

   No release carries this topology yet, which is why the steps above build instead of pull. Once
   one does, its published `rakazo/app` and `rakazo/computer` tags replace the build: set
   `RAKAZO_IMAGE_TAG` and `RAKAZO_COMPUTER_IMAGE_TAG` to that release, leave
   `RAKAZO_COMPUTER_IMAGE` empty, and take the stack file and example environment from its tag.

5. Start it and check it:

   ```bash
   docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.supervisor.yml up -d
   docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.supervisor.yml ps
   curl -fsS http://10.0.0.5:7091/health
   ```

   `/health` needs no token and answers `{"ok":true,...}`. A refused connection is the bind
   address, a firewall rule or the container not running; `docker compose ... logs supervisor`
   names a missing egress ruleset at startup and each rejected token as it arrives.

   To move the images, set the new tags in `infra/compose/.env`, then
   `docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.supervisor.yml pull`
   followed by `up -d`; Compose only pulls a missing image otherwise. The recreated supervisor adopts
   the computers that are already running, and a computer is rebuilt from its last saved workspace
   when it next starts on a changed image. Keep the app host's `RAKAZO_IMAGE_TAG` in step with this
   host.

The stack publishes exactly one port, `7091`, and mounts only the Docker socket. Keep the host
firewall closed except for that port from the app host's addresses: the API, worker and web server
containers all call it, the web server to fetch relayed screens.

A private network and an encrypted one are not the same thing. A cloud VPC, a private subnet or a
host firewall keeps the port off the internet but leaves its bytes readable to anything that can
watch that network, and screens and service calls carry credentials. Only an encrypted link — TLS
in front of the port, WireGuard, or a tailnet that encrypts transport — protects them. Where the two
hosts are not already on one, put TLS in front of the supervisor and keep the TLS certificate's name
in `SANDBOX_SUPERVISOR_URL`. Plain HTTP is only acceptable where the network is both private and
trusted by everyone on it.

### On the app host

Run the production base stack alone, without
[`docker-compose.prod.docker.yml`](../infra/compose/docker-compose.prod.docker.yml): that overlay is
for local Docker computers and hardcodes the in-stack supervisor address. If the deployment layered
it before, remove it from every Compose invocation and from `RAKAZO_COMPOSE_FILE` for the updater;
otherwise a local supervisor keeps starting and the API keeps calling it. Set the provider and the
supervisor origin in `.env` and recreate the containers that read them:

```env
SANDBOX_PROVIDER=remote-docker
SANDBOX_SUPERVISOR_URL=https://sandbox.example.com
SANDBOX_SUPERVISOR_TOKEN=<the same shared token>
RAKAZO_IMAGE_TAG=local
```

The token is the only secret the two hosts share. Never reuse `BETTER_AUTH_SECRET`,
`SCREEN_PROXY_SECRET` or a provider key for it, keep it out of shell history, tickets and chat, and
keep this `.env` readable only by its owner and the Compose process.

The app host runs the app image from the same commit as the supervisor, not a release tag. Build it
here from this checkout, or load the image built on the supervisor host with `docker save` and
`docker load`, before starting the stack:

```bash
docker build -f infra/compose/Dockerfile -t ghcr.io/elie222/rakazo/app:local .
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d
```

Settings for the computers themselves — the `RAKAZO_COMPUTER_*` ceilings and image tags, egress and
DNS, mounts and GPUs — are read by the supervisor host's Compose file, so they belong in its
`infra/compose/.env`. This host's `.env` names only the provider, the origin, the token and its own
app image tag.

`SANDBOX_SUPERVISOR_URL` is an origin only: `https://sandbox.example.com`, not a path or a URL with
credentials or a query. Plain HTTP is only for what the screen proxy accepts: a loopback or private
IP literal above port 1023 (`http://10.0.0.5:7091`), not a DNS name. Provisioning and command
execution still work over a private DNS name, but live screens and terminals fail closed, so use
HTTPS or an IP literal there. Then confirm the deployment actually uses it:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:3100/internal/health').then(r=>r.json()).then(b=>console.log(b.sandbox))"
```

That prints `remote-docker`. `none` means the origin was missing, or in production the token was
missing. A token the supervisor rejects still prints `remote-docker`: the provider loads and every
call then gets a 401, which the supervisor log shows, so start a computer to prove the token works.
The published computer image is never pulled on the app host for this topology, so no Docker socket
or computer container is needed there.

### Data, backups and moving

- A remote computer keeps its home in its own container on the supervisor host, not in the app's
  `DATA_DIR`. Stopping and starting it keeps that home. A computer that has to be replaced (a
  changed image, a lost container, a Docker prune) is rebuilt and then restores the last saved
  workspace, so the checkpoint is the copy that survives losing the container.
- The durable data stays on the app host: the database, uploads, and saved checkpoints under
  `DATA_DIR` or object storage. Keep the existing [backup routine](./self-host-backups.md) there.
  The supervisor host holds no app data to back up; its computers' homes are rebuilt from the
  app's checkpoints.
- Nothing migrates automatically between hosts or providers. Switching a deployment from its
  in-stack supervisor (`docker`) to `remote-docker`, or moving the supervisor host, starts new
  computers: each bot resumes from its last saved workspace and loses whatever was not saved.
  Take a checkpoint before switching, and keep the old host's data until the new computers look
  right. Each computer records whether its home is in its container or on a server path, so an
  in-stack supervisor and a remote one sharing a Docker host never adopt or remove each other's
  computers, even when their names collide. Do not put two remote supervisors on one host: give
  each deployment its own.

### Checks

- Supervisor host:
  `docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.supervisor.yml ps`
  and the `/health` call above. The container healthcheck uses the same endpoint, so a healthy
  service is available on the published port.
- App host: `/internal/health` reports `sandbox: "remote-docker"`, shown above.
- From the app host, `curl -fsS https://sandbox.example.com/health` proves the route, TLS
  certificate and firewall rule the API, worker and web containers depend on.
- `docker compose ... logs supervisor` on the supervisor host is where a rejected token, a missing
  egress ruleset or a failed computer image pull appears.

## Resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable                     | Default | Accepts                                                                                              |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `RAKAZO_COMPUTER_MEMORY`     | `2g`    | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `RAKAZO_COMPUTER_CPUS`       | `2`     | Whole or fractional cores, e.g. `1.5`                                                                |
| `RAKAZO_COMPUTER_PIDS_LIMIT` | `2048`  | A positive integer                                                                                   |

Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

Two caps bound how many computers exist. `SANDBOX_MAX_COMPUTERS_PER_USER` caps the computers one
user's bots may have, and `SANDBOX_MAX_COMPUTERS_PER_SPACE` caps concurrent computer containers per
Space. `SANDBOX_TEAM_SCREEN_LIMIT` caps active bot desktops on one Team Computer; desktops and
browsers otherwise start only when needed. `0`, the default, leaves each to the machine.

The supervisor reaches Docker at `/var/run/docker.sock` (or `//./pipe/docker_engine` on Windows). Set
`DOCKER_SOCKET` for rootless Docker, Colima or another path; `DOCKER_HOST` wins when both are set.

## Restricted computer egress

On a cloud VM, explicitly choose `SANDBOX_COMPUTER_EGRESS=restricted` after installing
the host rules. This refuses to start computers if enforcement is missing. The default
`auto` preserves compatibility on hosts without those rules and can allow access to
cloud metadata and internal networks. Restricted egress also blocks intentional access
to local models, private repositories and other LAN services. Choose `open` only when
that network access is intended and the host is appropriately isolated.

Restricted egress gives Docker computers the public internet (browsing, DNS, apt, git
over SSH) but not the Docker host, the LAN, or link-local cloud metadata such as
`169.254.169.254`, which on a cloud VM would hand instance credentials to anything a bot runs.

It takes two parts:

1. `SANDBOX_COMPUTER_EGRESS=restricted` gives each computer network a deterministic host
   bridge name (`rakazo-c…`) instead of a generic `br-*`.
2. The host ruleset, applied once per Docker host:

   ```bash
   sudo bash infra/compose/restrict-computer-egress.sh
   ```

   `install-images.sh` downloads and runs it (asking for sudo) and records the result in
   `.env`. Where the rules cannot be installed (macOS, Windows, Docker Desktop, rootless
   Docker, no iptables, or a failed run) it writes `SANDBOX_COMPUTER_EGRESS=open` and says
   why. The script drops forwarded traffic from `rakazo-c*` bridges to all non-public IPv4/IPv6
   destinations via the `DOCKER-USER` chain, adds an `INPUT` drop so computers cannot open
   connections to the host (established replies to host-initiated control and screen
   connections still flow), and installs a systemd oneshot so the rules return after a
   reboot. `--print` shows the exact rules without changing anything; `--remove` uninstalls.

Before the first restricted computer starts, the supervisor checks that the host drops
connections from a `rakazo-c*` bridge. Without the ruleset, computers fail to start with an
error naming the script instead of running unrestricted; run the script (no restart needed)
or set `SANDBOX_COMPUTER_EGRESS=open` and recreate the supervisor.

When `SANDBOX_COMPUTER_EGRESS` is unset, the Compose files use `auto`: the supervisor runs the
same check and uses restricted egress if the ruleset is in place, otherwise open egress with a
warning in its log. It keeps the first completed answer; a check that could not finish (a Docker
error or timeout) fails that computer's start and runs again on the next one. With the ruleset
in place, so does a configured `SANDBOX_COMPUTER_DNS` that no server answers (see below). An
install from before the ruleset existed therefore keeps working when it upgrades. After
installing the ruleset, recreate the supervisor, or set `restricted` to refuse computers
whenever the rules are missing. A host-run supervisor (`pnpm dev`) and the desktop app's
**This computer** stack default to open: Docker Desktop keeps its bridges in a VM the host
rules cannot reach.

Screen streaming is unaffected: the supervisor and web proxy join each computer's bridge,
and the ruleset exempts traffic whose in- and out-interface are both `rakazo-c*` before
any drop (that exemption is load-bearing on hosts where `br_netfilter` feeds bridged
frames through `FORWARD`). Rules match interface names rather than subnets, so computer
create/delete cycles need no firewall maintenance; deleting a computer removes its
traffic from the match and nothing else. A computer provisioned while egress was open
is replaced on its next provision — resuming it on an unnamed bridge would bypass the
restriction.

Computers resolve names through Docker's embedded DNS. Docker 28 and newer forward lookups
to the host's own resolvers from the host's network, so a private host resolver (a cloud VPC
resolver, a LAN router) keeps working. Older Docker versions forward from the computer's
network, and so does any server set in `SANDBOX_COMPUTER_DNS` or the daemon's `dns` option;
the ruleset drops those lookups when the resolver has a private address, and every lookup
times out while connections by IP still work. In those cases set `SANDBOX_COMPUTER_DNS` to
public resolvers (comma-separated IP addresses, such as `1.1.1.1,1.0.0.1`) and recreate the
supervisor; each computer picks the servers up on its next provision. When
`SANDBOX_COMPUTER_DNS` is set, computers with restricted or `auto` egress start only after one
of its first three servers (Docker uses no more) answers from a computer network; a start that
fails this check retries it on the next start. The check runs from an IPv4-only network and
skips IPv6 servers, so if those three are all IPv6 nothing is checked.

### Opening egress

If computers must reach LAN services, an internal proxy, or endpoints bound to the host,
set `SANDBOX_COMPUTER_EGRESS=open`, recreate the supervisor, and run
`sudo bash infra/compose/restrict-computer-egress.sh --remove`. The flag alone does not
uninstall the host rules, which keep matching the still-named `rakazo-c*` bridges until
removed.

The ruleset requires Linux Docker Engine with the iptables backend; Docker Desktop, rootless
Docker, and `firewall-backend: nftables` are unsupported. The
`SANDBOX_SCREEN_NETWORK=internal` topology shares one network instead of per-bot bridges,
so the mode does not apply there.

### Docker in a Linux VM

Where Docker Engine runs in a Linux VM, as with OrbStack on macOS, the rules belong in the VM,
which `sudo` on the host cannot reach. Apply them from a container on the VM's host network
instead, and keep it running: the VM does not persist the rules, so a loop puts them back after
a restart. The installer does not download the script on macOS. From the directory that holds
the stack's `.env`:

```bash
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/restrict-computer-egress.sh
```

Save the following as `egress.yml` beside that script and start it with
`docker compose -f egress.yml up -d`. The name keeps it in its own Compose project:

```yaml
name: rakazo-computer-egress
services:
  computer-egress:
    image: alpine:3
    network_mode: host
    cap_add: [NET_ADMIN, NET_RAW]
    restart: unless-stopped
    volumes:
      - ./restrict-computer-egress.sh:/restrict-computer-egress.sh:ro
    command: >-
      sh -c "apk add --no-cache bash iptables ip6tables &&
      while true; do bash /restrict-computer-egress.sh --apply; sleep 60; done"
```

Then change `SANDBOX_COMPUTER_EGRESS` from `open` to `restricted` in `.env` and recreate the
supervisor. Docker Desktop has not been tested this way.

## IPv6 for computers

Computer networks are created with IPv6 in open egress mode (Docker Engine 27+): Docker
allocates a private ULA /64 per network and masquerades outbound traffic through the host's
IPv6 address, so computers reach IPv6-only sites, while names with both address families
stay on IPv4 (RFC 6724 address selection with a ULA source). Restricted egress stays
IPv4-only: the host ruleset and the startup check enforce and verify IPv4 only. An existing
computer picks IPv6 up when its network is created again: a stop releases the network, and
the next start creates a new one. Docker 26, Docker-in-Docker without `ip6_tables` and
hosts with IPv6 disabled fall back to IPv4-only networks; the supervisor logs a warning and
computers start unchanged. A computer can also stay on IPv4 for longer when its IPv4-only
network could not be removed (another user keeps it); IPv4 keeps working, and IPv6 returns
once that network is gone — for example after `docker network rm` of the computer's
`rakazo-computer-*` network while it is stopped.

## Shared host folders

`SANDBOX_COMPUTER_MOUNTS` mounts host directories into every bot computer (Docker sandboxes
only): comma-separated `source:target[:option...]` entries, for example
`/srv/team-docs:/mnt/team-docs`. Mounts are read-only unless the entry adds `rw`; `rslave` is the
other option and requires `rw`, because mounts that reach the computer later keep their own
write access. Both paths must be absolute without `..`, and targets must sit below `/mnt`,
`/media` or `/srv`. On Docker Desktop for Windows, write a source in its WSL form
(`/mnt/c/Users/me/Docs` for `C:\Users\me\Docs`); Docker rejects the Windows form, and `rslave`
does not work on these folders.

The setting is deployment-wide: every bot in every Space sees every mount, and with `rw` any of
them can change or delete what another Space's bots read. Mount only what all of them may see.
The supervisor rejects a source that is, holds, or sits inside the Docker socket,
`/run`, `/var/run`, `/proc`, `/sys`, `/dev`, `/etc`, `/boot`, `/root`, `/var/lib/docker` or
the data directory that holds bot homes. It compares the configured path, and Docker follows
host symlinks, so never point a source at one of these through a symlink.

When the source holds a mount that can be replaced while computers run,
such as an SSHFS or NFS share that reconnects, mount the share one level below the source
(`/srv/shares/docs`, with `source` `/srv/shares`) and add `rw:rslave`, so the new mount reaches
running computers instead of leaving them on the dead one. Mounting the share at the source
itself does not work: replacing it leaves running computers on the old one.

`rslave` also needs the source to sit on a shared or slave host mount. Check with
`findmnt -no PROPAGATION -T <source>`; systemd hosts report `shared` for most paths. If it reports
`private`, Docker refuses to create the computer, so make the source its own shared mount first
(`sudo mount --rbind <source> <source>` then `sudo mount --make-rshared <source>`; `--rbind`
keeps a share already mounted below the source visible. Repeat it at boot, before the share
mounts, for example from a systemd mount unit the share's unit depends on). The source must
exist on the Docker host. Recreate the supervisor after a change; each computer picks the new
set up on its next provision, which replaces it.

## GPUs for programs

`SANDBOX_COMPUTER_COMPUTE_GPUS` lets programs inside every bot computer compute on the host's
GPUs (Docker sandboxes only): `all`, or a count such as `1`, with the same meaning as
`docker run --gpus`. A bot can then run GPU software in its own computer, such as speech
recognition, image generation or model training. Leave it unset and computers get no GPU.

The Docker host needs a GPU driver that Docker can hand to containers, which for most GPUs
means installing the vendor's container toolkit and checking that
`docker run --rm --gpus all <image> <the vendor's status tool>` works. The supervisor asks Docker
for GPUs without naming a driver, so any driver Docker offers for `--gpus` is used. The computer
image ships no GPU libraries of its own: the driver adds its own at start, and a bot installs
the frameworks it needs in its home. When the host cannot provide the GPUs, Docker refuses to
create the computer and the bot's computer fails to start until the setting or the host is fixed.

Changing the setting replaces each computer the next time it starts; the home is kept. It does
not change the browser, which keeps rendering pages in software.

WARNING: the setting is deployment-wide, and a GPU is shared hardware. Every bot in every Space
reaches the host's GPU driver directly, which is a larger attack surface than the rest of the
sandbox, and nothing limits how much GPU memory or time one computer takes from the others or
from other GPU software on the host. Enable it only when you trust every bot on the deployment
with that.

## Browser proxy

Some public sites refuse connections from datacenter addresses. With
`SANDBOX_COMPUTER_BROWSER_PROXY_PAC_URL` the bot browser sends selected sites through an HTTP
proxy you run, and every other site connects directly as before (Docker sandboxes only). The
value is a [proxy auto-config](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Proxy_servers_and_tunneling/Proxy_Auto-Configuration_PAC_file)
(PAC) script: an absolute `http://` or `https://` URL the browser downloads it from, or the whole
script as a base64 `data:` URL of at most 64 KiB, for example:

```sh
pac='function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, ".example.com")) return "PROXY proxy.example.net:3128";
  return "DIRECT";
}'
echo "SANDBOX_COMPUTER_BROWSER_PROXY_PAC_URL=data:application/x-ns-proxy-autoconfig;base64,$(printf '%s' "$pac" | base64 | tr -d '\n')"
```

The supervisor refuses to start with any other kind of value, or one containing spaces. It hands
the value to every computer, whose browser starts with `--proxy-pac-url`; page reading and the
bot's browser actions use that same browser, so they follow the script too. Programs the bot
runs in its terminal do not. Unset, nothing changes.

Under restricted egress the computer reaches only public addresses, so the PAC URL and the
proxy must be on public addresses as well; a proxy on the Docker host or the LAN is blocked.
Recreate the supervisor after a change; each computer picks it up on its next start, which
replaces it. The home and saved browser profiles are kept.

## Time zone and language

Each computer runs in its owner's time zone and app language when the account has them: the
supervisor sets `TZ` and `LANGUAGE` on the container, and the browser offers pages that language
(`Accept-Language` and `navigator.languages`), also for a browser profile saved earlier. Without
them, the computer stays on UTC and the browser's default language. A changed time zone or
language replaces the computer on its next start, so after upgrading, each computer whose owner
has either set is replaced once. The home and saved browser profiles are kept. A custom computer
image should not set `TZ` or `LANGUAGE`: the computer gets them from the account.
