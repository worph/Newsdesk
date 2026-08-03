import { useState } from 'react'
import { promptInstall, useInstallState } from '../install'

/**
 * "Install Newsdesk", offered only when it can actually do something.
 *
 * The desk is a phone app in practice — a notification arrives, you approve a
 * draft from wherever you are — and the browser's own install entry is buried
 * three taps deep in a menu most people never open. So the offer belongs in the
 * app, but only when the browser has one to give: on iOS Safari the same button
 * cannot exist at all, and the honest replacement is the two-step instruction.
 */
export function InstallButton({ className = '' }: { className?: string }) {
  const state = useInstallState()
  const [busy, setBusy] = useState(false)

  if (state === 'installed' || state === 'unavailable') return null

  if (state === 'manual') {
    return (
      <p className={`text-sm text-desk-500 ${className}`}>
        On iPhone and iPad: <span className="font-medium text-desk-700 dark:text-desk-300">Share</span>{' '}
        → <span className="font-medium text-desk-700 dark:text-desk-300">Add to Home Screen</span>.
        Safari only — Chrome and Firefox on iOS cannot install a web app.
      </p>
    )
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await promptInstall()
        } finally {
          setBusy(false)
        }
      }}
      className={`inline-flex items-center gap-2 rounded-md bg-desk-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900 ${className}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12" />
        <path d="m7 12 5 5 5-5" />
        <path d="M4 20h16" />
      </svg>
      {busy ? 'Waiting for the browser…' : 'Install Newsdesk'}
    </button>
  )
}
