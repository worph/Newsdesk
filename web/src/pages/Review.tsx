import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type SlotDef } from '../api'
import { PublicationCopyDesk } from '../components/CopyDesk'
import { DocumentEditor } from '../components/DocumentEditor'
import { Badge, when } from '../components/StoryCard'
import { browserTimezone, fromLocalInput, stamp, toLocalInput, until } from '../time'

/**
 * One publication: the copy first — headline, then the document — with the
 * decision bar above it and everything the desk has to say about the placement
 * below. The screen is read top to bottom as "here is what goes out, do you
 * approve it"; the reason it was placed here, the story it came from and the
 * exact payload are all context for that question rather than the question.
 *
 * The copy opens rendered, because reading is what this screen is for and
 * editing is the exception; one toggle flips the headline and the body together
 * so the two never disagree about which mode you are in.
 *
 * Approve is the only path to the wire, and it is per destination — a story
 * running in two places is two independent decisions, which the outlet strip
 * has to make unmistakable.
 */

function Field({
  slotKey,
  def,
  value,
  onChange,
  preview,
}: {
  slotKey: string
  def: SlotDef
  value: string
  onChange: (next: string) => void
  preview: boolean
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
      {preview ? (
        <span className="block px-0.5 py-1 text-base font-medium">
          {value || <span className="font-normal text-desk-500">—</span>}
        </span>
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={def.hint}
          className={`w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none ${
            over ? 'border-red-500' : 'border-desk-200 focus:border-desk-400 dark:border-desk-800'
          }`}
        />
      )}
      <span className="sr-only">{slotKey}</span>
    </label>
  )
}

