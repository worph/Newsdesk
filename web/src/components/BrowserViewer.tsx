import { useEffect, useRef, useState } from 'react'

/**
 * The desk's browser, live, one tab at a time.
 *
 * A canvas fed by a per-tab screencast rather than a remote desktop, because
 * the desktop was answering a question nobody asked: it showed whichever window
 * happened to be raised, wrapped the destination in Chrome's own tab strip and
 * address bar, and on a phone put the login form somewhere off-screen to the
 * right of a 1280×800 framebuffer.
 *
 * Clicking here is not a lesser kind of clicking. A tap on this canvas and a
 * click inside a VNC session arrive at the page as the same
 * `Input.dispatchMouseEvent` — so what the viewer owes the operator is
 * *seeing*, and that is what the controls below are for.
 */

export interface ScreencastTarget {
  /** Where the frames come from and the input goes back. */
  socket: string
  /** Where to ask for an element's bounds, so we can point the view at it. */
  frame: string
}

interface Metadata {
  pageWidth: number
  pageHeight: number
  scrollOffsetX: number
  scrollOffsetY: number
}

/**
 * Canvas coordinates to page coordinates.
 *
 * The one piece of arithmetic that has to be right: get it wrong and every
 * click lands somewhere the operator did not press. Exported so it can be
 * tested without a browser.
 */
