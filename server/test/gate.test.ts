import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { setPassword } from '../src/auth.js'
import { createGateCheck, GATE_TTL_MS, normaliseAddress, type GateCheck, type Lookup } from '../src/gate.js'
import { openDb, runMigrations, type DbHandle } from '../src/db/index.js'
import { getOrCreateSecret, SETTING } from '../src/settings.js'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

const GATE_IP = '172.18.0.36'
const OTHER_IP = '172.18.0.99'

function lookupReturning(...addresses: string[]): Lookup {
  return async () => addresses.map((address) => ({ address }))
}

describe('normaliseAddress', () => {
  it('strips the IPv4-mapped IPv6 prefix Node reports on a dual-stack socket', () => {
    // Unnormalised, `::ffff:172.18.0.36` never equals the `172.18.0.36` DNS
    // returns, and the trust would silently never fire.
    expect(normaliseAddress('::ffff:172.18.0.36')).toBe('172.18.0.36')
  })

  it('leaves a bare address alone', () => {
    expect(normaliseAddress('172.18.0.36')).toBe('172.18.0.36')
  })

  it('leaves a real IPv6 address alone', () => {
    expect(normaliseAddress('fd00::1')).toBe('fd00::1')
  })

  it('treats missing, empty and whitespace addresses as no address', () => {
    expect(normaliseAddress(undefined)).toBeUndefined()
    expect(normaliseAddress(null)).toBeUndefined()
    expect(normaliseAddress('')).toBeUndefined()
    expect(normaliseAddress('   ')).toBeUndefined()
  })
})

