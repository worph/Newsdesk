import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { InstallButton } from './InstallButton'

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

function Icon({ path }: { path: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path}
    </svg>
  )
}

/**
 * What a thumb can reach, in the order a phone actually uses the desk: what is
 * waiting, the backlog behind it, and the two ways to put something in.
 *
 * Everything else lives one tap further away, in the sheet — a phone screen
 * cannot show ten destinations without becoming a menu instead of an app.
 */
const TABS = [
  {
    to: '/now',
    label: 'Needs you',
    badge: true,
    icon: <Icon path={<><path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>} />,
  },
  {
    to: '/queue',
    label: 'Queue',
    icon: <Icon path={<><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>} />,
  },
  {
    to: '/compose',
    label: 'Write',
    icon: <Icon path={<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>} />,
  },
  {
    to: '/tips',
    label: 'Tip line',
    icon: <Icon path={<><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>} />,
  },
]

const MORE_ICON = <Icon path={<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>} />

/** Destinations that only exist behind "More" — used to light that tab up. */
const SECONDARY = NAV.flatMap((section) => section.items)
  .map((item) => item.to)
  .filter((to) => !TABS.some((tab) => tab.to === to))

/**
 * How much is standing at the gate, wherever you are in the app.
 *
 * Counted by the same endpoint the "Needs you" screen renders, so the badge and
 * the list can never disagree — a badge saying 3 over a screen showing 2 is
 * worse than no badge. It goes amber when something is actually held up, which
 * is the difference between a backlog and a thing to do now.
 */
function useActionCount() {
  const { data } = useQuery({ queryKey: ['actions'], queryFn: api.listActions, refetchInterval: 20_000 })
  return { waiting: data?.total ?? 0, held: (data?.overdue ?? 0) > 0 }
}

