import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type OAuthSummary } from '../api'
import { currentSubscription, pushSupported, subscribeToPush, unsubscribeFromPush } from '../push'

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

/**
 * Install and notifications. Android and desktop only — iOS is out of scope,
 * so the unsupported case says so plainly rather than offering a button that
 * quietly fails.
 */
export function Settings() {
  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const health = useQuery({ queryKey: ['health'], queryFn: api.health })

  useEffect(() => {
    void currentSubscription().then((subscription) => setSubscribed(Boolean(subscription)))
  }, [])

  const toggle = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (subscribed) {
        await unsubscribeFromPush()
        setSubscribed(false)
        setMessage('This device will no longer be notified.')
      } else {
        const result = await subscribeToPush()
        setSubscribed(result.ok)
        setMessage(result.ok ? 'This device will be notified when a draft is waiting.' : (result.reason ?? null))
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const secure = window.isSecureContext

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-desk-500">Install, notifications, and where the desk does its thinking.</p>
      </header>

      <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
        <h2 className="text-sm font-medium">Notifications</h2>
        <p className="text-sm text-desk-500">
          A push tells you how many drafts are waiting and opens straight to one. Best-effort by
          design — if it cannot go out, the Queue and the Log still tell you everything.
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
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void toggle()}
              disabled={busy || subscribed === null}
              className="rounded-md bg-desk-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
            >
              {busy ? 'Working…' : subscribed ? 'Stop notifying this device' : 'Notify this device'}
            </button>
            {subscribed !== null && (
              <span className="text-xs text-desk-500">
                {subscribed ? 'registered' : 'not registered'}
              </span>
            )}
          </div>
        )}
        {message && <p className="text-xs text-desk-500">{message}</p>}
      </section>

      <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
        <h2 className="text-sm font-medium">Install</h2>
        <p className="text-sm text-desk-500">
          Use your browser’s “Install app” or “Add to home screen”. Once installed, Newsdesk appears
          in the Android share sheet — sharing a link files it as a tip.
        </p>
      </section>

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
