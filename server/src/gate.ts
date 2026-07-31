import { promises as dns } from 'node:dns'

/**
 * Trusting the SSO gate.
 *
 * On Yundera an AppShield sidecar terminates OIDC/Authelia SSO in front of the
 * desk, so a browser that reaches us has already proved who it is. Asking for
 * the desk's own password on top of that is a second login for no second fact.
 *
 * The gate does not tell us WHO the visitor is — it forwards no identity
 * header at all, only `Host`, `X-Forwarded-*` and the cookies (verified
 * against appshield 2.0.9's nginx.conf). It is a binary gate: pass, or
 * redirect. That is enough here, because the desk is single-user; "this
 * request came through the gate" is the whole fact we need.
 *
 * What we must NOT do is believe a header. The backend sits on the shared
 * `pcs` network and every other container can reach it directly — that is
 * deliberate, it is how stringers file filings — so any of them could send
 * `X-Forwarded-User: admin`. `request.ip` is no better: the app runs with
 * `trustProxy: true`, which makes it the left-most `X-Forwarded-For` entry and
 * therefore attacker-controlled.
 *
 * The one thing a header cannot forge is the socket it arrived on. Traffic
 * through the gate has the gate container as its TCP peer; traffic from
 * anywhere else does not.
 */

/**
 * Short on purpose. Docker recycles container addresses, so a long-lived
 * answer risks trusting an address that has since been reassigned to a
 * different container. Five seconds keeps that window negligible while still
 * absorbing the burst of calls a single page load makes.
 */
export const GATE_TTL_MS = 5_000

export type Lookup = (hostname: string, options: { all: true }) => Promise<{ address: string }[]>

/**
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:a.b.c.d`, while
 * DNS returns the bare form. Compared unnormalised, they never match and the
 * trust silently never fires.
 */
export function normaliseAddress(address: string | undefined | null): string | undefined {
  if (!address) return undefined
  const trimmed = address.trim()
  if (trimmed === '') return undefined
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed
}

export interface GateCheck {
  (peer: string | undefined | null): Promise<boolean>
}

/**
 * Builds the peer test for `host` — the gate container's name, resolved on the
 * container network.
 *
 * Resolution failures fail closed: an unresolvable gate grants nothing, and
 * the password login is still there to fall back on.
 */
export function createGateCheck(
  host: string,
  lookup: Lookup = dns.lookup as unknown as Lookup,
  now: () => number = Date.now,
): GateCheck {
  let cached: { at: number; addresses: Set<string> } | undefined

  async function addresses(at: number): Promise<Set<string>> {
    if (cached && at - cached.at < GATE_TTL_MS) return cached.addresses
    // `all: true` because the gate can be attached to more than one network,
    // and only one of those addresses is the one we are talking to.
    const found = await lookup(host, { all: true })
    const resolved = new Set(found.map((entry) => entry.address))
    cached = { at, addresses: resolved }
    return resolved
  }

  return async function isGatePeer(peer) {
    const address = normaliseAddress(peer)
    if (!address) return false
    try {
      return (await addresses(now())).has(address)
    } catch {
      return false
    }
  }
}
