import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import MarkdownIt from 'markdown-it'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type SlotDef } from '../api'
import { CopyDesk } from '../components/CopyDesk'
import { Badge, when } from '../components/StoryCard'

/**
 * One publication: the primary slot as a document, the rest as fields, the
 * managing editor's reason and angle beside it, and exactly what will be sent.
 *
 * Approve is the only path to the wire, and it is per destination — a story
 * running in two places is two independent decisions, which the outlet strip
 * at the top has to make unmistakable.
 */

// html: false — a draft is markdown and is never injected as raw HTML.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

function Field({
  slotKey,
  def,
  value,
  onChange,
}: {
  slotKey: string
  def: SlotDef
  value: string
  onChange: (next: string) => void
}) {
  const over = def.max !== undefined && value.length > def.max

  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between">
        <span className="text-xs font-medium tracking-wide text-desk-500 uppercase">
          {def.label}
          {def.optional && <span className="ml-1 normal-case opacity-70">(optional)</span>}
        </span>
        {def.max !== undefined && (
          <span className={`font-mono text-[11px] ${over ? 'text-red-600' : 'text-desk-500'}`}>
            {value.length}/{def.max}
          </span>
        )}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={def.hint}
        className={`w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none ${
          over ? 'border-red-500' : 'border-desk-200 focus:border-desk-400 dark:border-desk-800'
        }`}
      />
      <span className="sr-only">{slotKey}</span>
    </label>
  )
}

