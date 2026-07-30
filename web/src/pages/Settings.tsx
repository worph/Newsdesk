import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { currentSubscription, pushSupported, subscribeToPush, unsubscribeFromPush } from '../push'

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
          in the Android share sheet — sharing a link files it as an idea.
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
    </div>
  )
}
