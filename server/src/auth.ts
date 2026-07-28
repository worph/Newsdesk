import { timingSafeEqual } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from './db/index.js'
import { getSetting, SETTING, setSetting } from './settings.js'

export const SESSION_COOKIE = 'nd_session'

export async function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export async function checkPassword(db: Db, password: string): Promise<boolean> {
  const stored = getSetting(db, SETTING.adminPasswordHash)
  if (!stored) return false
  try {
    return await verify(stored, password)
  } catch {
    return false
  }
}

export async function setPassword(db: Db, password: string): Promise<void> {
  setSetting(db, SETTING.adminPasswordHash, await hashPassword(password))
}

/** Constant-time compare that does not leak length through an early return. */
export function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Still spend the comparison so timing does not distinguish "wrong length".
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export function issueSession(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, JSON.stringify({ v: 1, iat: Date.now() }), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    signed: true,
    maxAge: 60 * 60 * 24 * 30,
  })
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function hasSession(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE]
  if (!raw) return false
  const unsigned = request.unsignCookie(raw)
  return unsigned.valid
}

/** preHandler for everything a human drives. */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!hasSession(request)) {
    await reply.code(401).send({ error: 'not authenticated' })
  }
}

/**
 * preHandler for the ingest endpoints. A separate, rotatable bearer token —
 * stringers never hold a session.
 */
export function requireIngestToken(db: Db) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const expected = getSetting(db, SETTING.ingestToken) ?? ''
    if (!presented || !expected || !secretEquals(presented, expected)) {
      await reply.code(401).send({ error: 'invalid ingest token' })
    }
  }
}
