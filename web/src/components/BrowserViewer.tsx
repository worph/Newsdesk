import { useRef, useState } from 'react'

/**
 * The desk's browser, embedded.
 *
 * Two things make this usable rather than merely present, and both come from
 * the same fact: the remote desktop is a fixed size and this frame is not.
 *
 *   **fit** scales the whole desktop into the frame. Nothing is cut off, and
 *   text is small in proportion to how much bigger the desktop is.
 *   **actual size** shows real pixels and scrolls. Text is exactly as legible
 *   as it is on a normal screen, which is what you want when reading a post or
 *   typing a password.
 *
 * Full screen is the other half of it: at 70% of a laptop window a 1440-wide
 * desktop is always going to be small, and the browser's own full-screen mode
 * costs nothing and fixes it outright.
 */

export type ViewerFit = 'fit' | 'actual'

/**
 * noVNC reads its options from the query string. `resize=scale` fits the
 * desktop to the frame; `resize=off` with clipping gives real pixels and
 * scrollbars.
 */
export function viewerUrl(base: string, fit: ViewerFit): string {
  const url = new URL(base, window.location.origin)
  url.searchParams.set('resize', fit === 'fit' ? 'scale' : 'off')
  url.searchParams.set('view_clip', fit === 'fit' ? 'false' : 'true')
  return `${url.pathname}${url.search}`
}

export function BrowserViewer({
  url,
  title,
  hint,
}: {
  url: string
  title: string
  /** What this frame is for, said once above it. */
  hint?: string
}) {
  const [fit, setFit] = useState<ViewerFit>('actual')
  const shell = useRef<HTMLDivElement>(null)

  const expand = () => {
    const node = shell.current
    if (!node) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void node.requestFullscreen?.()
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="inline-flex overflow-hidden rounded-md border border-desk-300 dark:border-desk-700">
          {(['actual', 'fit'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFit(mode)}
              className={`px-2.5 py-1 ${
                fit === mode
                  ? 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
                  : 'text-desk-600 hover:bg-desk-100 dark:text-desk-400 dark:hover:bg-desk-800'
              }`}
            >
              {mode === 'actual' ? 'Actual size' : 'Fit'}
            </button>
          ))}
        </div>

        <button
          onClick={expand}
          className="rounded-md border border-desk-300 px-2.5 py-1 text-desk-600 hover:bg-desk-100 dark:border-desk-700 dark:text-desk-400 dark:hover:bg-desk-800"
        >
          Full screen
        </button>

        {/*
          Nothing crosses from your clipboard into a remote desktop by itself —
          the frame is a picture, and ⌘V lands in your own browser. noVNC's
          clipboard panel is the way across, and nobody finds it unprompted.
        */}
        <span className="text-desk-500">
          To paste: open the noVNC toolbar (the tab on the left edge of the frame) → Clipboard →
          paste there → then press Ctrl+V in the page.
        </span>
      </div>

      {hint && <p className="text-xs text-desk-500">{hint}</p>}

      <div
        ref={shell}
        className="overflow-hidden rounded-lg border border-desk-200 bg-black dark:border-desk-800"
      >
        <iframe
          // Remounts on a fit change so noVNC re-reads its settings.
          key={fit}
          src={viewerUrl(url, fit)}
          title={title}
          className="h-[78vh] w-full border-0 bg-black"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  )
}
