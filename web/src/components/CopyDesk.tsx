import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api'

/**
 * The copy desk, beside the document rather than in place of it.
 *
 * Every turn rewrites the draft directly and writes a version. There is no
 * accept ceremony per suggestion, because safety lives in the history — which
 * is what makes editing conversational instead of a diff review.
 */
export function CopyDesk({
  publicationId,
  disabled,
  onSlots,
}: {
  publicationId: string
  disabled: boolean
  onSlots: (slots: Record<string, string>) => void
}) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState('')

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
      setMessage('')
      void queryClient.invalidateQueries({ queryKey: ['chat', publicationId] })
      void queryClient.invalidateQueries({ queryKey: ['publication', publicationId] })
      void queryClient.invalidateQueries({ queryKey: ['versions', publicationId] })
    },
  })

  const messages = data?.messages ?? []

  return (
    <section className="flex h-full min-h-64 flex-col rounded-lg border border-desk-200 dark:border-desk-800">
      <h2 className="border-b border-desk-200 px-3 py-2 text-xs font-medium tracking-wide text-desk-500 uppercase dark:border-desk-800">
        Copy desk
      </h2>

      <div className="flex-1 space-y-2.5 overflow-auto px-3 py-3">
        {messages.length === 0 && (
          <p className="text-xs text-desk-500">
            Ask for a change in your own words — “cut the second paragraph”, “lead on the security
            fix”, “too promotional”. Every edit is kept in history.
          </p>
        )}
        {messages.map((entry) => (
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
        {send.isPending && <p className="text-xs text-desk-500">Thinking…</p>}
        {send.error && <p className="text-xs text-red-600">{(send.error as Error).message}</p>}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (message.trim()) send.mutate(message.trim())
        }}
        className="flex gap-2 border-t border-desk-200 px-3 py-2.5 dark:border-desk-800"
      >
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={disabled || send.isPending}
          placeholder={disabled ? 'This is settled.' : 'Ask for a change…'}
          className="min-w-0 flex-1 rounded-md border border-desk-200 bg-transparent px-2.5 py-1 text-sm outline-none focus:border-desk-400 disabled:opacity-50 dark:border-desk-800"
        />
        <button
          type="submit"
          disabled={disabled || send.isPending || !message.trim()}
          className="rounded-md bg-desk-900 px-2.5 py-1 text-sm text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
        >
          Send
        </button>
      </form>
    </section>
  )
}
