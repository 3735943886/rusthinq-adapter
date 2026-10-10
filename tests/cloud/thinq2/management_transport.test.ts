import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import {
    ManagementTransportSource,
    type ManagementDevice,
    type ManagementIO,
} from '../../../cloud/thinq2/management_transport'

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const entry = (generation = '2', extra = {}) => ({
    online: true,
    platform: 'ThinQ2',
    modelId: 'MODEL',
    incarnation: '1',
    generation,
    ...extra,
})
async function fixture(extra = {}) {
    const socket = new EventEmitter() as EventEmitter & { terminate: () => void; ping: () => void }
    socket.terminate = () => socket.emit('close')
    socket.ping = () => {}
    const calls: { url: URL; headers: object; body?: any }[] = []
    let snapshot = { devices: { device: entry() } }
    let fail = false
    const io: ManagementIO = {
        socket: (url, headers) => {
            calls.push({ url, headers })
            return socket as unknown as WebSocket
        },
        request: async (url, headers, body) => {
            calls.push({ url, headers, body })
            if (fail) throw new Error('unknown')
            return body ? { delivery: 'Sent', deviceAcknowledged: false } : snapshot
        },
    }
    const source = new ManagementTransportSource(
        { transport: 'management', api_url: 'http://localhost:8080/', ...extra },
        io,
    )
    const devices: ManagementDevice[] = []
    source.on('newDevice', (device) => devices.push(device))
    await tick()
    const event = (value: object) => socket.emit('message', Buffer.from(JSON.stringify(value)))
    return {
        source,
        devices,
        calls,
        event,
        socket,
        setSnapshot: (value: typeof snapshot) => {
            snapshot = value
        },
        fail: () => {
            fail = true
        },
    }
}

test('authenticated snapshot, startup packet, CLIP and session-filtered data', async (t) => {
    const f = await fixture({ user: 'adapter', password: 'secret' })
    t.after(() => f.source.close())
    f.source.on('newDevice', (device) => device.send_packet(Buffer.from('cafe', 'hex')))
    f.event({
        type: 'snapshot',
        state: {
            devices: {
                device: entry(),
                old: entry('2', { platform: 'ThinQ1' }),
                offline: entry('2', { online: false }),
            },
        },
    })
    await tick()
    assert.equal(f.devices.length, 1)
    assert.equal(f.calls[0].url.href, 'ws://localhost:8080/api/events')
    assert.deepEqual(f.calls[0].headers, { Authorization: `Basic ${Buffer.from('adapter:secret').toString('base64')}` })
    assert.deepEqual(f.calls[1].body, { incarnation: '1', generation: '2', hex: 'cafe' })
    assert.equal(f.calls[1].url.pathname, '/api/devices/device/packet')
    const received: string[] = []
    f.devices[0].on('data', (data) => received.push(data.toString('hex')))
    f.event({ type: 'data', device: 'device', generation: '1', hex: 'abcd' })
    f.event({ type: 'data', device: 'device', generation: '2', hex: 'abcd' })
    assert.deepEqual(received, ['abcd'])
    f.devices[0].send('setMaskingInfo', 1, { mask: 0 })
    await tick()
    assert.deepEqual(f.calls[2].body, {
        incarnation: '1',
        generation: '2',
        cmd: 'setMaskingInfo',
        type: 1,
        data: { mask: 0 },
    })
    assert.equal(f.calls[2].url.pathname, '/api/devices/device/clip')
})

test('session replacement closes old converters and blocks their sends', async (t) => {
    const f = await fixture()
    t.after(() => f.source.close())
    f.event({ type: 'snapshot', state: { devices: { device: entry() } } })
    let closed = 0
    f.devices[0].on('close', () => closed++)
    f.setSnapshot({ devices: { device: entry('3') } })
    f.event({ type: 'stateChanged' })
    await tick()
    assert.equal(closed, 1)
    assert.equal(f.devices.length, 2)
    const n = f.calls.length
    f.devices[0].send_packet(Buffer.from('aa', 'hex'))
    assert.equal(f.calls.length, n)
    f.devices[1].send_packet(Buffer.from('bb', 'hex'))
    await tick()
    assert.equal(f.calls[n].body.generation, '3')
})

test('event loss recreates converters, disconnect closes them, and skip_ids is respected', async (t) => {
    const f = await fixture({ skip_ids: ['skip'] })
    t.after(() => f.source.close())
    f.event({ type: 'snapshot', state: { devices: { device: entry(), skip: entry() } } })
    let closed = 0
    f.devices[0].on('close', () => closed++)
    f.event({ type: 'lost', events: 4 })
    assert.equal(closed, 1)
    await tick()
    assert.equal(f.devices.length, 2)
    f.devices[1].on('close', () => closed++)
    f.socket.emit('close')
    assert.equal(closed, 2)
})

test('unknown delivery never retries the command', async (t) => {
    const f = await fixture()
    t.after(() => f.source.close())
    f.event({ type: 'snapshot', state: { devices: { device: entry() } } })
    f.fail()
    f.devices[0].send_packet(Buffer.from('aa', 'hex'))
    await tick()
    assert.equal(f.calls.filter((call) => call.body).length, 1)
})

