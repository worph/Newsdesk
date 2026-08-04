/**
 * Service worker for install and push only.
 *
 * There is deliberately NO offline caching of the app or its data. A stale
 * draft overwriting a published one is worse than an error message, so the
 * desk always talks to the server or tells you it cannot.
 */

self.addEventListener('install', () => {
  // Take over immediately: an old worker serving a new build is a class of bug
  // nobody enjoys diagnosing.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = { title: 'Newsdesk', body: 'Something is waiting.', url: '/now' }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    // A malformed payload still deserves a notification rather than silence.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // PNG on both: Android will not rasterise an SVG for a notification, and
      // the badge is reduced to its alpha channel, so it needs the monochrome
      // glyph rather than the app icon.
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      data: { url: payload.url },
      // Collapse repeats: three drafts arriving should not stack three chimes.
      tag: 'newsdesk-waiting',
      renotify: true,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url ?? '/now'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an open window rather than piling up tabs.
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
