import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api'

/**
 * The four groups from IMPLEMENTATION.md section 7. Screens that are not built
 * yet are shown disabled rather than hidden — the shape of the app should be
 * legible even where it is unfinished.
 */
const NAV = [
  { group: 'Desk', items: [
    { to: '/now', label: 'Needs you', ready: true },
    { to: '/queue', label: 'Queue', ready: true },
    { to: '/calendar', label: 'Calendar', ready: true },
    { to: '/compose', label: 'Write', ready: true },
    { to: '/tips', label: 'Tip line', ready: true },
  ] },
  { group: 'Archive', items: [{ to: '/stories', label: 'Stories', ready: true }] },
  { group: 'Tuning', items: [{ to: '/config', label: 'Configuration', ready: true }] },
  { group: 'Operations', items: [
    { to: '/wire', label: 'Wire', ready: true },
    { to: '/log', label: 'Log', ready: true },
    { to: '/settings', label: 'Settings', ready: true },
  ] },
]

/**
 * How much is standing at the gate, wherever you are in the app.
 *
 * Counted by the same endpoint the "Needs you" screen renders, so the badge and
 * the list can never disagree — a badge saying 3 over a screen showing 2 is
 * worse than no badge. It goes amber when something is actually held up, which
 * is the difference between a backlog and a thing to do now.
 */
function ActionBadge() {
  const { data } = useQuery({ queryKey: ['actions'], queryFn: api.listActions, refetchInterval: 20_000 })

  const waiting = data?.total ?? 0
  if (waiting === 0) return null

  const held = (data?.overdue ?? 0) > 0
  return (
    <span
      className={`ml-2 rounded-full px-1.5 py-0.5 font-mono text-[11px] ${
        held
          ? 'bg-amber-500/20 text-amber-700 dark:text-amber-400'
          : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      }`}
    >
      {waiting}
    </span>
  )
}

function HealthPill() {
  const { data } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 })
  if (!data) return null

  const bad = data.endpoints.filter((e) => e.status !== 'ok')
  const tone = bad.length
    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
    : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
  const label = bad.length
    ? `${bad.length} endpoint${bad.length > 1 ? 's' : ''} unreachable`
    : data.endpoints.length
      ? 'all endpoints reachable'
      : 'no endpoints configured'

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`} title={bad.map((b) => `${b.name}: ${b.detail ?? b.status}`).join('\n')}>
      {label}
    </span>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  // Served from the cache App already filled. False when a gate — or a dev
  // stack with the password off — is what signed you in, and clearing the
  // cookie would change nothing.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })

  async function signOut() {
    await api.logout()
    navigate('/login')
  }

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <header className="flex items-center gap-3 border-b border-desk-200 px-4 py-3 md:hidden dark:border-desk-800">
        <span className="font-semibold tracking-tight">Newsdesk</span>
        <div className="ml-auto flex items-center gap-2">
          <HealthPill />
        </div>
      </header>

      <nav className="shrink-0 border-desk-200 md:w-60 md:border-r dark:border-desk-800">
        <div className="hidden items-center gap-2 px-5 py-5 md:flex">
          <span className="text-lg font-semibold tracking-tight">Newsdesk</span>
        </div>

        <div className="flex gap-1 overflow-x-auto px-3 py-2 md:block md:space-y-5 md:px-3 md:py-0">
          {NAV.map((section) => (
            <div key={section.group}>
              <div className="hidden px-2 pb-1 text-xs font-medium tracking-wide text-desk-500 uppercase md:block">
                {section.group}
              </div>
              {section.items.map((item) =>
                item.ready ? (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `block rounded-md px-3 py-2 text-sm whitespace-nowrap ${
                        isActive
                          ? 'bg-desk-200 font-medium dark:bg-desk-800'
                          : 'text-desk-600 hover:bg-desk-100 dark:text-desk-300 dark:hover:bg-desk-900'
                      }`
                    }
                  >
                    {item.label}
                    {item.to === '/now' && <ActionBadge />}
                  </NavLink>
                ) : (
                  <span
                    key={item.to}
                    title="Not built yet"
                    className="block rounded-md px-3 py-2 text-sm whitespace-nowrap text-desk-400 dark:text-desk-600"
                  >
                    {item.label}
                  </span>
                ),
              )}
            </div>
          ))}
        </div>

        <div className="hidden px-5 py-4 md:block">
          {me?.passwordRequired === false ? (
            <span className="text-xs text-desk-500">signed in without a password</span>
          ) : (
            <button onClick={signOut} className="text-sm text-desk-500 hover:underline">
              Sign out
            </button>
          )}
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        <div className="hidden justify-end px-6 py-4 md:flex">
          <HealthPill />
        </div>
        {children}
      </main>
    </div>
  )
}
