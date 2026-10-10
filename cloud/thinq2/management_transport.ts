import { TypedEmitter } from 'tiny-typed-emitter'
import WebSocket from 'ws'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import log from '@/util/logging'
import type { Metadata } from '@/cloud/thinq'

export type ManagementTransportConfig = {
    transport: 'management'
    api_url: string
    user?: string
    password?: string
    skip_ids?: string[]
}

type Entry = {
    online: boolean
    platform: string
    modelId?: string
    modelName?: string
    deviceType?: string
    swVersion?: string
    incarnation: string
    generation: string | null
    removal?: string | null
}
type Snapshot = { devices: Record<string, Entry> }
type Events = {
    data: (packet: Buffer) => void
    response: (body: Record<string, unknown>) => void
    sendData: (packet: Buffer) => void
    close: () => void
}

export class ManagementDevice extends TypedEmitter<Events> {
    readonly platform = 'thinq2' as const
    constructor(
        readonly id: string,
        readonly meta: Metadata,
        readonly scope: { incarnation: string; generation: string },
        private readonly transmit: (route: 'packet' | 'clip', body: object) => void,
    ) {
        super()
    }
    // rusthinq owns local/cloud ACK selection. rethink's newer AABB converters
    // request these too; suppress them to avoid a second ACK owner.
    send_ack(_packet: Buffer) {}

    send_packet(packet: Buffer) {
        this.emit('sendData', packet)
        this.transmit('packet', { hex: packet.toString('hex') })
    }
    send(cmd: string, type: number, data: string | object) {
        this.transmit('clip', { cmd, type, data })
    }
}

// Injectable IO also lets tests exercise loss, stale sessions and HTTP failures.
export type ManagementIO = {
    socket: (url: URL, headers: Record<string, string>) => WebSocket
    request: (url: URL, headers: Record<string, string>, body?: object) => Promise<unknown>
}
const defaultIO: ManagementIO = {
    socket: (url, headers) => new WebSocket(url, { headers, handshakeTimeout: 10000, maxPayload: 1000000 }),
    request: (url, headers, body) =>
        new Promise((resolve, reject) => {
            const text = body === undefined ? undefined : JSON.stringify(body)
            const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
                url,
                {
                    method: text === undefined ? 'GET' : 'POST',
                    headers: {
                        ...headers,
                        ...(text === undefined
                            ? {}
                            : {
                                  'Content-Type': 'application/json',
                                  'Content-Length': String(Buffer.byteLength(text)),
                              }),
                    },
                },
                (response) => {
                    const chunks: Buffer[] = []
                    let size = 0
                    response.on('data', (chunk: Buffer) => {
                        size += chunk.length
                        if (size > 1000000) response.destroy(new Error('API response too large'))
                        else chunks.push(chunk)
                    })
                    response.on('error', reject)
                    response.on('end', () => {
                        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                            reject(new Error(`HTTP ${response.statusCode}; command not retried`))
                            return
                        }
                        try {
                            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                        } catch {
                            reject(new Error('Invalid API JSON'))
                        }
                    })
                },
            )
            // A total deadline covers both connect and response time. No command retry.
            const deadline = setTimeout(() => req.destroy(new Error('API timeout; outcome unknown')), 35000)
            req.on('close', () => clearTimeout(deadline))
            req.on('error', reject)
            req.end(text)
        }),
}

export class ManagementTransportSource extends TypedEmitter<{ newDevice: (device: ManagementDevice) => void }> {
    private readonly base: URL
    private readonly headers: Record<string, string>
    private readonly devices = new Map<string, ManagementDevice>()
    private socket?: WebSocket
    private retry?: ReturnType<typeof setTimeout>
    private heartbeat?: ReturnType<typeof setInterval>
    private stopped = false
    private epoch = 0
    private ready = false
    private refreshing = false
    private refreshAgain = false
    private alive = true

