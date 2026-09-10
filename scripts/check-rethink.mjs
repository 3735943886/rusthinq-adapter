#!/usr/bin/env node
// This adapter is a thin shim (rusthinq-adapter.ts + cloud/thinq2/rusthinq_transport.ts) around
// rethink's own LG ThinQ device converters and Home Assistant bridge, which it does not own and
// does not vendor. Instead, the user provides a rethink checkout at ./rethink themselves - a
// plain `git clone` or a `git submodule add`, whichever they prefer - and tsconfig.json's "@/*"
// path alias resolves straight into it. This repo never fetches or copies rethink's code; this
// script only checks that ./rethink is actually there and looks like a real checkout, so a
// missing/wrong directory fails fast with clear instructions instead of a raw "cannot find
// module '@/...'" from tsc.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const rethinkDir = join(root, 'rethink')

// A couple of paths this adapter's own files import via "@/*" - enough to catch an empty/wrong
// directory without hardcoding rethink's full file list (that list changes as rethink evolves,
// and this check isn't the thing that should go stale when it does).
const MARKERS = ['cloud/devmgr.ts', 'cloud/ha_bridge.ts', 'util/logging.ts']

const missing = MARKERS.filter((rel) => !existsSync(join(rethinkDir, rel)))
if (!existsSync(rethinkDir) || missing.length === MARKERS.length) {
    console.error(`
[check-rethink] ./rethink is missing - this adapter needs a rethink checkout there to run.

Bring one in yourself, either as a plain clone:

    git clone https://github.com/anszom/rethink ./rethink

or as a submodule, if you'd rather pin a reviewable commit:

    git submodule add https://github.com/anszom/rethink rethink
    git submodule update --init

Point at a fork instead of upstream by using its URL in either command above.
`)
    process.exit(1)
}
if (missing.length > 0) {
    console.warn(
        `[check-rethink] ./rethink is present but missing expected path(s): ${missing.join(', ')} - ` +
            `is it the right checkout/branch? Continuing; a real problem will surface as a build error.`,
    )
}