function ActionBadge() {
  const { waiting, held } = useActionCount()
  if (waiting === 0) return null

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

/** The same count as a dot on a tab icon, where there is no room for a word. */
function TabBadge() {
  const { waiting, held } = useActionCount()
  if (waiting === 0) return null

  return (
    <span
      className={`absolute -top-1 left-1/2 ml-1.5 min-w-4 rounded-full px-1 text-center font-mono text-[10px] leading-4 ${
        held ? 'bg-amber-500 text-amber-950' : 'bg-emerald-500 text-emerald-950'
      }`}
    >
      {waiting > 9 ? '9+' : waiting}
    </span>
  )
}

function HealthPill({ compact = false }: { compact?: boolean }) {
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

  // On a phone header the sentence is most of the width and says nothing new
  // when it is good news, so only the trouble keeps its words.
  if (compact && !bad.length) {
    return <span className="size-2.5 shrink-0 rounded-full bg-emerald-500" title={label} />
  }

  return (
    <span
      className={`truncate rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}
      title={bad.map((b) => `${b.name}: ${b.detail ?? b.status}`).join('\n')}
    >
      {label}
    </span>
  )
}

/** The full nav, shown in the sidebar on a desk and in the sheet on a phone. */
function NavGroups({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV.map((section) => (
        <div key={section.group}>
          <div className="px-2 pb-1 text-xs font-medium tracking-wide text-desk-500 uppercase">
            {section.group}
          </div>
          {section.items.map((item) =>
            item.ready ? (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2.5 text-sm whitespace-nowrap md:py-2 ${
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
                className="block rounded-md px-3 py-2.5 text-sm whitespace-nowrap text-desk-400 md:py-2 dark:text-desk-600"
              >
                {item.label}
              </span>
            ),
          )}
        </div>
      ))}
    </>
  )
}

/** Everything the tab bar could not fit, plus the things you do once. */
function MoreSheet({ onClose, onSignOut, canSignOut }: { onClose: () => void; onSignOut: () => void; canSignOut: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // The sheet scrolls on its own; the page behind it must not, or a flick
    // near the edge scrolls the wrong thing.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  // Stops short of the tab bar rather than covering it: "More" stays lit and
  // stays a toggle, so the gesture that opened the sheet also closes it.
  return (
    <div
      className="fixed inset-x-0 top-0 bottom-[var(--nd-tabbar)] z-50 md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="More"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="absolute inset-x-0 bottom-0 max-h-full overflow-y-auto rounded-t-2xl border-t border-desk-200 bg-desk-50 pb-4 dark:border-desk-800 dark:bg-desk-950">
        <div className="sticky top-0 flex justify-center bg-desk-50 pt-2.5 pb-1 dark:bg-desk-950">
          <span aria-hidden className="h-1 w-10 rounded-full bg-desk-300 dark:bg-desk-700" />
        </div>

        <div className="space-y-4 px-3 pt-2">
          <NavGroups onNavigate={onClose} />

          <div className="space-y-3 border-t border-desk-200 px-2 pt-4 dark:border-desk-800">
            <InstallButton />
            {canSignOut ? (
              <button onClick={onSignOut} className="block text-sm text-desk-500 hover:underline">
                Sign out
              </button>
            ) : (
              <span className="block text-xs text-desk-500">signed in without a password</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)

  // Served from the cache App already filled. False when a gate — or a dev
  // stack with the password off — is what signed you in, and clearing the
  // cookie would change nothing.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })

  // A back gesture should close the sheet rather than leave it floating over a
  // screen it no longer belongs to.
  useEffect(() => setMoreOpen(false), [pathname])

  async function signOut() {
    await api.logout()
    navigate('/login')
  }

  const moreActive = SECONDARY.some((to) => pathname === to || pathname.startsWith(`${to}/`))

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      {/*
        Opaque rather than blurred, like the tab bar at the other edge: two
        translucent bars over one scroll is a lot of compositing for a phone to
        do on every frame, and text over a blur is the first thing to go soft.
      */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-desk-200 bg-desk-50 px-4 pt-[calc(0.75rem+var(--nd-safe-top))] pb-3 md:hidden dark:border-desk-800 dark:bg-desk-950">
        <span className="font-semibold tracking-tight">Newsdesk</span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <HealthPill compact />
        </div>
      </header>

      <nav className="hidden shrink-0 border-desk-200 md:block md:w-60 md:border-r dark:border-desk-800">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="text-lg font-semibold tracking-tight">Newsdesk</span>
        </div>

        <div className="space-y-5 px-3">
          <NavGroups />
        </div>

        <div className="space-y-3 px-5 py-4">
          <InstallButton />
          {me?.passwordRequired === false ? (
            <span className="block text-xs text-desk-500">signed in without a password</span>
          ) : (
            <button onClick={signOut} className="block text-sm text-desk-500 hover:underline">
              Sign out
            </button>
          )}
        </div>
      </nav>

      {/* The tab bar is fixed, so the page has to end above it rather than under it. */}
      <main className="min-w-0 flex-1 pb-[var(--nd-tabbar)] md:pb-0">
        <div className="hidden justify-end px-6 py-4 md:flex">
          <HealthPill />
        </div>
        {children}
      </main>

      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-desk-200 bg-desk-50 pb-[var(--nd-safe-bottom)] md:hidden dark:border-desk-800 dark:bg-desk-950"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] ${
                isActive && !moreOpen
                  ? 'text-desk-900 dark:text-desk-100'
                  : 'text-desk-500 dark:text-desk-400'
              }`
            }
          >
            <span className="relative">
              {tab.icon}
              {tab.badge && <TabBadge />}
            </span>
            {tab.label}
          </NavLink>
        ))}

        <button
          type="button"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] ${
            moreOpen || moreActive ? 'text-desk-900 dark:text-desk-100' : 'text-desk-500 dark:text-desk-400'
          }`}
        >
          {MORE_ICON}
          More
        </button>
      </nav>

      {moreOpen && (
        <MoreSheet
          onClose={() => setMoreOpen(false)}
          onSignOut={signOut}
          canSignOut={me?.passwordRequired !== false}
        />
      )}
    </div>
  )
}
