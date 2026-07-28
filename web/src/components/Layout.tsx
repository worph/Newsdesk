import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api'

/**
 * The four groups from IMPLEMENTATION.md section 7. Only Config and Log exist
 * yet; the desk screens arrive with the director and the review surface, so
 * they are shown disabled rather than hidden — the shape of the app should be
 * legible from the first commit.
 */
const NAV = [
  { group: 'Desk', items: [
    { to: '/queue', label: 'Queue', ready: false },
    { to: '/ideas', label: 'Idea box', ready: true },
  ] },
  { group: 'Archive', items: [{ to: '/stories', label: 'Stories', ready: false }] },
  { group: 'Tuning', items: [{ to: '/config', label: 'Configuration', ready: true }] },
  { group: 'Operations', items: [
    { to: '/inbox', label: 'Inbox', ready: true },
    { to: '/log', label: 'Log', ready: false },
  ] },
]

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
          <button onClick={signOut} className="text-sm text-desk-500 hover:underline">
            Sign out
          </button>
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