export function toPageCoords(
  point: { x: number; y: number },
  canvas: { width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } {
  if (canvas.width === 0 || canvas.height === 0) return { x: 0, y: 0 }
  return {
    x: (point.x / canvas.width) * page.width,
    y: (point.y / canvas.height) * page.height,
  }
}

export function BrowserViewer({
  target,
  title,
  hint,
  focusSelector = 'input,textarea,[contenteditable="true"]',
  onBreakGlass,
  onLost,
}: {
  target: ScreencastTarget
  title: string
  hint?: string
  /**
   * What "Find the field" should look for. The caller knows better than this
   * component does — the sign-in view wants the login form, a staged post
   * wants the composer — and a wrong guess sends the view somewhere useless.
   */
  focusSelector?: string
  /** Offered, not taken: the desktop still exists for what a tab cannot show. */
  onBreakGlass?: () => void
  /**
   * The tab went while we were watching it — reaped, or taken by a browser
   * restart. Told so the page can open a fresh one rather than leaving stale
   * pixels on screen with nothing behind them.
   */
  onLost?: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const metaRef = useRef<Metadata | null>(null)
  const keyboardRef = useRef<HTMLInputElement>(null)
  const shell = useRef<HTMLDivElement>(null)
  /** Whether we have asked the page to lay itself out for this screen yet. */
  const sizedRef = useRef(false)

  const [status, setStatus] = useState<'connecting' | 'live' | 'gone'>('connecting')

  useEffect(() => {
    const url = new URL(target.socket, window.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url.toString())
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket

    sizedRef.current = false
    socket.onopen = () => setStatus('live')
    socket.onclose = (event) => {
      setStatus('gone')
      // 4410 is this server saying the tab is no longer open; any close after
      // frames were flowing means the same thing in practice.
      if (event.code === 4410 || sizedRef.current) onLost?.()
    }
    socket.onerror = () => setStatus('gone')

    socket.onmessage = async (event) => {
      // Text is metadata, binary is a frame. Metadata arrives only when it
      // changes, so it is cheap to keep and never worth redrawing on.
      if (typeof event.data === 'string') {
        const meta = JSON.parse(event.data) as Metadata & { type: string }
        metaRef.current = meta
        return
      }

      const canvas = canvasRef.current
      if (!canvas) return
      const bitmap = await createImageBitmap(new Blob([event.data], { type: 'image/jpeg' }))
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      bitmap.close()

      /**
       * Ask for our layout once the canvas has a real size.
       *
       * `onopen` is too early — the element has no height until something has
       * been drawn into it — and a ResizeObserver does not reliably fire for a
       * width that never changed. The first frame is the first moment the
       * measurement is worth taking, so take it then.
       */
      if (!sizedRef.current) {
        sizedRef.current = true
        reportViewport()
      }
    }

    return () => socket.close()
  }, [target.socket])

  /**
   * Tell the page how big the screen looking at it is.
   *
   * This is what makes the view responsive rather than merely small: the
   * destination lays itself out for a phone, so its own mobile styles apply,
   * fields become finger-sized and the frame comes back at 1:1. Without it a
   * 1280-wide page scaled into 350 leaves a 36px input about ten pixels tall,
   * and aiming at it is luck.
   */
  const reportViewport = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1) return
    /**
     * Width from the canvas, height from the window — never from the canvas.
     * The canvas has no height until a frame arrives, and the frame's height
     * comes from the viewport we asked for, so taking both from the element
     * feeds back on itself and settles on whatever the first guess was.
     */
    const available = document.fullscreenElement
      ? window.innerHeight
      : Math.round(window.innerHeight * 0.72)
    send({
      type: 'viewport',
      width: Math.round(rect.width),
      height: Math.max(360, available),
      deviceScaleFactor: window.devicePixelRatio || 1,
      mobile: window.matchMedia('(pointer: coarse)').matches,
    })
  }

  // Rotate the phone, or drag the window, and the page should follow.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => reportViewport())
    observer.observe(canvas)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.socket])

  /** Where on the page did that land? */
  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    const meta = metaRef.current
    if (!canvas || !meta) return null
    const rect = canvas.getBoundingClientRect()
    return toPageCoords(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      { width: rect.width, height: rect.height },
      { width: meta.pageWidth, height: meta.pageHeight },
    )
  }

  const send = (message: unknown) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  const onPointer = (action: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    const point = pagePoint(event)
    if (!point) return
    if (action === 'mousePressed') {
      // Focus the hidden input so a phone raises its keyboard; a canvas alone
      // never will, which is why typing into a remote page usually cannot be
      // done from a phone at all.
      keyboardRef.current?.focus()
    }
    send({ type: 'mouse', action, ...point })
  }

  /** Point the view at something, by asking the desk where it is. */
  const zoomTo = async (selector: string) => {
    const response = await fetch(target.frame, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector }),
    })
    if (!response.ok) return
    const box = (await response.json()) as { x: number; y: number; width: number; height: number }
    // Scroll the page so the element is in view; the frame is already 1:1.
    send({ type: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: box.y - 80 })
  }

  const expand = () => {
    const node = shell.current
    if (!node) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void node.requestFullscreen?.()
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={expand}
          className="rounded-md border border-desk-300 px-2.5 py-1 text-desk-600 hover:bg-desk-100 dark:border-desk-700 dark:text-desk-400 dark:hover:bg-desk-800"
        >
          Full screen
        </button>

        {/*
          Only possible because the desk drives this browser as well as showing
          it: ask where a thing is, then put it on screen. On a phone that is
          the difference between reading a post and hunting for it.
        */}
        <button
          onClick={() => void zoomTo(focusSelector)}
          className="rounded-md border border-desk-300 px-2.5 py-1 text-desk-600 hover:bg-desk-100 dark:border-desk-700 dark:text-desk-400 dark:hover:bg-desk-800"
        >
          Find the field
        </button>

        <span className={status === 'gone' ? 'text-amber-700 dark:text-amber-400' : 'text-desk-500'}>
          {status === 'live'
            ? 'live'
            : status === 'connecting'
              ? 'connecting…'
              : 'the tab went — reopening'}
        </span>

        {onBreakGlass && (
          <button onClick={onBreakGlass} className="ml-auto text-desk-500 underline underline-offset-2">
            Something looks wrong
          </button>
        )}
      </div>

      {hint && <p className="text-xs text-desk-500">{hint}</p>}

      <div
        ref={shell}
        className="overflow-auto rounded-lg border border-desk-200 bg-black dark:border-desk-800"
      >
        <canvas
          ref={canvasRef}
          aria-label={title}
          /**
           * A real mousedown moves focus as its default action, and a canvas
           * is not focusable — so the browser was blurring the hidden input we
           * had just focused and dropping focus on `body`. Clicks still
           * reached the page; every keystroke after them went nowhere, which
           * is indistinguishable from a keyboard that does not transmit.
           *
           * Synthetic events carry no default action, which is why this only
           * ever failed for real people.
           */
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={onPointer('mousePressed')}
          onPointerUp={onPointer('mouseReleased')}
          onPointerMove={(event) => {
            if (event.buttons === 0) return
            onPointer('mouseMoved')(event)
          }}
          onWheel={(event) => {
            const point = pagePoint(event)
            if (point) send({ type: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY })
          }}
          className="block h-auto w-full touch-none"
        />
      </div>

      {/*
        Off-screen rather than hidden: a display:none input cannot be focused,
        and focus is the only thing that summons a phone's keyboard.
      */}
      <input
        ref={keyboardRef}
        aria-label={`type into ${title}`}
        className="absolute left-[-9999px] h-px w-px opacity-0"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(event) => {
          // Let the browser handle its own paste shortcut — it arrives as a
          // paste event below, with the clipboard attached. Forwarding the
          // keystroke instead would type a literal "v".
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return
          event.preventDefault()

          const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey
          const modifiers =
            (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
          send({
            type: 'key',
            action: printable ? 'char' : 'keyDown',
            key: event.key,
            code: event.code,
            text: printable ? event.key : undefined,
            modifiers,
          })
        }}
        onPaste={(event) => {
          // One insert rather than a character each: it is what the page's own
          // paste handling expects, and it keeps newlines.
          event.preventDefault()
          const text = event.clipboardData.getData('text')
          if (text) send({ type: 'text', text })
        }}
      />
    </div>
  )
}
