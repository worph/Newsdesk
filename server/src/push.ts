import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import webpush from 'web-push'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'
import { logEvent } from './events.js'
import { getSetting, setSetting } from './settings.js'

/**
 * Web push, for Android and desktop. iOS is explicitly out of scope.
 *
 * The desk asks for two decisions and notifies both: a story landing in the
 * placement queue, and the draft that follows once the writer has been. Each
 * notification says how many of its kind are waiting and deep-links to the one
 * that triggered it.
 *
 * It is best-effort by design: if push fails the desk is still fully usable and
 * the internal log remains authoritative (invariant 7). Best-effort is not the
 * same as silent, though — every send records what became of it, because a
 * notification path that fails quietly is one nobody finds out about.
 */

export const PUSH_SETTING = {
  publicKey: 'vapid_public_key',
  privateKey: 'vapid_private_key',
  subject: 'vapid_subject',
} as const

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** Generated on first boot and stored; rotating them invalidates every subscription. */
export function getOrCreateVapidKeys(db: Db): VapidKeys {
  const publicKey = getSetting(db, PUSH_SETTING.publicKey)
  const privateKey = getSetting(db, PUSH_SETTING.privateKey)
  if (publicKey && privateKey) return { publicKey, privateKey }

  const generated = webpush.generateVAPIDKeys()
  setSetting(db, PUSH_SETTING.publicKey, generated.publicKey)
  setSetting(db, PUSH_SETTING.privateKey, generated.privateKey)
  return generated
}

function configure(db: Db): boolean {
  const keys = getOrCreateVapidKeys(db)
  // A contact address is required by the push services; mailto is enough and
  // nothing is sent to it unless a service operator needs to reach us.
  const subject = getSetting(db, PUSH_SETTING.subject) ?? 'mailto:newsdesk@localhost'
  try {
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey)
    return true
  } catch {
    return false
  }
}

export interface SubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
  ua?: string
}

export function saveSubscription(db: Db, input: SubscriptionInput): string {
  const existing = db
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.endpoint, input.endpoint))
    .get()

  if (existing) {
    db.update(schema.pushSubscriptions)
      .set({ keys: JSON.stringify(input.keys), ua: input.ua ?? null })
      .where(eq(schema.pushSubscriptions.id, existing.id))
      .run()
    return existing.id
  }

  const id = randomUUID()
  db.insert(schema.pushSubscriptions)
    .values({ id, endpoint: input.endpoint, keys: JSON.stringify(input.keys), ua: input.ua ?? null })
    .run()
  return id
}

export function removeSubscription(db: Db, endpoint: string): void {
  db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint)).run()
}

export interface Notification {
  title: string
  body: string
  /** Where tapping it lands. */
  url: string
}

export interface PushResult {
  /** Devices registered when the send was attempted. */
  subscribers: number
  delivered: number
  /** Registrations the push service disowned; they were removed. */
  dropped: number
  /** Everything else: reachable service, delivery refused. Kept and retried. */
  failed: number
}

/**
 * A status that means this registration can never be delivered to again, so
 * keeping it is worse than useless — it makes the desk report a device as
 * notified when nothing will ever arrive.
 *
 * 404/410: the push service retired the registration.
 * 401/403: it rejected our VAPID signature. That is what a regenerated keypair
 * looks like from here — the device subscribed against a public key this desk
 * no longer holds, which is exactly what happens when the database is
 * re-created. Retrying forever would keep the Settings screen saying
 * "registered" while every send is refused, so the registration goes and the
 * screen tells the truth: register this device again.
 */
function isDeadRegistration(status: number | undefined): boolean {
  return status === 404 || status === 410 || status === 401 || status === 403
}

/**
 * Send to every registered device.
 *
 * Best-effort by design (invariant 7) — but silent best-effort is how a
 * notification path rots unnoticed, so every outcome lands in the log and in
 * the returned counts, which is what the Settings test button reports back.
 */
