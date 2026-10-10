# rusthinq-adapter

Runs [rethink](https://github.com/anszom/rethink)'s LG ThinQ device converters and Home
Assistant bridge against rusthinq 0.1's raw MQTT bus or 0.2's management API, instead of rethink's own
TLS/cloud tunnel. rusthinq owns the actual cloud connection and CLIP protocol; this process
only receives decoded frames and sends commands over MQTT or the management API. It
needs no device certificates or listening ports and runs independently of rusthinq.

The adapter entrypoint and transport implementations are owned here: [`rusthinq-adapter.ts`](rusthinq-adapter.ts) (entrypoint) and
[`cloud/thinq2/rusthinq_transport.ts`](cloud/thinq2/rusthinq_transport.ts) (how a `Device` is
synthesized from rusthinq's `<rusthinq_prefix>/devices` snapshot and `<raw_prefix>/<id>/raw/rx`
topics — see rusthinq's `raw_bus.rs` / `devlist.rs`). The new `cloud/thinq2/management_transport.ts` implements the 0.2 API transport.
Everything else these files import
— the per-device-model converters, the Home Assistant bridge, and supporting utility code —
belongs to rethink and is **not fetched or vendored by this repo**. You bring your own rethink
checkout to `./rethink`, and `tsconfig.json`'s `@/*` path alias resolves straight into it.

Because it only imports the same paths rethink's own code imports internally, this adapter
works against upstream `rethink` or any fork/branch — whatever `./rethink` happens to be.

## Setup

Put a rethink checkout at `./rethink` yourself, either as a plain clone:

```sh
git clone https://github.com/anszom/rethink ./rethink
```

or as a submodule, if you'd rather pin a reviewable commit:

```sh
git submodule add -f https://github.com/anszom/rethink rethink
git submodule update --init
```

(Point either command at a fork's URL instead if you're carrying a fix not yet upstream.)
`./rethink` is gitignored by this repo either way — nothing owned lives inside it. `-f` is
required for the submodule case specifically because git refuses to add anything at a
gitignored path without it, submodules included; it's expected here, not a sign of a
misconfigured ignore.

Keeping it fresh is entirely up to you: `git -C rethink pull` for a plain clone, or
`git submodule update --remote` for a submodule. This repo does not check rethink's version or
fetch anything on its own — `npm install`/`npm run dev`/`npm run build`/`npm test` only check
that `./rethink` _exists and looks like a rethink checkout_, failing fast with setup
instructions if it's missing. A `./rethink` that's present but too old/new for what these two
files import will surface as a normal TypeScript "cannot find module" or missing-export error,
the same way any other broken import would.

## Running

```sh
npm install
cp rusthinq-adapter-config.jsonc config.jsonc   # edit mqtt/rusthinq/homeassistant settings
npm run dev -- config.jsonc
```

### rusthinq 0.1 (existing MQTT transport)

Existing configurations remain valid: omitting `transport` selects MQTT. You can also
set `"transport": "mqtt"` explicitly.

Point rusthinq's `config.toml` `[mqtt] raw_prefix` and this project's `rusthinq`
config section at the same broker and prefix, and list the raw streams this adapter
uses in rusthinq's `[mqtt] raw` (rusthinq turns every raw stream off unless listed):

```toml
[mqtt]
raw_prefix = "rusthinq-raw"
raw = ["rx", "inject", "inject_clip"]
```

| stream | topic | used for |
|---|---|---|
| `rx` | `<raw_prefix>/<id>/raw/rx` | frames from the appliance |
| `inject` | `<raw_prefix>/<id>/raw/inject/set` | commands to the appliance |
| `inject_clip` | `<raw_prefix>/<id>/raw/inject/clip/set` | the one-off `setMaskingInfo` CLIP command |

Without `inject_clip` the converters still work, but only see values as often as they poll.
Needs a rusthinq build whose raw topics are laid out this way (`raw/inject/clip/set`; older
builds had `raw/inject-clip/set`).

### rusthinq 0.2 (management API transport)

Replace the `rusthinq` block in your adapter config with:

```json
"rusthinq": {
  "transport": "management",
  "api_url": "http://127.0.0.1:8080/",
  "user": "adapter",
  "password": "your-password",
  "skip_ids": []
}
```

Use the daemon's actual management address. Omit both `user` and `password` if
management authentication is disabled; otherwise supply both. HTTP requests and
WebSocket upgrades use HTTP Basic authentication. HTTPS URLs use WSS for events;
a reverse proxy must allow WebSocket upgrades. `api_url` can include a proxy base
path and must not contain credentials, a query or a fragment.

This requires the 0.2 management endpoints `GET /api/devices`, WebSocket
`/api/events`, and `POST /api/devices/{id}/packet` and `/clip`. Packet requests carry
`incarnation`, `generation`, and `hex`; CLIP requests carry the two scope fields
plus `cmd`, `type`, and `data`. The daemon generates the CLIP message ID.
No Rhai driver, external MQTT connection to rusthinq, or raw-injection toggle is
required. Home Assistant still uses its separately configured MQTT connection.

Only online ThinQ2 devices with a known modelId are attached. The API transport
recreates converters after session/model changes, reconnects, or event loss so
startup queries refresh their cached values. A lost connection closes all attached
devices immediately; reconnection is attempted every two seconds. Commands are serialized per device with a bounded queue (128 pending commands). Unknown or failed
command delivery is logged and never automatically retried. `Sent` means transport
write completion, not appliance acknowledgement or confirmed state change.

Use `skip_ids` to leave devices to other consumers. For devices this adapter drives,
do not also install an active appliance Rhai driver: both can send commands.
There is no automatic fallback between management and MQTT transports. ThinQ1
support is outside this adapter's current scope.

### Running 24/7

This is meant to run as a long-lived daemon, restarted by whatever supervises it (systemd, pm2,
...). Launch it via `npm run serve` rather than `npm run dev` directly:

```sh
npm run serve -- config.jsonc
```

`npm run dev`'s `./rethink` check only runs via npm's `predev` hook, so it's skipped whenever a
supervisor restarts the process directly instead of going through `npm run dev` itself. `serve`
(via [`scripts/run.mjs`](scripts/run.mjs)) re-checks `./rethink` on every boot regardless of how
it's launched, so a missing/misconfigured checkout is a clear startup error instead of a raw
module-resolution crash.

`npm run build` + `npm run start` (a compiled `dist/`) is also available, but it compiles
against whatever `./rethink` contains at build time — updating `./rethink` afterwards means
rebuilding, not just restarting.

### Running under Docker

`./rethink` has to exist _before_ `docker build` runs — it's part of the build context, cloned
or submoduled on the host exactly as in [Setup](#setup):

```sh
docker build -t rusthinq-adapter .
docker run -d --name rusthinq-adapter \
  --restart unless-stopped \
  -v rusthinq-adapter-data:/app/data \
  rusthinq-adapter
```

The image seeds `/app/data/config.jsonc` from `rusthinq-adapter-config.jsonc` on first boot —
edit that file inside the `rusthinq-adapter-data` volume (or bind-mount your own over it) with
your mqtt/rusthinq/homeassistant settings, then restart the container. It also stores the
`bridge`/`homeassistant` `storage_path` state under `/app/data` when configured relative to the
config file, so the same volume covers both. The container opens no inbound ports — it only
connects out to your MQTT broker — so nothing needs `EXPOSE`d or published.

Rebuilding the image is the only way to pick up an updated `./rethink` (same as `npm run
build`/`npm start` locally) — a plain restart of the running container does not re-sync it.

## Testing

```sh
npm test
```

The optional `bridge.storage_path` reservation relay store is supported when the
provided rethink checkout includes `bridge/reservation-store.ts`. Upstream checkouts
without it log that this setting is unavailable and run without that store.
Home Assistant `storage_path` likewise depends on the chosen rethink checkout.
Device delivery ACKs remain rusthinq's responsibility; converter `send_ack` calls
are suppressed in both transports to avoid duplicate ACKs.