    constructor(
        private readonly config: ManagementTransportConfig,
        private readonly io: ManagementIO = defaultIO,
    ) {
        super()
        this.base = new URL(config.api_url)
        if (
            !['http:', 'https:'].includes(this.base.protocol) ||
            this.base.username ||
            this.base.password ||
            this.base.search ||
            this.base.hash
        ) {
            throw new Error('api_url must be an HTTP(S) URL without credentials, query or fragment')
        }
        if ((config.user === undefined) !== (config.password === undefined))
            throw new Error('Both user and password are required')
        if (!this.base.pathname.endsWith('/')) this.base.pathname += '/'
        this.headers =
            config.user === undefined
                ? {}
                : {
                      Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`,
                  }
        // Defer so callers can subscribe to newDevice before an initial snapshot.
        this.retry = setTimeout(() => this.connect(), 0)
    }

    close() {
        this.stopped = true
        clearTimeout(this.retry)
        clearInterval(this.heartbeat)
        this.epoch++
        this.ready = false
        this.clearDevices()
        this.socket?.terminate()
    }
    private clearDevices() {
        const previous = [...this.devices.values()]
        this.devices.clear()
        for (const device of previous) device.emit('close')
    }
    private connect() {
        if (this.stopped) return
        const epoch = ++this.epoch
        this.ready = false
        this.refreshing = false
        this.refreshAgain = false
        const url = new URL('api/events', this.base)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = this.io.socket(url, this.headers)
        this.socket = socket
        socket.on('message', (data) => {
            if (epoch !== this.epoch || this.stopped) return
            try {
                this.onEvent(JSON.parse(data.toString()), epoch)
            } catch {
                log('status', 'rusthinq management: invalid event; reconnecting')
                socket.terminate()
            }
        })
        socket.on('error', () => log('status', 'rusthinq management: connection error (check URL and authentication)'))
        socket.on('pong', () => {
            this.alive = true
        })
        socket.on('open', () => {
            this.alive = true
            this.heartbeat = setInterval(() => {
                if (!this.alive) {
                    socket.terminate()
                    return
                }
                this.alive = false
                socket.ping()
            }, 30000)
        })
        socket.on('close', () => {
            if (epoch !== this.epoch) return
            clearInterval(this.heartbeat)
            this.epoch++
            this.ready = false
            this.clearDevices()
            if (!this.stopped) this.retry = setTimeout(() => this.connect(), 2000)
        })
    }
    private onEvent(event: any, epoch: number) {
        if (event.type === 'snapshot') {
            this.ready = true
            this.applySnapshot(event.state)
        } else if (event.type === 'lost') {
            // Recreate converters so their startup queries refresh cached values.
            this.ready = false
            this.clearDevices()
            this.refresh(epoch)
        } else if (event.type === 'stateChanged' || event.type === 'metadata') {
            this.refresh(epoch)
        } else if (event.type === 'data' && this.ready) {
            const device = this.devices.get(event.device)
            if (!device || device.scope.generation !== event.generation) return
            if (typeof event.hex !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(event.hex))
                throw new Error('Invalid frame hex')
            device.emit('data', Buffer.from(event.hex, 'hex'))
        }
    }
    private refresh(epoch: number) {
        if (this.refreshing) {
            this.refreshAgain = true
            return
        }
        this.refreshing = true
        void this.io
            .request(new URL('api/devices', this.base), this.headers)
            .then((snapshot) => {
                if (epoch !== this.epoch || this.stopped) return
                this.ready = true
                this.applySnapshot(snapshot as Snapshot)
            })
            .catch(() => {
                if (epoch === this.epoch) this.socket?.terminate()
            })
            .finally(() => {
                if (epoch !== this.epoch) return
                this.refreshing = false
                if (this.refreshAgain) {
                    this.refreshAgain = false
                    this.refresh(epoch)
                }
            })
    }
    private applySnapshot(snapshot: Snapshot) {
        if (!snapshot || !snapshot.devices || typeof snapshot.devices !== 'object' || Array.isArray(snapshot.devices))
            throw new Error('Invalid snapshot')
        const seen = new Set<string>()
        for (const [id, entry] of Object.entries(snapshot.devices)) {
            if (
                !entry ||
                entry.online !== true ||
                entry.platform !== 'ThinQ2' ||
                entry.removal ||
                !entry.modelId ||
                this.config.skip_ids?.includes(id)
            )
                continue
            if (
                typeof entry.incarnation !== 'string' ||
                !/^\d+$/.test(entry.incarnation) ||
                typeof entry.generation !== 'string' ||
                !/^\d+$/.test(entry.generation)
            )
                continue
            seen.add(id)
            const previous = this.devices.get(id)
            if (
                previous &&
                previous.scope.incarnation === entry.incarnation &&
                previous.scope.generation === entry.generation &&
                previous.meta.modelId === entry.modelId
            )
                continue
            if (previous) {
                this.devices.delete(id)
                previous.emit('close')
            }
            const scope = { incarnation: entry.incarnation, generation: entry.generation }
            let pending = 0
            let tail = Promise.resolve()
            const device = new ManagementDevice(
                id,
                {
                    modelId: entry.modelId,
                    modelName: entry.modelName ?? entry.modelId,
                    deviceType: entry.deviceType,
                    swVersion: entry.swVersion,
                },
                scope,
                (route, body) => {
                    if (this.stopped || !this.ready || this.devices.get(id) !== device) return
                    if (pending >= 128) {
                        log('status', `rusthinq management: command queue full for ${id}`)
                        return
                    }
                    pending++
                    tail = tail
                        .then(async () => {
                            if (this.stopped || !this.ready || this.devices.get(id) !== device) return
                            try {
                                const result = (await this.io.request(
                                    new URL(`api/devices/${encodeURIComponent(id)}/${route}`, this.base),
                                    this.headers,
                                    { ...scope, ...body },
                                )) as { delivery?: string }
                                if (result?.delivery !== 'Sent') throw new Error('Delivery not confirmed')
                            } catch {
                                log(
                                    'status',
                                    `rusthinq management: ${route} delivery failed or unknown for ${id}; not retried`,
                                )
                                if (this.devices.get(id) === device) this.refresh(this.epoch)
                            }
                        })
                        .finally(() => {
                            pending--
                        })
                },
            )
            this.devices.set(id, device)
            this.emit('newDevice', device)
        }
        for (const [id, device] of this.devices) {
            if (!seen.has(id)) {
                this.devices.delete(id)
                device.emit('close')
            }
        }
    }
}
