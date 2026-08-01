import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, api, type TipTurn } from '../api'
import { CopyDesk, type Turn } from '../components/CopyDesk'
import { DocumentEditor } from '../components/DocumentEditor'

/**
 * The one ingest path that lives inside the app, because it has no protocol
 * and no credentials and wants to be one tap on a phone. Also the landing
 * point for the Android share target, which arrives as ?url=&text=&title=.
 *
 * It serves two depths with one page. On the go: type a line, file it. At a
 * desk: write the thing properly, with the copy desk beside you. The second
 * must never slow down the first, which is why the assistant is a disclosure
 * and "File it" is always one tap away — an inference round trip on the fast
 * path would break the only promise this page makes.
 *
 * There is no link field. A url belongs in the text, where the reporter will
 * find it and go and read it.
 *
 * There can be more than one tip stringer — the Telegram ideas group is one,
 * and it exists so the old n8n `telegram-idea` source keeps working. The desk
 * refuses to guess which one an unnamed tip belongs to, so this page names it.
 * The choice is only rendered when it is a real choice; a desk with a single
 * tip stringer looks exactly as it did.
 */

const DRAFT_KEY = 'newsdesk.tip.draft'
const CHAT_KEY = 'newsdesk.tip.chat'

/**
 * The note survives a refresh in the browser rather than on the desk: a tip
 * that is never filed should leave nothing behind, so there is no row to clean
 * up and nothing to reconcile.
 */
function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: unknown): void {
  try {
    if (value === '' || (Array.isArray(value) && value.length === 0)) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A full or blocked localStorage costs the draft, never the filing.
  }
}

export function Tips() {
  const [params, setParams] = useSearchParams()
  const [text, setText] = useState(() => loadStored(DRAFT_KEY, ''))
  const [turns, setTurns] = useState<Turn[]>(() => loadStored<Turn[]>(CHAT_KEY, []))
  const [assisting, setAssisting] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [stringerId, setStringerId] = useState<string | null>(null)
  const nextTurnId = useRef(0)

  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 60_000 })
  const tipStringers = useMemo(
    () => (config.data?.config.stringers ?? []).filter((s) => s.kind === 'tip' && s.enabled !== false),
    [config.data],
  )
  // The first is the default, not a rule: whichever is used, the select below
  // shows it, so the desk never files somewhere the editor cannot see.
  const filedTo = stringerId ?? tipStringers[0]?.id ?? null

  useEffect(() => {
    const sharedUrl = params.get('url') ?? ''
    const sharedText = params.get('text') ?? params.get('title') ?? ''
    if (!sharedUrl && !sharedText) return

    // One field, so a shared link and its title simply join. The old heuristic
    // existed only to decide which of two fields a link belonged in.
    setText((current) =>
      [current, sharedText, sharedUrl].map((part) => part.trim()).filter(Boolean).join('\n\n'),
    )
    setParams({}, { replace: true })
  }, [params, setParams])

  useEffect(() => store(DRAFT_KEY, text), [text])
  useEffect(() => store(CHAT_KEY, turns), [turns])

  const submit = useMutation({
    mutationFn: () =>
      api.postTip({ text: text.trim(), ...(filedTo ? { stringer_id: filedTo } : {}) }),
    onSuccess: () => {
      setSent('Filed.')
      setText('')
      setTurns([])
      setAssisting(false)
      setTimeout(() => setSent(null), 2500)
    },
  })

  const assist = useMutation({
    mutationFn: (message: string) =>
      api.assistTip({
        text,
        message,
        history: turns.map(({ role, content }): TipTurn => ({ role, content })),
      }),
    onSuccess: (result, message) => {
      setTurns((current) => [
        ...current,
        { id: `u${nextTurnId.current++}`, role: 'user', content: message },
        { id: `a${nextTurnId.current++}`, role: 'assistant', content: result.reply },
      ])
      setText(result.text)
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit.mutate()
  }

  const error =
    submit.error instanceof ApiError ? submit.error.message : submit.error ? String(submit.error) : null

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Tip line</h1>
        <p className="text-sm text-desk-500">
          Anything worth writing about — a line is enough. The desk reads around it before the
          managing editor sees it, so paste links straight into the text.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <DocumentEditor
            id="tip"
            label="Tip"
            value={text}
            onChange={setText}
            autoFocus
            rows={assisting ? 18 : 8}
            monospace={false}
            placeholder="What happened, and why it might matter…"
            aside={
              <button
                type="button"
                onClick={() => setAssisting((open) => !open)}
                className="text-xs text-desk-500 hover:text-desk-700"
              >
                {assisting ? 'hide copy desk' : 'work on it'}
              </button>
            }
          />

          {assisting && (
            <CopyDesk
              turns={turns}
              onSend={(message) => assist.mutate(message)}
              isPending={assist.isPending}
              error={assist.error ? (assist.error as Error).message : null}
              hint="Say what you want done with the note — “make the ask clearer”, “what am I missing?”, “too long”. Nothing is filed until you file it."
              placeholder="Work on the note…"
            />
          )}
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {sent && <p className="text-sm text-emerald-600 dark:text-emerald-400">{sent}</p>}

        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <button
            type="submit"
            disabled={submit.isPending || text.trim().length === 0}
            className="w-full rounded-md bg-desk-900 px-3 py-3 text-base font-medium text-white disabled:opacity-40 md:w-auto md:py-2 md:text-sm dark:bg-desk-100 dark:text-desk-900"
          >
            {submit.isPending ? 'Filing…' : 'File it'}
          </button>

          {tipStringers.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-desk-500">
              File to
              <select
                value={filedTo ?? ''}
                onChange={(event) => setStringerId(event.target.value)}
                className="rounded-md border border-desk-300 bg-white px-2 py-1 text-sm text-desk-900 dark:border-desk-700 dark:bg-desk-900 dark:text-desk-100"
              >
                {tipStringers.map((stringer) => (
                  <option key={stringer.id} value={stringer.id}>
                    {stringer.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </form>
    </div>
  )
}