export async function notifyAll(db: Db, notification: Notification): Promise<PushResult> {
  const empty: PushResult = { subscribers: 0, delivered: 0, dropped: 0, failed: 0 }
  if (!configure(db)) {
    logEvent(db, {
      level: 'warn',
      code: 'PUSH_UNCONFIGURED',
      message: 'no usable VAPID keypair, so nothing was notified',
    })
    return empty
  }

  const subscriptions = db.select().from(schema.pushSubscriptions).all()
  if (subscriptions.length === 0) {
    // The commonest reason for "I never get notified", and until now the only
    // one that left no trace at all.
    logEvent(db, {
      level: 'info',
      code: 'PUSH_NO_DEVICES',
      message: `no device is registered, so "${notification.title}" was not sent`,
    })
    return empty
  }

  const payload = JSON.stringify(notification)
  const result: PushResult = { subscribers: subscriptions.length, delivered: 0, dropped: 0, failed: 0 }

  await Promise.all(
    subscriptions.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: JSON.parse(row.keys) as { p256dh: string; auth: string } },
          payload,
        )
        result.delivered++
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        const detail = err instanceof Error ? err.message : String(err)

        if (isDeadRegistration(status)) {
          removeSubscription(db, row.endpoint)
          result.dropped++
          logEvent(db, {
            level: 'warn',
            code: 'PUSH_REGISTRATION_DEAD',
            message:
              status === 401 || status === 403
                ? 'a device was registered against a VAPID key this desk no longer holds — register it again from Settings'
                : 'the push service has retired a registration; it was removed',
            detail: { status, endpoint: row.endpoint, detail },
          })
          return
        }

        result.failed++
        logEvent(db, {
          level: 'warn',
          code: 'PUSH_FAILED',
          message: 'a notification could not be delivered to one registered device',
          detail: { status, endpoint: row.endpoint, error: detail },
        })
      }
    }),
  )

  return result
}

/** How many devices the desk believes it can reach. */
export function subscriptionCount(db: Db): number {
  return db.select().from(schema.pushSubscriptions).all().length
}

/** How many drafts are standing at the gate. */
export function awaitingCount(db: Db): number {
  return db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.status, 'AWAITING_APPROVAL'))
    .all().length
}

/** How many stories are waiting on a placement decision. */
export function placementCount(db: Db): number {
  return db
    .select()
    .from(schema.stories)
    .where(inArray(schema.stories.status, ['PLACED', 'HELD']))
    .all().length
}

/**
 * Called when a draft becomes ready. The count is what makes the notification
 * useful on a phone — "3 drafts waiting" is actionable, "something happened"
 * is not.
 */
export async function notifyDraftReady(
  db: Db,
  publicationId: string,
  storyTitle: string,
): Promise<void> {
  const waiting = awaitingCount(db)
  await notifyAll(db, {
    title: waiting > 1 ? `${waiting} drafts waiting` : 'A draft is waiting',
    body: storyTitle,
    url: `/review/${publicationId}`,
  })
}

/**
 * Called when a browser outlet's slot comes due.
 *
 * The wording matters more here than anywhere else in the desk: this is not
 * "something is waiting", it is a job with a deadline that only a person can
 * finish. Nothing goes out until they tap it.
 */
export async function notifyHandoverDue(
  db: Db,
  publicationId: string,
  outletName: string,
  storyTitle: string,
  options: { reminder?: boolean } = {},
): Promise<void> {
  await notifyAll(db, {
    title: options.reminder ? `Still waiting to publish on ${outletName}` : `Ready to publish on ${outletName}`,
    body: storyTitle,
    url: `/review/${publicationId}/live`,
  })
}

/**
 * Called when the browser has been signed out of a destination and something
 * is due to go there.
 *
 * The one notification in the desk that asks for a credential rather than a
 * decision — so it says which destination, and the link opens the browser at
 * that site's own login page rather than anywhere in the desk.
 */
export async function notifyNeedsAuth(
  db: Db,
  publicationId: string,
  outletName: string,
  storyTitle: string,
  options: { reminder?: boolean } = {},
): Promise<void> {
  await notifyAll(db, {
    title: options.reminder ? `Still signed out of ${outletName}` : `Sign in to ${outletName}`,
    body: `${storyTitle} — nothing can go out until the browser is signed back in.`,
    url: `/review/${publicationId}/live`,
  })
}

export interface PlacedStory {
  storyId: string
  title: string
  /** A held story is a question, not a proposal, and the phone should say so. */
  held: boolean
}

/**
 * Called when the managing editor puts stories in the placement queue — the
 * first of the two decisions the desk asks for, and the one that arrives
 * unannounced. Until now only the draft that comes after it was notified, so
 * the queue could fill up in silence.
 *
 * One filing can open several stories at once; they become one notification,
 * because three chimes for one wire item is how a person turns notifications
 * off.
 */
export async function notifyPlacementsWaiting(db: Db, opened: PlacedStory[]): Promise<void> {
  if (opened.length === 0) return

  const waiting = placementCount(db)
  const held = opened.every((story) => story.held)
  const single = opened.length === 1 ? opened[0] : undefined

  await notifyAll(db, {
    title: waiting > 1 ? `${waiting} placements waiting` : held ? 'A story needs context' : 'A placement is waiting',
    body: single ? single.title : opened.map((story) => story.title).join(' · '),
    // A single story opens on itself; several have no one page, so they land
    // on the action list rather than the backlog — a notification exists to be
    // acted on, and the Queue makes you hunt for the thing that just chimed.
    url: single ? `/stories/${single.storyId}` : '/now',
  })
}
