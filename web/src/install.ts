import { useSyncExternalStore } from 'react'

/**
 * The install prompt, kept from the moment the browser offers it.
 *
 * Chrome fires `beforeinstallprompt` once, unprompted, shortly after load — and
 * the event is only usable if you called `preventDefault()` on it at that
 * moment. React has not rendered a button by then, so the listener has to live
 * outside the component tree: this module is imported for its side effect in
 * main.tsx, before anything mounts.
 *
 * Everything here is deliberately honest about what it cannot know. There is no
 * way to ask "is this app installed?" — `getInstalledRelatedApps()` only covers
 * apps you have declared, and the display mode only tells you how *this* window
 * was opened. So a browser that has already installed the desk simply never
 * fires the event, and the button is absent rather than lying.
 */

/** Not in lib.dom — Chromium-only, and still unspecified. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export type InstallState =
  /** Running as an installed app already — there is nothing to offer. */
  | 'installed'
  /** The browser has offered a prompt and we are holding it. */
  | 'available'
  /** iOS Safari, which installs from the share sheet and fires no event. */
  | 'manual'
  /** No prompt, not installed, no instructions worth giving. */
  | 'unavailable'

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/**
 * How this window was opened. `standalone` covers Android and desktop;
 * `navigator.standalone` is the iOS equivalent and exists nowhere else.
 */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const modes = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay']
  if (modes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)) return true
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/**
 * iOS installs only from Safari's share sheet, and only from Safari itself —
 * Chrome and Firefox on iOS cannot do it at all. Telling the difference matters,
 * because the instructions are useless in the wrong browser.
 */
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
  if (!ios) return false
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
}

function snapshot(): InstallState {
  if (isStandalone()) return 'installed'
  if (deferred) return 'available'
  if (isIosSafari()) return 'manual'
  return 'unavailable'
}

// The state only ever changes through the events below, so the snapshot is
// cached: useSyncExternalStore compares by identity and re-reads on every
// render, and recomputing `matchMedia` there would be wasted work.
let current: InstallState = 'unavailable'

function refresh() {
  const next = snapshot()
  if (next === current) return
  current = next
  emit()
}

if (typeof window !== 'undefined') {
  current = snapshot()

  window.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own mini-infobar and the event is
    // spent; with it, the prompt is ours to fire from a button.
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    refresh()
  })

  // Fired when the install completes, however it was started — including from
  // the browser's own menu, which leaves our button pointing at a spent prompt.
  window.addEventListener('appinstalled', () => {
    deferred = null
    refresh()
  })

  // Installing from an open tab does not reload it, so this is what turns the
  // button off in the window you installed from.
  for (const mode of ['standalone', 'minimal-ui', 'fullscreen']) {
    window.matchMedia(`(display-mode: ${mode})`).addEventListener('change', refresh)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => 'unavailable' as const,
  )
}

/**
 * Show the prompt. Resolves to whether the app was installed.
 *
 * The event is single-use whatever the answer, so it is dropped either way: a
 * second `prompt()` on the same event throws, and a button that throws is worse
 * than one that has gone away. Chrome re-fires `beforeinstallprompt` on a later
 * visit if the user dismissed it, which is what brings the button back.
 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred
  if (!event) return false
  deferred = null
  refresh()

  try {
    await event.prompt()
    const { outcome } = await event.userChoice
    return outcome === 'accepted'
  } catch {
    return false
  }
}
