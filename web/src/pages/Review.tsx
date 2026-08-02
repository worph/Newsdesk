import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { CopyFields } from '../components/CopyFields'
import { PublicationCopyDesk } from '../components/CopyDesk'
import { PayloadPanel, VersionsPanel } from '../components/DraftPanels'
import { ScheduleBanner, SendBar } from '../components/SendBar'
import { Badge, when } from '../components/StoryCard'
import { CopyFrom, TargetStrip } from '../components/TargetStrip'

/**
 * One publication: the copy first — headline, then the document — with the
 * decision bar above it and everything the desk has to say about the placement
 * below. The screen is read top to bottom as "here is what goes out, do you
 * approve it"; the reason it was placed here, the story it came from and the
 * exact payload are all context for that question rather than the question.
 *
 * It is also the whole editor for a piece written at the desk. A manual send is
 * the same row reached by a different front door, so it gets the same screen —
 * the copy desk, the versions, the payload preview, the schedule and the gate,
 * none of which know or care who authored the slots. What differs is only the
 * furniture: no writer produced this, so there is nothing to say about why the
 * managing editor placed it, and the sibling strip is navigation rather than a
 * caution.
 *
 * Approve is the only path to the wire, and it is per destination — a story
 * running in two places is two independent decisions.
 */

export function Review() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [showCopyDesk, setShowCopyDesk] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const [showVersions, setShowVersions] = useState(false)

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
  // Keyed on the publication so moving between destinations picks up the copy
  // for the one now on screen rather than carrying the last one across.
  useEffect(() => {
    setDraft(null)
  }, [id])
  useEffect(() => {
    if (data && data.publication.id === id && draft === null) setDraft(data.publication.slots)
  }, [data, draft, id])

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
  const withdraw = useMutation({ mutationFn: () => api.withdrawPublication(id!), onSuccess: invalidate })
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

  /**
   * Take another destination's copy as a starting point. It only lands in the
   * editor — saving it is still a decision, and the slots this outlet does not
   * declare are dropped rather than smuggled through.
   */
  const copyFrom = useMutation({
    mutationFn: (fromId: string) => api.getPublication(fromId),
    onSuccess: (source) => {
      if (!data) return
      const shared = Object.keys(data.slotSpec).filter((key) => source.publication.slots[key])
      setDraft((current) => ({
        ...(current ?? {}),
        ...Object.fromEntries(shared.map((key) => [key, source.publication.slots[key]!])),
      }))
    },
  })

  const payload = useQuery({
    queryKey: ['payload', id, data?.publication.status],
    queryFn: () => api.getPayload(id!),
    enabled: Boolean(id) && showPayload,
  })

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
  const manual = story.origin === 'desk'
  const decisionError = (approve.error ?? save.error ?? reject.error) as Error | undefined

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
        <Badge tone="bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900">{outlet.name}</Badge>
        {manual ? (
          <Badge>written at the desk</Badge>
        ) : (
          publication.origin === 'human' && <Badge>placement added by you</Badge>
        )}
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
      */}
      <SendBar
        outletName={outlet.name}
        timezone={timezone}
        scheduleProposal={scheduleProposal}
        scheduledFor={publication.scheduledFor}
        settled={settled}
        sending={sending}
        dirty={dirty}
        approving={approve.isPending}
        saving={save.isPending}
        rejecting={reject.isPending}
        canRetry={publication.status === 'FAILED' && Boolean(publication.payload)}
        retrying={retry.isPending}
        error={decisionError?.message ?? null}
        onApprove={(at) => approve.mutate(at)}
        onSave={() => save.mutate()}
        onSpike={() => reject.mutate()}
        onRetry={() => retry.mutate()}
        onShowPayload={() => setShowPayload((v) => !v)}
        onShowVersions={() => setShowVersions((v) => !v)}
      />

      {publication.error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {publication.error}
        </p>
      )}

      {scheduled && publication.scheduledFor && (
        <ScheduleBanner
          scheduledFor={publication.scheduledFor}
          timezone={timezone}
          moving={reschedule.isPending}
          withdrawing={withdraw.isPending}
          error={((withdraw.error ?? reschedule.error) as Error | undefined)?.message ?? null}
          onMove={(at) => reschedule.mutate(at)}
          onWithdraw={() => withdraw.mutate()}
        />
      )}

      <TargetStrip
        siblings={siblings}
        currentId={publication.id}
        manual={manual}
        onOpen={(siblingId) => navigate(`/review/${siblingId}`)}
      />

      <CopyFields
        heading={`Copy — ${outlet.name}`}
        slotSpec={slotSpec}
        slots={draft}
        onChange={(key, value) => setDraft((current) => ({ ...(current ?? {}), [key]: value }))}
        aside={
          <CopyFrom
            siblings={siblings}
            currentId={publication.id}
            busy={copyFrom.isPending}
            onCopy={(fromId) => copyFrom.mutate(fromId)}
          />
        }
      />

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
        Below the copy: why this story is here at all. Context for the decision
        above rather than the decision itself — and on a piece written at the
        desk there is nothing to say, because you are the reason it is here.
      */}
      {!manual && publication.placementReason && (
        <section className="space-y-1.5 rounded-lg bg-desk-100 px-3 py-2.5 dark:bg-desk-900">
          <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">
            Why here — {outlet.name}
          </h2>
          <p className="text-sm">{publication.placementReason}</p>
          {publication.angle && (
            <p className="text-xs text-desk-600 dark:text-desk-400">
              <strong className="font-medium">Angle:</strong> {publication.angle}
            </p>
          )}
        </section>
      )}

      <section className="space-y-1.5">
        <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">The story</h2>
        <h3 className="font-medium">{story.title}</h3>
        <p className="text-sm text-desk-500">{story.summary}</p>
      </section>

      {showPayload && (
        <PayloadPanel
          payload={payload.data?.payload ?? data.preview.payload}
          frozen={payload.data?.frozen}
        />
      )}

      {showVersions && (
        <VersionsPanel
          versions={versions.data?.versions ?? []}
          disabled={settled}
          onRevert={(versionId) => revert.mutate(versionId)}
        />
      )}
    </div>
  )
}
