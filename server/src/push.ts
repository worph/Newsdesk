import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import webpush from 'web-push'
import type { Db } from './db/index.js'
import { schema } from './db/index.js'
import { logEvent } from './events.js'
import { getSetting, setSetting } from './settings.js'

/**
 * Web push, for Android and desktop. iOS is explicitly out of scope.
 *
 * The notification says how many drafts are waiting and deep-links to the
 * publication. It is best-effort by design: if push fails the desk is still
 * fully usable and the internal log remains authoritative (invariant 7).
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

/**
 * Send to every registered device. A subscription the push service has retired
 * (404/410) is deleted rather than retried forever — that is the only way a
 * stale registration ever goes away.
 */
export async function notifyAll(db: Db, notification: Notification): Promise<number> {
  if (!configure(db)) return 0

  const subscriptions = db.select().from(schema.pushSubscriptions).all()
  if (subscriptions.length === 0) return 0

  const payload = JSON.stringify(notification)
  let delivered = 0

  await Promise.all(
    subscriptions.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: JSON.parse(row.keys) as { p256dh: string; auth: string } },
          payload,
        )
        delivered++
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          removeSubscription(db, row.endpoint)
          return
        }
        // External alerting is best-effort: record and carry on.
        logEvent(db, {
          level: 'warn',
          code: 'PUSH_FAILED',
          message: `push to a subscription failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }),
  )

  return delivered
}

/** How many drafts are standing at the gate. */
export function awaitingCount(db: Db): number {
  return db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.status, 'AWAITING_APPROVAL'))
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