export function Review() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  /** Reading is the default; editing is the exception you ask for. */
  const [preview, setPreview] = useState(true)
  /** The assistant is a tool you reach for, not a panel that watches you work. */
  const [showCopyDesk, setShowCopyDesk] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  /** Null until the editor touches it, so a fresh proposal is never overwritten by a stale one. */
  const [sendAt, setSendAt] = useState<string | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['publication', id],
    queryFn: () => api.getPublication(id!),
    enabled: Boolean(id),
    // Approval is a 202: it freezes the payload and queues the send, and the
    // worker flips the row to PUBLISHED a poll or two later. Without this the
    // screen keeps showing "sending…" until a manual reload. The interval ends
    // itself the moment the row settles, so nothing polls at rest.
    //
    // Deliberately not SCHEDULED: that row settles in six hours, and polling it
    // every two seconds until then would be a busy loop with a countdown on it.
    refetchInterval: (query) =>
      query.state.data?.publication.status === 'APPROVED' ? 2_000 : false,
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
  const approve = useMutation({
    mutationFn: (scheduledFor?: string) => api.approvePublication(id!, scheduledFor),
    onSuccess: invalidate,
  })
  const reject = useMutation({ mutationFn: () => api.rejectPublication(id!), onSuccess: invalidate })
  const retry = useMutation({ mutationFn: () => api.retryPublication(id!), onSuccess: invalidate })
  const withdraw = useMutation({
    mutationFn: () => api.withdrawPublication(id!),
    onSuccess: () => {
      // The draft is editable again, so drop the stale schedule the input holds.
      setSendAt(null)
      invalidate()
    },
  })
  const reschedule = useMutation({
    mutationFn: (scheduledFor: string) => api.reschedulePublication(id!, scheduledFor),
    onSuccess: invalidate,
  })
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

  const { publication, story, outlet, slotSpec, siblings, scheduleProposal, timezone } = data
  // APPROVED closes the desk with the rest: the payload is frozen and the send
  // is queued, so there is nothing left here to change. FAILED stays open —
  // fixing a bad send means editing and approving again.
  const sending = publication.status === 'APPROVED'
  const scheduled = publication.status === 'SCHEDULED'
  const settled =
    sending || scheduled || publication.status === 'PUBLISHED' || publication.status === 'REJECTED'
  const dirty = JSON.stringify(draft) !== JSON.stringify(publication.slots)
  const secondary = Object.entries(slotSpec).filter(([key]) => key !== primaryKey)

  // The desk's proposal until the editor moves it. Falls back to the committed
  // time on a scheduled row, which is what the "move it" control edits.
  const proposedAt = scheduleProposal?.at ?? publication.scheduledFor
  const slotValue = sendAt ?? (proposedAt ? toLocalInput(proposedAt) : '')
  // A datetime-local can be blank or half-typed. Anything that is not a real
  // instant is treated as "no time chosen", which falls back to sending now
  // rather than throwing inside a formatter mid-render.
  const chosen =
    slotValue && !Number.isNaN(new Date(slotValue).getTime()) ? fromLocalInput(slotValue) : null
  // Only worth naming a zone when it is not the one the browser is already
  // showing — otherwise it is noise on every single time.
  const elsewhere = timezone !== browserTimezone() ? timezone : undefined

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 pb-16 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => navigate(-1)} className="text-sm text-desk-500 hover:text-desk-700">
          ← back
        </button>
        <span className="text-desk-300 dark:text-desk-700">·</span>
        <Badge>
          {sending ? 'approved — sending…' : publication.status.toLowerCase().replace(/_/g, ' ')}
        </Badge>
        <Badge tone="bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900">
          {outlet.name}
        </Badge>
        {publication.origin === 'human' && <Badge>placement added by you</Badge>}
        {publication.urgency && publication.urgency !== 'normal' && (
          <Badge>{publication.urgency}</Badge>
        )}
        {publication.publishedAt && (
          <span className="text-xs text-desk-500">sent {when(publication.publishedAt)}</span>
        )}
      </div>

      {/*
        The decision, at the top. Everything under it is material for making it:
        the copy first, then why the desk placed the story here at all.

        Approving commits to a time. The proposal is already in the box, so the
        normal path is one click; "Send now" is the same approval with the time
        left off, which is exactly what it used to do.
      */}
      <section className="space-y-2.5 rounded-lg border border-desk-200 px-3 py-3 dark:border-desk-800">
        {!settled && (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium tracking-wide text-desk-500 uppercase">
                Send at
              </label>
              <input
                type="datetime-local"
                value={slotValue}
                onChange={(event) => setSendAt(event.target.value)}
                className="rounded-md border border-desk-300 bg-transparent px-2 py-1 text-sm dark:border-desk-700"
              />
              {chosen && (
                <span className="text-xs text-desk-500">
                  {until(chosen)}
                  {elsewhere && ` · ${stamp(chosen, elsewhere)} ${elsewhere}`}
                </span>
              )}
            </div>
            {scheduleProposal && !sendAt && (
              <p className="text-xs text-desk-500">{scheduleProposal.reason}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => approve.mutate(chosen ?? undefined)}
            disabled={approve.isPending || settled || dirty}
            title={dirty ? 'Save your edits first — approval freezes what is sent' : undefined}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {approve.isPending || sending
              ? 'Sending…'
              : chosen
                ? `Approve → ${stamp(chosen)}`
                : `Approve for ${outlet.name}`}
          </button>

          <button
            onClick={() => approve.mutate(undefined)}
            disabled={approve.isPending || settled || dirty}
            title="Approve and send immediately, ignoring the schedule"
            className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
          >
            Send now
          </button>

          <button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending || settled}
            className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
          >
            {save.isPending ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
          </button>

          {/* Spiking a story is the one thing here that throws work away. */}
          <button
            onClick={() => reject.mutate()}
            disabled={reject.isPending || settled}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
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

        {(approve.error || save.error || reject.error) && (
          <p className="text-sm text-red-600">
            {((approve.error ?? save.error ?? reject.error) as Error).message}
          </p>
        )}
      </section>

      {publication.error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {publication.error}
        </p>
      )}

      {/*
        A scheduled row is closed to editing but not to changing its mind. The
        copy is frozen and the queue is holding it; the two things still on
        offer are moving the time and calling it off.
      */}
      {scheduled && publication.scheduledFor && (
        <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm">
            <strong className="font-medium">Sending {stamp(publication.scheduledFor, elsewhere)}</strong>{' '}
            <span className="text-desk-600 dark:text-desk-400">
              {until(publication.scheduledFor)}
              {elsewhere && ` · ${elsewhere}`}
            </span>
          </p>
          <p className="text-xs text-desk-600 dark:text-desk-400">
            The copy is frozen — exactly these bytes go out. Withdraw it to edit, which puts it back
            in the queue awaiting approval.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              value={slotValue}
              onChange={(event) => setSendAt(event.target.value)}
              className="rounded-md border border-desk-300 bg-transparent px-2 py-1 text-sm dark:border-desk-700"
            />
            <button
              onClick={() => chosen && reschedule.mutate(chosen)}
              disabled={!sendAt || !chosen || reschedule.isPending}
              className="rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
            >
              {reschedule.isPending ? 'Moving…' : 'Move'}
            </button>
            <button
              onClick={() => withdraw.mutate()}
              disabled={withdraw.isPending}
              className="ml-auto rounded-md bg-desk-100 px-3 py-1.5 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
            >
              {withdraw.isPending ? 'Withdrawing…' : 'Withdraw'}
            </button>
          </div>
          {(withdraw.error || reschedule.error) && (
            <p className="text-sm text-red-600">
              {((withdraw.error ?? reschedule.error) as Error).message}
            </p>
          )}
        </section>
      )}

      {/*
        The copy, as it will read: the headline first, because that is the line
        the reader meets first, then the document. One toggle, one mode — a
        rendered headline over a raw body would be neither.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">
            Copy — {outlet.name}
          </h2>
          <button
            type="button"
            onClick={() => setPreview((p) => !p)}
            className="text-xs text-desk-500 hover:text-desk-700"
          >
            {preview ? 'edit' : 'preview'}
          </button>
        </div>

        {secondary.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {secondary.map(([key, def]) => (
              <Field
                key={key}
                slotKey={key}
                def={def}
                value={draft[key] ?? ''}
                onChange={(next) => setDraft({ ...draft, [key]: next })}
                preview={preview}
              />
            ))}
          </div>
        )}

        {primaryKey && (
          <DocumentEditor
            label={slotSpec[primaryKey]?.label}
            value={draft[primaryKey] ?? ''}
            onChange={(next) => setDraft({ ...draft, [primaryKey]: next })}
            preview={preview}
            {...(slotSpec[primaryKey]?.max !== undefined ? { max: slotSpec[primaryKey]!.max } : {})}
          />
        )}
      </section>

      {/* The assistant is opened when wanted, not parked beside the document. */}
      {showCopyDesk ? (
        <div className="space-y-1.5">
          <div className="flex justify-end">
            <button
              onClick={() => setShowCopyDesk(false)}
              className="text-xs text-desk-500 hover:text-desk-700"
            >
              hide copy desk
            </button>
          </div>
          <PublicationCopyDesk
            publicationId={publication.id}
            disabled={settled}
            onSlots={(next) => setDraft(next)}
          />
        </div>
      ) : (
        <button
          onClick={() => setShowCopyDesk(true)}
          className="w-full rounded-lg border border-dashed border-desk-300 px-3 py-2 text-xs text-desk-500 hover:border-desk-400 hover:text-desk-700 dark:border-desk-700"
        >
          Copy desk assistant — ask for a change in your own words
        </button>
      )}

      {/*
        Below the copy: why this story is here at all, and where else it runs.
        Context for the decision above rather than the decision itself.
      */}
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

      <section className="space-y-1.5">
        <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">The story</h2>
        <h3 className="font-medium">{story.title}</h3>
        <p className="text-sm text-desk-500">{story.summary}</p>
      </section>

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
