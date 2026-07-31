import { useMutation } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../api'

/**
 * The one ingest path that lives inside the app, because it has no protocol
 * and no credentials and wants to be one tap on a phone. Also the landing
 * point for the Android share target, which arrives as ?url=&text=&title=.
 */
export function Tips() {
  const [params, setParams] = useSearchParams()
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    const sharedUrl = params.get('url') ?? ''
    const sharedText = params.get('text') ?? params.get('title') ?? ''
    if (!sharedUrl && !sharedText) return

    // A share sheet often puts the link in `text` when there is no `url`.
    const looksLikeUrl = /^https?:\/\/\S+$/.test(sharedText.trim())
    setUrl(sharedUrl || (looksLikeUrl ? sharedText.trim() : ''))
    setText(looksLikeUrl && !sharedUrl ? '' : sharedText)
    setParams({}, { replace: true })
  }, [params, setParams])

  const submit = useMutation({
    mutationFn: () => api.postTip({ text: text.trim(), ...(url.trim() ? { url: url.trim() } : {}) }),
    onSuccess: () => {
      setSent('Captured.')
      setText('')
      setUrl('')
      setTimeout(() => setSent(null), 2500)
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit.mutate()
  }

  const error =
    submit.error instanceof ApiError ? submit.error.message : submit.error ? String(submit.error) : null

  return (
    <div className="mx-auto max-w-xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Tip line</h1>
        <p className="text-sm text-desk-500">
          Anything worth writing about. It files like any other stringer and is read by the managing
          editor the same way — treated as data, never as an instruction.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="tip" className="text-sm font-medium">
            Tip
          </label>
          <textarea
            id="tip"
            value={text}
            autoFocus
            rows={5}
            onChange={(e) => setText(e.target.value)}
            placeholder="What happened, and why it might matter…"
            className="w-full resize-y rounded-md border border-desk-300 bg-white p-3 text-base outline-none focus:border-desk-500 dark:border-desk-700 dark:bg-desk-900"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="tip-url" className="text-sm font-medium">
            Link <span className="font-normal text-desk-500">(optional)</span>
          </label>
          <input
            id="tip-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="w-full rounded-md border border-desk-300 bg-white px-3 py-2.5 text-base outline-none focus:border-desk-500 dark:border-desk-700 dark:bg-desk-900"
          />
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {sent && <p className="text-sm text-emerald-600 dark:text-emerald-400">{sent}</p>}

        <button
          type="submit"
          disabled={submit.isPending || text.trim().length === 0}
          className="w-full rounded-md bg-desk-900 px-3 py-3 text-base font-medium text-white disabled:opacity-40 md:w-auto md:py-2 md:text-sm dark:bg-desk-100 dark:text-desk-900"
        >
          {submit.isPending ? 'Filing…' : 'File it'}
        </button>
      </form>
    </div>
  )
}