describe('createGateCheck', () => {
  it('accepts a peer at the gate address', async () => {
    const check = createGateCheck('newsdesk', lookupReturning(GATE_IP))
    expect(await check(GATE_IP)).toBe(true)
  })

  it('accepts the IPv4-mapped form of the gate address', async () => {
    const check = createGateCheck('newsdesk', lookupReturning(GATE_IP))
    expect(await check(`::ffff:${GATE_IP}`)).toBe(true)
  })

  it('rejects any other peer on the network', async () => {
    const check = createGateCheck('newsdesk', lookupReturning(GATE_IP))
    expect(await check(OTHER_IP)).toBe(false)
  })

  it('rejects a peer with no address at all', async () => {
    const check = createGateCheck('newsdesk', lookupReturning(GATE_IP))
    expect(await check(undefined)).toBe(false)
  })

  it('accepts any of the gate addresses when it is on several networks', async () => {
    const check = createGateCheck('newsdesk', lookupReturning(GATE_IP, '10.5.0.7'))
    expect(await check(GATE_IP)).toBe(true)
    expect(await check('10.5.0.7')).toBe(true)
    expect(await check(OTHER_IP)).toBe(false)
  })

  it('fails closed when the gate cannot be resolved', async () => {
    // An unresolvable gate must grant nothing. The password login is still
    // there, so failing closed costs a login, not access.
    const check = createGateCheck('newsdesk', async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND newsdesk'), { code: 'ENOTFOUND' })
    })
    expect(await check(GATE_IP)).toBe(false)
  })

  it('caches within the TTL rather than resolving per request', async () => {
    const lookup = vi.fn(lookupReturning(GATE_IP))
    let clock = 1_000
    const check = createGateCheck('newsdesk', lookup, () => clock)

    await check(GATE_IP)
    clock += GATE_TTL_MS - 1
    await check(GATE_IP)

    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('re-resolves once the TTL has passed, so a recycled address is not trusted forever', async () => {
    // Docker reuses container addresses. If the gate goes away and its address
    // is handed to some other container, a cached answer would keep trusting
    // it; expiry is what bounds that window.
    let addresses = [GATE_IP]
    const lookup = vi.fn(async () => addresses.map((address) => ({ address })))
    let clock = 1_000
    const check = createGateCheck('newsdesk', lookup, () => clock)

    expect(await check(GATE_IP)).toBe(true)

    addresses = ['172.18.0.55'] // gate recreated on a new address
    clock += GATE_TTL_MS + 1

    expect(await check(GATE_IP)).toBe(false)
    expect(await check('172.18.0.55')).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})

describe('gate trust through the app', () => {
  let dir: string
  let handle: DbHandle
  let app: FastifyInstance

  async function build(gateCheck?: GateCheck): Promise<FastifyInstance> {
    const built = await buildApp({
      db: handle.db,
      sessionSecret: 'test-secret',
      publicDir: join(dir, 'no-public'),
      logLevel: 'silent',
      ...(gateCheck ? { gateCheck } : {}),
    })
    await built.ready()
    return built
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'newsdesk-gate-'))
    handle = openDb(join(dir, 'test.db'))
    runMigrations(handle.db, migrationsFolder)
    await setPassword(handle.db, 'correct horse battery')
  })

  afterEach(async () => {
    await app?.close()
    handle.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lets a request through the gate reach a protected route with no cookie', async () => {
    app = await build(async (peer) => peer === GATE_IP)
    const res = await app.inject({ method: 'GET', url: '/api/v1/config', remoteAddress: GATE_IP })
    expect(res.statusCode).toBe(200)
  })

  it('reports the visitor as authenticated, so the UI shows no login form', async () => {
    app = await build(async (peer) => peer === GATE_IP)
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: GATE_IP })
    expect(res.json()).toEqual({ authenticated: true })
  })

  it('still challenges a request that did not come through the gate', async () => {
    app = await build(async (peer) => peer === GATE_IP)
    const res = await app.inject({ method: 'GET', url: '/api/v1/config', remoteAddress: OTHER_IP })
    expect(res.statusCode).toBe(401)
    expect(await app.inject({ method: 'GET', url: '/api/v1/auth/me', remoteAddress: OTHER_IP }).then((r) => r.json()))
      .toEqual({ authenticated: false })
  })

  it('challenges everything when no gate is configured', async () => {
    app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/v1/config', remoteAddress: GATE_IP })
    expect(res.statusCode).toBe(401)
  })

  it('judges the socket, not X-Forwarded-For', async () => {
    // trustProxy is on, so request.ip is the left-most X-Forwarded-For entry —
    // entirely caller-controlled. A neighbour on the shared network claiming
    // to be the gate must still be turned away.
    const seen: (string | undefined | null)[] = []
    app = await build(async (peer) => {
      seen.push(peer)
      return peer === GATE_IP
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      remoteAddress: OTHER_IP,
      headers: { 'x-forwarded-for': GATE_IP, 'x-real-ip': GATE_IP },
    })

    expect(res.statusCode).toBe(401)
    expect(seen).toEqual([OTHER_IP])
  })

  it('does not let a forged identity header stand in for the gate', async () => {
    app = await build(async (peer) => peer === GATE_IP)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      remoteAddress: OTHER_IP,
      headers: { 'remote-user': 'admin', 'x-forwarded-user': 'admin', 'x-forwarded-email': 'admin@example.com' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('leaves the ingest token as the ingest credential, gate or no gate', async () => {
    // Stringers reach the backend directly, never through the gate, and must
    // keep working; the gate must not become a way to file without the token.
    app = await build(async (peer) => peer === GATE_IP)
    const token = getOrCreateSecret(handle.db, SETTING.ingestToken)

    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/submissions',
      remoteAddress: GATE_IP,
      payload: { stringer_id: 'tip-line', text: 'no token presented' },
    })
    expect(forged.statusCode).toBe(401)

    const withToken = await app.inject({
      method: 'POST',
      url: '/api/v1/submissions',
      remoteAddress: OTHER_IP,
      headers: { authorization: `Bearer ${token}` },
      payload: { stringer_id: 'tip-line', text: 'filed by a stringer over the internal network' },
    })
    // 422, not 201: the token cleared authentication and the request was
    // rejected on its merits — this bare database has no sources configured.
    // Getting past 401 from a non-gate peer is what this asserts.
    expect(withToken.statusCode).toBe(422)
  })

  it('does not pay for a lookup on non-API requests', async () => {
    const gateCheck = vi.fn(async () => true)
    app = await build(gateCheck)
    await app.inject({ method: 'GET', url: '/icon.svg', remoteAddress: GATE_IP })
    expect(gateCheck).not.toHaveBeenCalled()
  })

  it('still accepts the password login while a gate is configured', async () => {
    app = await build(async (peer) => peer === GATE_IP)
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: OTHER_IP,
      payload: { password: 'correct horse battery' },
    })
    expect(login.statusCode).toBe(200)
    const cookie = login.cookies.find((c) => c.name === 'nd_session')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      remoteAddress: OTHER_IP,
      headers: { cookie: `nd_session=${cookie!.value}` },
    })
    expect(res.statusCode).toBe(200)
  })
})
