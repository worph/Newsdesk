import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type OAuthSummary } from '../api'
import { InstallButton } from '../components/InstallButton'
import { useInstallState } from '../install'
import { deviceRegistration, pushSupported, subscribeToPush, unsubscribeFromPush } from '../push'

const CONNECTION_LABEL: Record<OAuthSummary['status'], string> = {
  connected: 'connected',
  expired: 'expired — reconnect',
  pending: 'waiting for authorization',
  disconnected: 'not connected',
}

/**
 * Endpoints that authenticate over OAuth. The desk cannot complete an
 * authorization code flow by itself, so this is where a human lends it a
 * browser once; the refresh token it comes back with is what keeps delivery
 * working unattended afterwards.
 */
function EndpointConnections() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const endpoints = useQuery({ queryKey: ['mcp-endpoints'], queryFn: api.listMcpEndpoints })
  // Shared with the section above; react-query serves both from one fetch.
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })

  // The popup posts back when the callback page loads, which is the earliest
  // moment the new state is worth reading.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if ((event.data as { type?: string } | null)?.type !== 'newsdesk-oauth') return
      void endpoints.refetch()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [endpoints])

  const connect = async (id: string) => {
    setBusy(id)
    setError(null)
    // Opened synchronously, before any await: a popup opened later is not a
    // response to the click any more and browsers block it.
    const popup = window.open('about:blank', 'newsdesk-oauth', 'width=560,height=720')
    try {
      const result = await api.startOAuth(id)
      if (result.status === 'connected' || !result.authorizationUrl) {
        popup?.close()
        await endpoints.refetch()
        return
      }
      if (popup) popup.location.href = result.authorizationUrl
      else window.location.href = result.authorizationUrl
    } catch (err) {
      popup?.close()
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await api.forgetOAuth(id)
      await endpoints.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // An endpoint belongs here only if it actually authenticates this way:
  // either it already has a connection, or it answered 401. Offering
  // "Connect" on an endpoint that takes a static token — or none — would be a
  // button that cannot do anything but fail.
  const unauthorized = new Set(
    (health.data?.endpoints ?? []).filter((e) => e.status === 'unauthorized').map((e) => e.id),
  )
  const rows = (endpoints.data?.endpoints ?? []).filter(
    (endpoint) => endpoint.oauth.status !== 'disconnected' || unauthorized.has(endpoint.id),
  )
  if (rows.length === 0) return null

  return (
    <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
      <h2 className="text-sm font-medium">Endpoint connections</h2>
      <p className="text-sm text-desk-500">
        Endpoints that ask for OAuth rather than a token. Connecting opens the endpoint’s login in a
        window; the desk keeps the connection alive on its own from then on.
      </p>
      <ul className="space-y-2">
        {rows.map((endpoint) => (
          <li key={endpoint.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span
              aria-hidden
              className={`size-2 rounded-full ${
                endpoint.oauth.status === 'connected' ? 'bg-emerald-500' : 'bg-desk-400'
              }`}
            />
            <span className="font-medium">{endpoint.name}</span>
            <span className="text-xs text-desk-500">{CONNECTION_LABEL[endpoint.oauth.status]}</span>
            <button
              type="button"
              disabled={busy === endpoint.id}
              onClick={() => void connect(endpoint.id)}
              className="rounded border border-desk-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-desk-700"
            >
              {endpoint.oauth.status === 'connected' ? 'Reconnect' : 'Connect'}
            </button>
            {endpoint.oauth.status !== 'disconnected' && (
              <button
                type="button"
                disabled={busy === endpoint.id}
                onClick={() => void disconnect(endpoint.id)}
                className="rounded border border-desk-300 px-2 py-0.5 text-xs disabled:opacity-50 dark:border-desk-700"
              >
                Disconnect
              </button>
            )}
            {endpoint.oauth.warning && (
              <span className="w-full text-xs text-amber-600">{endpoint.oauth.warning}</span>
            )}
          </li>
        ))}
      </ul>
      {endpoints.data?.redirectUri && (
        <p className="text-xs text-desk-500">
          Redirect URI: <span className="font-mono">{endpoints.data.redirectUri}</span>
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  )
}

/** What a test send actually did, said plainly enough to act on. */
function testOutcome(result: { subscribers: number; delivered: number; dropped: number; failed: number }): string {
  if (result.subscribers === 0) {
    return 'The desk has no registered device. Register this one above, then test again.'
  }
  if (result.delivered > 0) {
    const others = result.subscribers - result.delivered
    return `Sent to ${result.delivered} device${result.delivered === 1 ? '' : 's'}${
      others > 0 ? `; ${others} could not be reached` : ''
    }. If nothing appeared, check that notifications are allowed for this site in your browser and system settings.`
  }
  if (result.dropped > 0) {
    return `The push service refused ${result.dropped} stale registration${
      result.dropped === 1 ? '' : 's'
    }, which have been removed. Register this device again above.`
  }
  return `Nothing was delivered: ${result.failed} send${result.failed === 1 ? '' : 's'} failed. The Log has the reason.`
}

/**
 * Install and notifications. Android and desktop only — iOS is out of scope,
 * so the unsupported case says so plainly rather than offering a button that
 * quietly fails.
 *
 * Notifications are how this desk asks for attention, so this section has to be
 * honest about them: whether the browser is registered, whether the desk agrees,
 * and — the only real proof — whether a notification actually arrives.
 */
/**
 * The zone a posting window is written in.
 *
 * Every time in the database is UTC and stays that way; this only decides what
 * "09:00–18:00" in an outlet's cadence means. It defaults to UTC rather than to
 * the container's clock, so an unconfigured desk is plainly wrong rather than
 * subtly wrong in a way that changes on redeploy.
 */
function TimezoneSection() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<string | null>(null)
  const { data } = useQuery({ queryKey: ['timezone'], queryFn: api.getTimezone })

  const save = useMutation({
    mutationFn: (timezone: string) => api.setTimezone(timezone),
    onSuccess: () => {
      setDraft(null)
      void queryClient.invalidateQueries({ queryKey: ['timezone'] })
      // Every proposed and displayed time is derived from this.
      void queryClient.invalidateQueries({ queryKey: ['calendar'] })
      void queryClient.invalidateQueries({ queryKey: ['publication'] })
    },
  })

  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  const value = draft ?? data?.timezone ?? ''

  return (
    <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
      <h2 className="text-sm font-medium">Timezone</h2>
      <p className="text-sm text-desk-500">
        What an outlet’s posting window means. Stored times stay UTC — this only decides which
        clock “09:00” is read on.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Europe/Paris"
          spellCheck={false}
          className="rounded-md border border-desk-300 bg-transparent px-2 py-1 text-sm dark:border-desk-700"
        />
        <button
          onClick={() => draft && save.mutate(draft.trim())}
          disabled={!draft || draft.trim() === data?.timezone || save.isPending}
          className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {here && here !== data?.timezone && (
          <button
            onClick={() => setDraft(here)}
            className="text-xs text-desk-500 hover:text-desk-700"
          >
            use this browser’s ({here})
          </button>
        )}
      </div>
      {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
    </section>
  )
}

/**
 * Install, said in whatever terms this browser actually supports.
 *
 * The button only exists where `beforeinstallprompt` fired, so this section has
 * to carry the other three cases too: already installed, iOS (share sheet, and
 * only from Safari), and a browser that will not install a web app at all. The
 * old copy told everyone to go and find a menu item, which is wrong in three of
 * the four.
 */
function InstallSection() {
  const state = useInstallState()

  return (
    <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
      <h2 className="text-sm font-medium">Install</h2>
      <p className="text-sm text-desk-500">
        Installed, the desk gets its own icon and window, and appears in the Android share sheet —
        sharing a link files it as a tip.
      </p>

      {state === 'installed' ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          You are using the installed app.
        </p>
      ) : state === 'unavailable' ? (
        <p className="text-sm text-desk-500">
          This browser has not offered an install. Chrome, Edge and Samsung Internet do, over HTTPS;
          Firefox on desktop does not.
        </p>
      ) : (
        <InstallButton />
      )}
    </section>
  )
}

export function Settings() {
  const [registration, setRegistration] = useState<{ registered: boolean; stale: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const push = useQuery({ queryKey: ['push-status'], queryFn: api.pushStatus })

  const serverKey = push.data?.publicKey
  useEffect(() => {
    if (!serverKey) return
    void deviceRegistration(serverKey).then(setRegistration)
  }, [serverKey])

  const refresh = async () => {
    const status = await push.refetch()
    const key = status.data?.publicKey
    if (key) setRegistration(await deviceRegistration(key))
  }

  const toggle = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (registration?.registered && !registration.stale) {
        await unsubscribeFromPush()
        setMessage('This device will no longer be notified.')
      } else {
        // A stale registration has to go before a new one can be made: the
        // browser hands back the existing subscription otherwise, key and all.
        if (registration?.stale) await unsubscribeFromPush()
        const result = await subscribeToPush()
        setMessage(
          result.ok
            ? 'Registered. Send a test notification to confirm it arrives.'
            : (result.reason ?? null),
        )
      }
      await refresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage(testOutcome(await api.testPush()))
      await refresh()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const secure = window.isSecureContext
  const devices = push.data?.devices ?? 0

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-desk-500">Install, notifications, and where the desk does its thinking.</p>
      </header>

      <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
        <h2 className="text-sm font-medium">Notifications</h2>
        <p className="text-sm text-desk-500">
          A push when a story reaches the placement queue, and another when a draft is ready to
          approve. Each says how many are waiting and opens straight to the one that triggered it.
          Best-effort by design — if it cannot go out, the Queue still tells you everything.
        </p>

        {!pushSupported() ? (
          <p className="text-sm text-desk-500">
            This browser does not support web push. Android and desktop Chrome or Firefox do; iOS
            does not, and is out of scope.
          </p>
        ) : !secure ? (
          <p className="text-sm text-desk-500">
            Push needs a secure context. Open the desk over HTTPS (or on localhost) to register.
          </p>
        ) : (
          <>
            {/* The one failure the browser cannot see by itself. */}
            {registration?.stale && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                This device is registered against a key the desk no longer holds — which is what
                re-creating the database does. Nothing sent to it can arrive. Register it again.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => void toggle()}
                disabled={busy || registration === null}
                className="rounded-md bg-desk-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
              >
                {busy
                  ? 'Working…'
                  : registration?.stale
                    ? 'Register this device again'
                    : registration?.registered
                      ? 'Stop notifying this device'
                      : 'Notify this device'}
              </button>

              <button
                onClick={() => void test()}
                disabled={busy}
                title="Sends a real notification through the whole path, and reports where it stopped"
                className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
              >
                Send a test notification
              </button>

              {registration && (
                <span className="text-xs text-desk-500">
                  {registration.stale
                    ? 'this device: stale'
                    : registration.registered
                      ? 'this device: registered'
                      : 'this device: not registered'}
                  {' · '}
                  {devices === 0
                    ? 'the desk knows no device'
                    : `the desk knows ${devices} device${devices === 1 ? '' : 's'}`}
                </span>
              )}
            </div>
          </>
        )}
        {message && <p className="text-xs text-desk-500">{message}</p>}
      </section>

      <TimezoneSection />

      <InstallSection />

      <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
        <h2 className="text-sm font-medium">Inference and delivery</h2>
        <p className="text-sm text-desk-500">
          Both live outside the desk, behind the endpoints below. Configure them in Configuration.
        </p>
        <ul className="space-y-1">
          {(health.data?.endpoints ?? []).map((endpoint) => (
            <li key={endpoint.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span
                aria-hidden
                className={`size-2 rounded-full ${
                  endpoint.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500'
                }`}
              />
              <span className="font-medium">{endpoint.name}</span>
              <span className="font-mono text-xs text-desk-500">{endpoint.url}</span>
              <span className="text-xs text-desk-500">
                {endpoint.status}
                {endpoint.latencyMs !== undefined && ` · ${endpoint.latencyMs}ms`}
                {endpoint.detail && ` · ${endpoint.detail}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <EndpointConnections />
    </div>
  )
}
