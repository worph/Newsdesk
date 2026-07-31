import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api'

/**
 * The assistant, beside the document rather than in place of it.
 *
 * `CopyDesk` itself holds no data: it renders a conversation and hands turns
 * back. Two surfaces use it and they are not the same shape —
 *
 *   the review screen, where every turn rewrites a publication's draft and
 *   writes a version, so there is no accept ceremony per suggestion because
 *   safety lives in the history;
 *
 *   the tip line, where nothing has been filed yet, so the conversation lives
 *   in the browser and disappears if the note is abandoned.
 *
 * Splitting the two containers off keeps that difference honest instead of
 * pretending a tip has a version table.
 */

export interface Turn {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export function CopyDesk({
  title = 'Copy desk',
  turns,
  onSend,
  isPending,
  error,
  disabled,
  hint,
  placeholder = 'Ask for a change…',
  disabledPlaceholder = 'This is settled.',
}: {
  title?: string
  turns: Turn[]
  onSend: (message: string) => void
  isPending: boolean
  error?: string | null
  disabled?: boolean
  hint: string
  placeholder?: string
  disabledPlaceholder?: string
}) {
  const [message, setMessage] = useState('')

  return (
    <section className="flex h-full min-h-64 flex-col rounded-lg border border-desk-200 dark:border-desk-800">
      <h2 className="border-b border-desk-200 px-3 py-2 text-xs font-medium tracking-wide text-desk-500 uppercase dark:border-desk-800">
        {title}
      </h2>

      <div className="flex-1 space-y-2.5 overflow-auto px-3 py-3">
        {turns.length === 0 && <p className="text-xs text-desk-500">{hint}</p>}
        {turns.map((entry) => (
          <div
            key={entry.id}
            className={`rounded-md px-2.5 py-1.5 text-sm ${
              entry.role === 'user'
                ? 'bg-desk-100 dark:bg-desk-900'
                : 'border border-desk-200 dark:border-desk-800'
            }`}
          >
            {entry.content}
          </div>
        ))}
        {isPending && <p className="text-xs text-desk-500">Thinking…</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!message.trim()) return
          onSend(message.trim())
          setMessage('')
        }}
        className="flex gap-2 border-t border-desk-200 px-3 py-2.5 dark:border-desk-800"
      >
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={disabled || isPending}
          placeholder={disabled ? disabledPlaceholder : placeholder}
          className="min-w-0 flex-1 rounded-md border border-desk-200 bg-transparent px-2.5 py-1 text-sm outline-none focus:border-desk-400 disabled:opacity-50 dark:border-desk-800"
        />
        <button
          type="submit"
          disabled={disabled || isPending || !message.trim()}
          className="rounded-md bg-desk-900 px-2.5 py-1 text-sm text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
        >
          Send
        </button>
      </form>
    </section>
  )
}

/**
 * The review screen's copy desk. Every turn is a row: the conversation and the
 * version it produced both persist, which is what lets the assistant rewrite
 * the draft directly instead of proposing diffs.
 */
export function PublicationCopyDesk({
  publicationId,
  disabled,
  onSlots,
}: {
  publicationId: string
  disabled: boolean
  onSlots: (slots: Record<string, string>) => void
}) {
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: ['chat', publicationId],
    queryFn: () => api.listChat(publicationId),
  })

  const send = useMutation({
    mutationFn: (text: string) => api.sendChat(publicationId, text),
    onSuccess: (result) => {
      // The copy desk returns the whole draft, so the editor sees its edit
      // land in the document immediately rather than after a refresh.
      onSlots(result.slots)
      void queryClient.invalidateQueries({ queryKey: ['chat', publicationId] })
      void queryClient.invalidateQueries({ queryKey: ['publication', publicationId] })
      void queryClient.invalidateQueries({ queryKey: ['versions', publicationId] })
    },
  })

  return (
    <CopyDesk
      turns={data?.messages ?? []}
      onSend={(message) => send.mutate(message)}
      isPending={send.isPending}
      error={send.error ? (send.error as Error).message : null}
      disabled={disabled}
      hint="Ask for a change in your own words — “cut the second paragraph”, “lead on the security fix”, “too promotional”. Every edit is kept in history."
    />
  )
}