test('rejects partial auth and unsupported URL before connecting', () => {
    assert.throws(
        () => new ManagementTransportSource({ transport: 'management', api_url: 'http://localhost', user: 'x' }),
        /Both user/,
    )
    assert.throws(() => new ManagementTransportSource({ transport: 'management', api_url: 'ftp://localhost' }), /HTTP/)
})

test('real HTTP and WebSocket use Basic auth and the 0.2 packet/clip contracts', async (t) => {
    const { createServer } = await import('node:http')
    const { WebSocketServer } = await import('ws')
    const auth = `Basic ${Buffer.from('adapter:secret').toString('base64')}`
    const requests: { route: string; body: any; auth?: string }[] = []
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            requests.push({
                route: req.url!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
                auth: req.headers.authorization,
            })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ delivery: 'Sent', deviceAcknowledged: false }))
        })
    })
    const wss = new WebSocketServer({ noServer: true })
    let wsAuth: string | undefined
    server.on('upgrade', (req, socket, head) => {
        wsAuth = req.headers.authorization
        wss.handleUpgrade(req, socket, head, (client) => {
            client.send(JSON.stringify({ type: 'snapshot', state: { devices: { device: entry() } } }))
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const source = new ManagementTransportSource({
        transport: 'management',
        api_url: `http://127.0.0.1:${address.port}/`,
        user: 'adapter',
        password: 'secret',
    })
    t.after(async () => {
        source.close()
        for (const client of wss.clients) client.terminate()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('No initial device')), 2000)
        source.on('newDevice', (device) => {
            device.send_packet(Buffer.from('cafe', 'hex'))
            device.send('setMaskingInfo', 1, 'mask')
            clearTimeout(deadline)
            resolve()
        })
    })
    for (let i = 0; i < 100 && requests.length < 2; i++) await tick()
    assert.equal(wsAuth, auth)
    assert.equal(requests.length, 2)
    assert.ok(requests.every((request) => request.auth === auth))
    assert.deepEqual(requests.find((request) => request.route.endsWith('/packet'))?.body, {
        incarnation: '1',
        generation: '2',
        hex: 'cafe',
    })
    assert.deepEqual(requests.find((request) => request.route.endsWith('/clip'))?.body, {
        incarnation: '1',
        generation: '2',
        cmd: 'setMaskingInfo',
        type: 1,
        data: 'mask',
    })
})

test('queued commands preserve order and obsolete devices cannot drain their queue', async (t) => {
    const f = await fixture()
    t.after(() => f.source.close())
    f.event({ type: 'snapshot', state: { devices: { device: entry() } } })
    f.devices[0].send_packet(Buffer.from('aa', 'hex'))
    f.devices[0].send('setMaskingInfo', 1, 'mask')
    await tick()
    assert.deepEqual(
        f.calls.filter((call) => call.body).map((call) => call.url.pathname),
        ['/api/devices/device/packet', '/api/devices/device/clip'],
    )
    const n = f.calls.length
    f.devices[0].send_packet(Buffer.from('bb', 'hex'))
    f.source.close()
    await tick()
    assert.equal(f.calls.length, n)
})

test('metadata arriving later attaches a device; malformed hex closes the connection', async (t) => {
    const f = await fixture()
    t.after(() => f.source.close())
    f.event({ type: 'snapshot', state: { devices: { device: entry('2', { modelId: null }) } } })
    assert.equal(f.devices.length, 0)
    f.event({ type: 'metadata' })
    await tick()
    assert.equal(f.devices.length, 1)
    let closed = false
    f.devices[0].on('close', () => {
        closed = true
    })
    f.event({ type: 'data', device: 'device', generation: '2', hex: 'abc' })
    assert.equal(closed, true)
})

test('converter ACK requests are suppressed because rusthinq owns ACKs', async (t) => {
    const f = await fixture()
    t.after(() => f.source.close())
    f.event({ type: 'snapshot', state: { devices: { device: entry() } } })
    f.devices[0].send_ack(Buffer.from('aa', 'hex'))
    await tick()
    assert.equal(f.calls.filter((call) => call.body).length, 0)
})

test('reconnect obtains a fresh snapshot and ignores events from the old socket', async (t) => {
    const sockets: (EventEmitter & { terminate: () => void })[] = []
    const io: ManagementIO = {
        socket: () => {
            const socket = new EventEmitter() as EventEmitter & { terminate: () => void }
            socket.terminate = () => socket.emit('close')
            sockets.push(socket)
            return socket as unknown as WebSocket
        },
        request: async () => ({ delivery: 'Sent' }),
    }
    const source = new ManagementTransportSource({ transport: 'management', api_url: 'http://localhost/' }, io)
    t.after(() => source.close())
    const devices: ManagementDevice[] = []
    source.on('newDevice', (device) => devices.push(device))
    await tick()
    const emit = (socket: EventEmitter, state: object) =>
        socket.emit('message', Buffer.from(JSON.stringify({ type: 'snapshot', state })))
    emit(sockets[0], { devices: { device: entry() } })
    sockets[0].emit('close')
    emit(sockets[0], { devices: { stale: entry() } })
    assert.equal(devices.length, 1)
    await new Promise((resolve) => setTimeout(resolve, 2050))
    assert.equal(sockets.length, 2)
    emit(sockets[1], { devices: { device: entry('3') } })
    assert.equal(devices.length, 2)
    assert.equal(devices[1].scope.generation, '3')
})
