# rusthinq-adapter

Runs [rethink](https://github.com/anszom/rethink)'s LG ThinQ device converters and Home
Assistant bridge against rusthinq's raw wire-frame MQTT bus, instead of rethink's own
TLS/cloud tunnel. rusthinq owns the actual cloud connection and CLIP protocol; this process
only taps/injects the already-decoded bytes over MQTT, so it needs no certificates, no
listening ports, and no knowledge of the tunnel — it can run anywhere that can reach the
same broker, started and stopped independently of rusthinq itself.

This repo owns only two files: [`rusthinq-adapter.ts`](rusthinq-adapter.ts) (entrypoint) and
[`cloud/thinq2/rusthinq_transport.ts`](cloud/thinq2/rusthinq_transport.ts) (how a `Device` is
synthesized from rusthinq's `<raw_prefix>/devices` snapshot and `<raw_prefix>/<id>/raw/rx`
topics — see rusthinq's `raw_bus.rs` / `devlist.rs`). Everything else those two files import
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

Point rusthinq's `config.toml` `[mqtt] raw_prefix` and this project's `rusthinq`
config section at the same broker and prefix; nothing in rusthinq itself needs to
change.

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
