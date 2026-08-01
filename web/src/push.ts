import { api } from './api'

/**
 * Install and push registration. Android and desktop only — iOS is explicitly
 * out of scope, and pretending otherwise would just produce a button that
 * silently does nothing.
 */

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** Registered on load so the app is installable; push is opt-in separately. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch {
    return undefined
  }
}

/**
 * The VAPID key travels as URL-safe base64 but `applicationServerKey` wants
 * bytes. Backed by an explicit ArrayBuffer because `Uint8Array.from` yields
 * `ArrayBufferLike`, which no longer satisfies `BufferSource`.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return view
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

/** The inverse of the conversion above, to compare a live subscription's key. */
function uint8ArrayToUrlBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface DeviceRegistration {
  /** This browser holds a push subscription. */
  registered: boolean
  /**
   * It was made against a VAPID key the desk no longer serves, so nothing sent
   * to it can be delivered.
   *
   * This is the failure the old screen could not see. A browser keeps its
   * subscription happily after the desk's keypair changes — which is what
   * re-creating the database does — and reports itself registered forever while
   * every send is refused. Comparing keys is the only way to catch it from
   * here, and re-subscribing is the fix.
   */
  stale: boolean
}

export async function deviceRegistration(serverKey: string): Promise<DeviceRegistration> {
  const subscription = await currentSubscription()
  if (!subscription) return { registered: false, stale: false }

  const key = subscription.options.applicationServerKey
  // A subscription that will not say what key it holds is taken at its word:
  // claiming staleness we cannot prove would send people round a pointless loop.
  if (!key) return { registered: true, stale: false }

  return {
    registered: true,
    stale: uint8ArrayToUrlBase64(key as ArrayBuffer) !== serverKey.replace(/=+$/, ''),
  }
}

export async function subscribeToPush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'This browser does not support web push.' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: 'Notifications were not allowed.' }

  const registration = await navigator.serviceWorker.ready
  const { publicKey } = await api.pushKey()

  const subscription = await registration.pushManager.subscribe({
    // Required by every browser: a push you cannot read is not useful anyway.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
  if (!json.endpoint || !json.keys) return { ok: false, reason: 'The browser returned an unusable subscription.' }

  await api.subscribePush({ endpoint: json.endpoint, keys: json.keys, ua: navigator.userAgent })
  return { ok: true }
}

export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  await api.unsubscribePush(subscription.endpoint).catch(() => undefined)
  await subscription.unsubscribe()
}