export function Review() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [preview, setPreview] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const [showVersions, setShowVersions] = useState(false)

  const { data, isPending } = useQuery({
    queryKey: ['publication', id],
    queryFn: () => api.getPublication(id!),
    enabled: Boolean(id),
  })

  const versions = useQuery({
    queryKey: ['versions', id],
    queryFn: () => api.listVersions(id!),
    enabled: Boolean(id) && showVersions,
  })

  // Adopt the stored slots once, then let local edits win until they are saved.
  useEffect(() => {
    if (data && draft === null) setDraft(data.publication.slots)
  }, [data, draft])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['publication', id] })
    void queryClient.invalidateQueries({ queryKey: ['versions', id] })
    void queryClient.invalidateQueries({ queryKey: ['stories'] })
  }

  const save = useMutation({
    mutationFn: () => api.savePublication(id!, draft ?? {}),
    onSuccess: invalidate,
  })
  const approve = useMutation({ mutationFn: () => api.approvePublication(id!), onSuccess: invalidate })
  const reject = useMutation({ mutationFn: () => api.rejectPublication(id!), onSuccess: invalidate })
  const retry = useMutation({ mutationFn: () => api.retryPublication(id!), onSuccess: invalidate })
  const revert = useMutation({
    mutationFn: (versionId: string) => api.revertPublication(id!, versionId),
    onSuccess: (result) => {
      setDraft(result.slots)
      invalidate()
    },
  })

  const payload = useQuery({
    queryKey: ['payload', id, data?.publication.status],
    queryFn: () => api.getPayload(id!),
    enabled: Boolean(id) && showPayload,
  })

  const primaryKey = useMemo(() => {
    if (!data) return undefined
    return Object.entries(data.slotSpec).find(([, def]) => def.primary)?.[0]
  }, [data])

  if (isPending || !data || draft === null) {
    return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>
  }

  const { publication, story, outlet, slotSpec, siblings } = data
  const settled = publication.status === 'PUBLISHED' || publication.status === 'REJECTED'
  const dirty = JSON.stringify(draft) !== JSON.stringify(publication.slots)
  const secondary = Object.entries(slotSpec).filter(([key]) => key !== primaryKey)

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 pb-16 md:px-6">
      <button onClick={() => navigate(-1)} className="text-sm text-desk-500 hover:text-desk-700">
        ← back
      </button>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{publication.status.toLowerCase().replace(/_/g, ' ')}</Badge>
          {publication.origin === 'human' && <Badge>placement added by you</Badge>}
          {publication.publishedAt && (
            <span className="text-xs text-desk-500">sent {when(publication.publishedAt)}</span>
          )}
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{story.title}</h1>
        <p className="text-sm text-desk-500">{story.summary}</p>
      </header>

      {/* Several placements means several independent decisions. Say so. */}
      {siblings.length > 1 && (
        <div className="space-y-1.5 rounded-lg border border-desk-200 px-3 py-2.5 dark:border-desk-800">
          <p className="text-xs text-desk-500">
            This story runs in {siblings.length} places. Approving one does not ship the others.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {siblings.map((sibling) => (
              <button
                key={sibling.id}
                onClick={() => navigate(`/review/${sibling.id}`)}
                className={`rounded px-2 py-0.5 text-xs ${
                  sibling.id === publication.id
                    ? 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
                    : 'bg-desk-100 text-desk-600 dark:bg-desk-900 dark:text-desk-400'
                }`}
              >
                {sibling.outletId} · {sibling.status.toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      <section className="space-y-1.5 rounded-lg bg-desk-100 px-3 py-2.5 dark:bg-desk-900">
        <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">
          Why here — {outlet.name}
        </h2>
        {publication.placementReason && <p className="text-sm">{publication.placementReason}</p>}
        {publication.angle && (
          <p className="text-xs text-desk-600 dark:text-desk-400">
            <strong className="font-medium">Angle:</strong> {publication.angle}
          </p>
        )}
      </section>

      {publication.error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {publication.error}
        </p>
      )}

      {secondary.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {secondary.map(([key, def]) => (
            <Field
              key={key}
              slotKey={key}
              def={def}
              value={draft[key] ?? ''}
              onChange={(next) => setDraft({ ...draft, [key]: next })}
            />
          ))}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {primaryKey && (
        <section className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">
              {slotSpec[primaryKey]?.label}
            </h2>
            <div className="flex items-center gap-3">
              {slotSpec[primaryKey]?.max !== undefined && (
                <span
                  className={`font-mono text-[11px] ${
                    (draft[primaryKey] ?? '').length > (slotSpec[primaryKey]?.max ?? 0)
                      ? 'text-red-600'
                      : 'text-desk-500'
                  }`}
                >
                  {(draft[primaryKey] ?? '').length}/{slotSpec[primaryKey]?.max}
                </span>
              )}
              <button
                onClick={() => setPreview((p) => !p)}
                className="text-xs text-desk-500 hover:text-desk-700"
              >
                {preview ? 'edit' : 'preview'}
              </button>
            </div>
          </div>

          {preview ? (
            <div
              className="prose-desk min-h-56 rounded-md border border-desk-200 px-3 py-2.5 text-sm dark:border-desk-800"
              // Rendered by markdown-it with html:false, so any raw HTML in the
              // draft is escaped rather than injected.
              dangerouslySetInnerHTML={{ __html: md.render(draft[primaryKey] ?? '') }}
            />
          ) : (
            <textarea
              value={draft[primaryKey] ?? ''}
              onChange={(event) => setDraft({ ...draft, [primaryKey]: event.target.value })}
              rows={14}
              className="w-full rounded-md border border-desk-200 bg-transparent px-3 py-2.5 font-mono text-sm outline-none focus:border-desk-400 dark:border-desk-800"
            />
          )}
        </section>
      )}

        <CopyDesk
          publicationId={publication.id}
          disabled={settled}
          onSlots={(next) => setDraft(next)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending || settled}
          className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
        </button>

        <button
          onClick={() => approve.mutate()}
          disabled={approve.isPending || settled || dirty}
          title={dirty ? 'Save your edits first — approval freezes what is sent' : undefined}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {approve.isPending ? 'Approving…' : `Approve for ${outlet.name}`}
        </button>

        <button
          onClick={() => reject.mutate()}
          disabled={reject.isPending || settled}
          className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
        >
          Spike
        </button>

        {publication.status === 'FAILED' && publication.payload && (
          <button
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Re-send
          </button>
        )}

        <button
          onClick={() => setShowPayload((v) => !v)}
          className="ml-auto text-xs text-desk-500 hover:text-desk-700"
        >
          what will be sent
        </button>
        <button
          onClick={() => setShowVersions((v) => !v)}
          className="text-xs text-desk-500 hover:text-desk-700"
        >
          history
        </button>
      </div>

      {(approve.error || save.error) && (
        <p className="text-sm text-red-600">
          {((approve.error ?? save.error) as Error).message}
        </p>
      )}

      {showPayload && (
        <section className="space-y-1.5">
          <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">
            What will be sent {payload.data?.frozen && '(frozen at approval)'}
          </h2>
          <p className="text-xs text-desk-500">
            Keys you did not author come from configuration — the destination is pinned there and no
            draft can reach it.
          </p>
          <pre className="max-h-80 overflow-auto rounded-md bg-desk-100 p-3 font-mono text-xs dark:bg-desk-900">
            {JSON.stringify(payload.data?.payload ?? data.preview.payload, null, 2)}
          </pre>
        </section>
      )}

      {showVersions && (
        <section className="space-y-1.5">
          <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">History</h2>
          <ul className="space-y-1.5">
            {(versions.data?.versions ?? []).map((version) => (
              <li
                key={version.id}
                className="flex items-center gap-3 rounded-md border border-desk-200 px-3 py-2 text-sm dark:border-desk-800"
              >
                <Badge>{version.origin}</Badge>
                <span className="min-w-0 flex-1 truncate text-desk-600 dark:text-desk-400">
                  {Object.values(version.slots)[0]}
                </span>
                <span className="shrink-0 text-xs text-desk-500">{when(version.createdAt)}</span>
                <button
                  onClick={() => revert.mutate(version.id)}
                  disabled={settled}
                  className="shrink-0 text-xs text-desk-500 hover:text-desk-700 disabled:opacity-40"
                >
                  revert
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
