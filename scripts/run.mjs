#!/usr/bin/env node
// Boot wrapper for running rusthinq-adapter.ts as a long-lived daemon under a supervisor
// (systemd, pm2, ...) that restarts the process directly - not via `npm run dev`, whose predev
// hook is the only thing that currently checks for ./rethink, and only fires for that exact npm
// invocation.
//
// rusthinq-adapter.ts can't do this check itself: it statically imports ./cloud/thinq2/rusthinq_transport.ts,
// which statically imports rethink's util/logging via the "@/*" alias - and ES module imports
// resolve before any of an entrypoint's own top-level code runs, check included. So the check has
// to live in a file that itself imports nothing from ./rethink, ahead of a dynamic import() of the
// real entrypoint (dynamic imports resolve lazily, at the point they're evaluated).
//
// Unlike the old vendoring setup, there's nothing to fetch here - just a local existence check -
// so a failure is fatal (there's no "fall back to what's on disk" to fall back to) rather than
// logged and swallowed.
//
// Run under tsx so the dynamic import below can load rusthinq-adapter.ts's TypeScript directly:
//   npx tsx scripts/run.mjs config.jsonc

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

execFileSync('node', [join(root, 'scripts', 'check-rethink.mjs')], { stdio: 'inherit' })

await import(pathToFileURL(join(root, 'rusthinq-adapter.ts')).href)
