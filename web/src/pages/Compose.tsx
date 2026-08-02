import { useMutation, useQuery } from '@tanstack/react-query'
import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api'

/**
 * Write and place a piece yourself.
 *
 * This screen is deliberately almost empty, because it is not where the writing
 * happens. You already have the words; what the desk adds is the last mile —
 * each destination's own slots and limits, the payload merge, the gate, the
 * schedule, the ledger. So this asks two questions, files the story, and hands
 * you straight to the editor.
 *
 * There is no shared document here on purpose. Each destination is written
 * separately, in its own voice and against its own limits — one text poured
 * into five outlets is exactly the judgement the per-outlet identity exists to
 * make, and making it here would make it invisibly.
 *
 * Nothing on this path calls a model. That is what makes it the thing you reach
 * for when the wire is quiet or the agent is busy.
 */

const URGENCIES = [
  { value: 'normal', label: 'Normal', hint: 'the next slot that fits the outlet' },
  { value: 'breaking', label: 'Breaking', hint: 'as soon as the cadence allows' },
  { value: 'evergreen', label: 'Evergreen', hint: 'it can wait for a good slot' },
] as const

export function Compose() {
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [url, setUrl] = useState('')
  const [urgency, setUrgency] = useState<'normal' | 'breaking' | 'evergreen'>('normal')
  const [targets, setTargets] = useState<string[]>([])

  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 60_000 })
  const outlets = useMemo(
    () => (config.data?.config.outlets ?? []).filter((outlet) => outlet.enabled !== false),
    [config.data],
  )

  const compose = useMutation({
    mutationFn: () =>
      api.compose({
        title: title.trim(),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        ...(url.trim() ? { url: url.trim() } : {}),
        outlet_ids: targets,
        urgency,
      }),
    // Straight into the editor for the first destination. The strip at the top
    // of it is the way to the others.
    onSuccess: (result) => navigate(`/review/${result.publications[0]!.id}`),
  })

  function toggle(outletId: string) {
    setTargets((current) =>
      current.includes(outletId)
        ? current.filter((id) => id !== outletId)
        : [...current, outletId],
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    compose.mutate()
  }

  const error =
    compose.error instanceof ApiError
      ? compose.error.message
      : compose.error
        ? String(compose.error)
        : null

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Write and send</h1>
        <p className="text-sm text-desk-500">
          Your words, sent as you write them — nothing here is judged, deduplicated or rewritten.
          You will write each destination separately, in its own format and limits, and approve each
          one on its own. For something you want the desk to go and look into instead, use the{' '}
          <button
            type="button"
            onClick={() => navigate('/tips')}
            className="underline hover:text-desk-700"
          >
            tip line
          </button>
          .
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-5">
        <label className="block space-y-1">
          <span className="text-xs font-medium tracking-wide text-desk-500 uppercase">
            What this is
          </span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            placeholder="Immich 1.142 is out"
            className="w-full rounded-md border border-desk-200 bg-transparent px-3 py-2 text-base outline-none focus:border-desk-400 md:text-sm dark:border-desk-800"
          />
          <span className="block text-xs text-desk-500">
            The desk's record of the piece, not a headline you post. It is what the managing editor
            compares against if a stringer files the same thing later.
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium tracking-wide text-desk-500 uppercase">
              In a line <span className="normal-case opacity-70">(optional)</span>
            </span>
            <input
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="What happened, in one sentence."
              className="w-full rounded-md border border-desk-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-desk-400 dark:border-desk-800"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium tracking-wide text-desk-500 uppercase">
              Link <span className="normal-case opacity-70">(optional)</span>
            </span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
              className="w-full rounded-md border border-desk-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-desk-400 dark:border-desk-800"
            />
            <span className="block text-xs text-desk-500">
              Only reaches a post if that outlet is configured to carry one.
            </span>
          </label>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium tracking-wide text-desk-500 uppercase">
            Where it runs
          </legend>
          {outlets.length === 0 ? (
            <p className="rounded-lg border border-dashed border-desk-300 px-4 py-6 text-center text-xs text-desk-500 dark:border-desk-700">
              No destinations are configured yet. Add one in Configuration.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {outlets.map((outlet) => {
                const picked = targets.includes(outlet.id)
                return (
                  <button
                    type="button"
                    key={outlet.id}
                    onClick={() => toggle(outlet.id)}
                    aria-pressed={picked}
                    className={`rounded-lg border px-3 py-2.5 text-left ${
                      picked
                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                        : 'border-desk-200 hover:border-desk-400 dark:border-desk-800'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{outlet.name}</span>
                      {outlet.role === 'notify' && (
                        <span className="rounded bg-desk-200 px-1.5 py-0.5 font-mono text-[11px] text-desk-600 dark:bg-desk-800 dark:text-desk-300">
                          notify
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-xs text-desk-500">{outlet.description}</span>
                  </button>
                )
              })}
            </div>
          )}
        </fieldset>

        <label className="flex flex-wrap items-center gap-2 text-sm text-desk-500">
          <span className="text-xs font-medium tracking-wide uppercase">When it should go</span>
          <select
            value={urgency}
            onChange={(event) => setUrgency(event.target.value as typeof urgency)}
            className="rounded-md border border-desk-300 bg-white px-2 py-1 text-sm text-desk-900 dark:border-desk-700 dark:bg-desk-900 dark:text-desk-100"
          >
            {URGENCIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-xs">
            {URGENCIES.find((option) => option.value === urgency)?.hint}. Only shapes the time the
            desk proposes — you commit to one when you approve.
          </span>
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={compose.isPending || !title.trim() || targets.length === 0}
            className="rounded-md bg-desk-900 px-3 py-3 text-base font-medium text-white disabled:opacity-40 md:py-2 md:text-sm dark:bg-desk-100 dark:text-desk-900"
          >
            {compose.isPending
              ? 'Opening…'
              : targets.length > 1
                ? `Write it for ${targets.length} destinations`
                : 'Write it'}
          </button>
          <span className="text-xs text-desk-500">
            Nothing is sent yet — this opens a blank draft for each destination.
          </span>
        </div>
      </form>
    </div>
  )
}
