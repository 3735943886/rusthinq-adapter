// Runs rethink ThinQ2 converters and the HA bridge using either the rusthinq 0.1
// raw MQTT bus or the 0.2 management API. Only the transport is owned here.

import stripJsonComments from 'strip-json-comments'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Connection as HA_connection } from '@/cloud/homeassistant'
import HA_bridge from '@/cloud/ha_bridge'
import { DeviceManager } from '@/cloud/devmgr'
import { RusthinqTransportSource, type RusthinqTransportConfig } from './cloud/thinq2/rusthinq_transport'
import { ManagementTransportSource, type ManagementTransportConfig } from './cloud/thinq2/management_transport'
import { type Device as T2Device } from '@/cloud/thinq2/device'
import { type HAConfig } from '@/util/config'
import log, { setFilter as setLogFilter } from '@/util/logging'
import { fileURLToPath } from 'node:url'

type AdapterConfig = {
    homeassistant: HAConfig & { storage_path?: string }
    rusthinq: RusthinqTransportConfig | ManagementTransportConfig
    bridge?: { storage_path: string }
    log?: string[]
}

const configPath = resolve(process.argv[2] ?? './rusthinq-adapter-config.json')
const configDir = dirname(configPath)
const config = JSON.parse(stripJsonComments(readFileSync(configPath).toString('utf-8'))) as AdapterConfig

if (config.homeassistant.storage_path) {
    config.homeassistant.storage_path = resolve(configDir, config.homeassistant.storage_path)
    mkdirSync(config.homeassistant.storage_path, { recursive: true })
}
if (config.bridge) {
    config.bridge.storage_path = resolve(configDir, config.bridge.storage_path)
    mkdirSync(config.bridge.storage_path, { recursive: true })
}

const enabled = Object.fromEntries((config.log ?? ['status']).map((key) => [key, true]))
setLogFilter((topic) => enabled[topic] || enabled['all'])

// Some rethink forks add persistent reservation relay storage. Load that optional
// module when supplied, without making upstream rethink depend on fork-only APIs.
let reservationStore: unknown
if (config.bridge) {
    const base = new URL('./rethink/bridge/reservation-store', import.meta.url)
    const moduleURL = ['.js', '.ts']
        .map((extension) => new URL(base.href + extension))
        .find((url) => existsSync(fileURLToPath(url)))
    if (moduleURL) {
        const { ReservationJSONStore } = await import(moduleURL.href)
        reservationStore = new ReservationJSONStore(config.bridge.storage_path)
    } else {
        log('status', 'This rethink checkout has no reservation-store; bridge storage is unavailable')
    }
}
const ha = Reflect.construct(HA_bridge, [new HA_connection(config.homeassistant), reservationStore]) as HA_bridge
const manager = new DeviceManager()
manager.on('newDevice', (dev) => ha.newDevice(dev))

if (config.rusthinq.transport !== undefined && !['mqtt', 'management'].includes(config.rusthinq.transport)) {
    throw new Error('Unknown rusthinq transport; choose mqtt or management')
}

const source =
    config.rusthinq.transport === 'management'
        ? new ManagementTransportSource(config.rusthinq)
        : new RusthinqTransportSource(config.rusthinq)
source.on('newDevice', (dev) => {
    // RusthinqTransportDevice only implements the subset of the real Device class that
    // DeviceManager/Bridge/HADevice/TLVDevice/ac_common.ts actually touch (id, meta, platform,
    // send_packet, the data/sendData/close events) - see rusthinq_transport.ts's header comment.
    manager.accept(dev as unknown as T2Device)
})

log('status', 'rusthinq TS adapter ready')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        if (source instanceof ManagementTransportSource) source.close()
        process.exit(0)
    })
}
