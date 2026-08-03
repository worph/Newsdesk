/**
 * One publish at a time, per browser.
 *
 * The container owns one browser and one visible tab, so two publications
 * staging at once would compose into each other's page. A lease makes that
 * impossible and makes the refusal legible: the second operator is told who
 * holds it rather than watching their post appear in someone else's composer.
 *
 * In process, not in the database, and that is correct rather than convenient:
 * the desk runs as exactly one instance (invariant 9) and the sidecar is its
 * own. A lease that outlived the process holding it would be worse than none —
 * a restart would leave the browser locked by a publish that no longer exists.
 *
 * Sized for the real contention, which is two people tapping a notification at
 * the same moment, not two publications coming due together: staging happens
 * when someone opens the link, so a queue of waiting posts holds nothing.
 * See docs/browser-publishing.md section 7.
 */

export interface Lease {
  engineId: string
  publicationId: string
  /** What to show the next person: an outlet name reads better than an id. */
  label: string
  takenAt: number
  expiresAt: number
  /**
   * The tab this publication is working in.
   *
   * Held here rather than on the row because it is worth exactly as long as
   * the lease is: a tab does not survive the browser, and the desk is a single
   * instance. It is also what the viewer points at — a live view of "whatever
   * is first" would show the operator somebody else's page.
   */
  pageId?: string
}

export class BrowserBusy extends Error {
  constructor(readonly held: Lease) {
    super(`the browser is publishing ${held.label}`)
    this.name = 'BrowserBusy'
  }
}

/**
 * Long enough for an operator to read a post and press a button, short enough
 * that a closed tab does not lock the browser for the rest of the day. Renewed
 * while the live view is open, so an unusually slow read is not cut off.
 */
export const LEASE_TTL_MS = 15 * 60_000

const held = new Map<string, Lease>()

function live(engineId: string, now: number): Lease | undefined {
  const lease = held.get(engineId)
  if (!lease) return undefined
  if (lease.expiresAt <= now) {
    held.delete(engineId)
    return undefined
  }
  return lease
}

/**
 * Take the browser for a publication.
 *
 * Re-entrant for the same publication: an operator who reloads the live page is
 * the common case, and refusing them their own lease would be a bug that looks
 * exactly like contention.
 */
export function acquire(
  engineId: string,
  publicationId: string,
  label: string,
  options: { now?: () => number; ttlMs?: number } = {},
): Lease {
  const now = (options.now ?? Date.now)()
  const ttl = options.ttlMs ?? LEASE_TTL_MS
  const existing = live(engineId, now)

  if (existing && existing.publicationId !== publicationId) throw new BrowserBusy(existing)

  const lease: Lease = {
    engineId,
    publicationId,
    label,
    takenAt: existing?.takenAt ?? now,
    expiresAt: now + ttl,
    // Carried across a re-entrant take, or the caller opens a second tab every
    // time an operator reloads the live page — one leaked tab per reload.
    pageId: existing?.pageId,
  }
  held.set(engineId, lease)
  return lease
}

/** Extend a lease the operator is demonstrably still using. */
export function renew(
  engineId: string,
  publicationId: string,
  options: { now?: () => number; ttlMs?: number } = {},
): Lease | undefined {
  const now = (options.now ?? Date.now)()
  const lease = live(engineId, now)
  if (!lease || lease.publicationId !== publicationId) return undefined
  lease.expiresAt = now + (options.ttlMs ?? LEASE_TTL_MS)
  return lease
}

/** Remember which tab this lease is working in. */
export function attachPage(engineId: string, publicationId: string, pageId: string): void {
  const lease = held.get(engineId)
  if (lease && lease.publicationId === publicationId) lease.pageId = pageId
}

/** Give the browser back. Releasing a lease someone else holds is a no-op. */
export function release(engineId: string, publicationId: string, now = Date.now()): void {
  const lease = live(engineId, now)
  if (lease && lease.publicationId === publicationId) held.delete(engineId)
}

export function holder(engineId: string, now = Date.now()): Lease | undefined {
  return live(engineId, now)
}

/** Tests only: forget every lease. */
export function resetLeases(): void {
  held.clear()
}
