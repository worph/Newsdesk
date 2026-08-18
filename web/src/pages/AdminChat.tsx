import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, streamAdminTurn, type AdminMessage } from '../api'
import { renderMarkdown } from '../markdown'

/**
 * The desk's front page: a conversation with an administrator that holds the
 * desk's own tools.
 *
 * It is a chat and nothing else. A standing panel of counts and health dots
 * lived here first and was taken out: it read as a dashboard someone had put a
 * text box under, and it spent the top of the screen on numbers that are only
 * occasionally the question.
 *
 * The status did not go away, it became `/status` — answered by the desk
 * itself, without inference, so it still works when the administrator cannot.
 * That is what keeps the page honest with every port broken: the one thing
 * worth reading at that moment is a command away and does not depend on the
 * thing that is down.
 *
 * The shape is the one people already know from every other assistant: turns
 * running the width of a narrow column, the composer pinned to the bottom, and
 * the machinery — tool calls, restore points — folded away until asked for.
 */

/** What an empty conversation offers, so the first message is not a blank page. */
const OPENERS = [
  'What is this desk missing?',
  'Write me a charter for a homelab news desk',
  'Add a voice for a dry, technical internal channel',
]

function ThinkingDots() {
  return (
    <span className="flex items-center gap-1" aria-label="Thinking">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 animate-bounce rounded-full bg-desk-400 dark:bg-desk-600"
          style={{ animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </span>
  )
}

/** A call the chat proposed but would not make. Confirmed by id, never by payload. */
function Proposal({ message }: { message: AdminMessage }) {
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState('')

  const confirm = useMutation({
    mutationFn: () => api.confirmAdminChat(message.id, typed),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-chat'] })
      void queryClient.invalidateQueries({ queryKey: ['desk-status'] })
      void queryClient.invalidateQueries({ queryKey: ['config'] })
      void queryClient.invalidateQueries({ queryKey: ['actions'] })
    },
  })

  return (
    <div className="space-y-2.5 rounded-xl border border-amber-300 bg-amber-50/60 px-4 py-3 dark:border-amber-900/70 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Needs your say-so — <span className="font-mono">{message.toolName}</span> changes or deletes
        configuration.
      </p>
      <pre className="overflow-x-auto rounded-lg bg-desk-100/80 px-3 py-2 font-mono text-[11px] dark:bg-desk-900/80">
        {JSON.stringify(message.toolInput ?? {}, null, 2)}
      </pre>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1">
          <span className="text-[11px] text-desk-600 dark:text-desk-400">
            Type <span className="font-mono">{message.confirmWith}</span> to confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="mt-1 w-full rounded-lg border border-amber-300 bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus:border-amber-500 dark:border-amber-900/70"
          />
        </label>
        <button
          onClick={() => confirm.mutate()}
          disabled={typed !== message.confirmWith || confirm.isPending}
          className="rounded-lg bg-desk-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
        >
          {confirm.isPending ? 'Running…' : 'Confirm'}
        </button>
      </div>
      {confirm.error && (
        <p className="text-xs text-red-600">{(confirm.error as Error).message}</p>
      )}
    </div>
  )
}

function Turn({ message }: { message: AdminMessage }) {
  /**
   * Tool calls are the machinery, not the conversation.
   *
   * Folded to one quiet line so a turn reads as prose, and openable because the
   * row is the audit trail — what it did is a click away, never gone.
   */
  if (message.role === 'tool') {
    if (message.confirmWith) return <Proposal message={message} />

    return (
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full bg-desk-100 px-2.5 py-1 text-xs text-desk-600 hover:bg-desk-200 dark:bg-desk-900 dark:text-desk-400 dark:hover:bg-desk-800">
          <span className={message.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600'}>
            {message.ok ? '✓' : '✕'}
          </span>
          <span className="font-mono">{message.toolName}</span>
          {message.versionId !== null && (
            <span className="text-desk-500">· undo {message.versionId}</span>
          )}
          <span className="text-desk-400 group-open:rotate-90">›</span>
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-desk-100/70 px-3 py-2 text-[11px] whitespace-pre-wrap dark:bg-desk-900/70">
          {message.content}
        </pre>
      </details>
    )
  }

  // The user's own words get the bubble; the desk's answer runs the full width
  // of the column, which is what makes a long reply readable.
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-desk-100 px-4 py-2.5 text-[15px] whitespace-pre-wrap dark:bg-desk-900">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div
      className="prose-desk text-[15px] leading-relaxed text-desk-900 dark:text-desk-100"
      // Rendered by markdown-it with html:false, so anything HTML-shaped in a
      // model's answer is escaped and shown rather than injected.
      dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
    />
  )
}

export function AdminChat() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [streamed, setStreamed] = useState<AdminMessage[]>([])
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const conversation = useQuery({ queryKey: ['admin-chat'], queryFn: api.adminChat })

  // Rows from the server, plus anything this turn has streamed in since the
  // last refetch. Deduplicated by id, because the refetch will carry them too.
  const stored = conversation.data?.messages ?? []
  const seen = new Set(stored.map((message) => message.id))
  const messages = [...stored, ...streamed.filter((message) => !seen.has(message.id))]

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, thinking])

  /** Grows with the text, up to the point where it would take the screen. */
  function resize() {
    const node = input.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`
  }

  async function send(text?: string) {
    const message = (text ?? draft).trim()
    if (!message || thinking) return

    setDraft('')
    setError(null)
    requestAnimationFrame(resize)

    /**
     * Commands are answered by the desk itself, not by the administrator.
     *
     * Which is the point of them: `/status` runs no inference, so it still
     * works when the thing you would otherwise ask is the thing that is broken.
     */
    if (message.startsWith('/')) {
      try {
        await api.adminCommand(message)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err))
      } finally {
        void queryClient.invalidateQueries({ queryKey: ['admin-chat'] })
      }
      return
    }

    setThinking(true)
    try {
      await streamAdminTurn(message, {
        onMessage: (written) => setStreamed((current) => [...current, written]),
        onError: (reason) => setError(reason),
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setThinking(false)
      // The rows are the record; drop the local copy and take the server's.
      setStreamed([])
      void queryClient.invalidateQueries({ queryKey: ['admin-chat'] })
      void queryClient.invalidateQueries({ queryKey: ['desk-status'] })
      void queryClient.invalidateQueries({ queryKey: ['config'] })
      void queryClient.invalidateQueries({ queryKey: ['actions'] })
    }
  }

  const clear = useMutation({
    mutationFn: api.clearAdminChat,
    onSuccess: () => {
      setStreamed([])
      void queryClient.invalidateQueries({ queryKey: ['admin-chat'] })
    },
  })

  const inference = conversation.data?.inference
  const unavailable = inference && !inference.available ? inference.reason : null
  const empty = messages.length === 0

  const composer = (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
      className="flex items-end gap-2 rounded-2xl border border-desk-300 bg-desk-50 px-3 py-2 shadow-sm focus-within:border-desk-400 dark:border-desk-700 dark:bg-desk-900"
    >
      <textarea
        ref={input}
        rows={1}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          resize()
        }}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter is a newline — the convention everywhere
          // else, and the one people's hands already have.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void send()
          }
        }}
        placeholder={unavailable ? 'No inference wired — /status still works' : 'Ask for a change, or /status'}
        className="max-h-50 flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-desk-400"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={thinking || !draft.trim() || (Boolean(unavailable) && !draft.trim().startsWith('/'))}
        className="mb-0.5 shrink-0 rounded-xl bg-desk-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-30 dark:bg-desk-100 dark:text-desk-900"
      >
        ↑
      </button>
    </form>
  )

  if (empty) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center gap-6 px-4 pb-16 md:px-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">What should the desk do?</h1>
          <p className="text-sm text-desk-500">
            I can read and change this desk's configuration — charter, voices, stringers, outlets.
            I cannot publish anything.
          </p>
        </div>

        {unavailable && (
          <p className="rounded-xl border border-amber-300 bg-amber-50/60 px-4 py-3 text-center text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            No one to talk to yet: {unavailable}. <span className="font-mono">/status</span> still
            answers.
          </p>
        )}

        {composer}

        <div className="flex flex-wrap justify-center gap-2">
          {OPENERS.map((opener) => (
            <button
              key={opener}
              onClick={() => void send(opener)}
              disabled={Boolean(unavailable)}
              className="rounded-full border border-desk-200 px-3 py-1.5 text-xs text-desk-600 hover:bg-desk-100 disabled:opacity-40 dark:border-desk-800 dark:text-desk-400 dark:hover:bg-desk-900"
            >
              {opener}
            </button>
          ))}
          <button
            onClick={() => void send('/status')}
            className="rounded-full border border-desk-200 px-3 py-1.5 font-mono text-xs text-desk-600 hover:bg-desk-100 dark:border-desk-800 dark:text-desk-400 dark:hover:bg-desk-900"
          >
            /status
          </button>
        </div>
        {error && <p className="text-center text-xs text-red-600">{error}</p>}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 md:px-6">
      <div className="flex justify-end pt-3">
        <button
          onClick={() => clear.mutate()}
          disabled={thinking || clear.isPending}
          className="text-xs text-desk-500 hover:text-desk-700 disabled:opacity-40"
        >
          New conversation
        </button>
      </div>

      <div className="space-y-5 py-4">
        {messages.map((message) => (
          <Turn key={message.id} message={message} />
        ))}
        {thinking && <ThinkingDots />}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div ref={bottom} />
      </div>

      {/*
        Pinned above the phone tab bar, the way the Configuration screen's save
        bar is — a composer that scrolls away is one you have to hunt for.
      */}
      <div className="sticky bottom-[var(--nd-tabbar)] bg-desk-50 pt-2 pb-4 md:bottom-0 dark:bg-desk-950">
        {unavailable && (
          <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
            No inference wired: {unavailable}. <span className="font-mono">/status</span> still answers.
          </p>
        )}
        {composer}
      </div>
    </div>
  )
}
