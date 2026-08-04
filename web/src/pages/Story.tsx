import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type BulkApproval, type StoryPlacementDetail } from '../api'
import { OutletPicker } from '../components/OutletPicker'
import { Badge, when } from '../components/StoryCard'
import { browserTimezone, stamp, until } from '../time'

/**
 * One story: what the managing editor understood, what it compared against, where it
 * proposed to run it and why, and the filings that contributed.
 *
 * For a duplicate this is the side-by-side that makes the verdict reviewable —
 * a drop you cannot inspect is a drop you cannot trust.
 *
 * It is also where placement is decided. Each destination carries the time the
 * desk worked out for it, so approving is a click rather than a trip through
 * the editor: the review screen is for reading a draft, and a piece you have
 * already read does not need to be opened again to be let out. Nothing about
 * the gate moves — every approve here is the same `approvePublication` the
 * review screen calls, per destination, freezing that destination's own bytes.
 */

function Section({
  title,
  hint,
  aside,
  children,
}: {
  title: string
  hint?: string
  /** The decision that belongs to this section, kept level with its heading. */
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">{title}</h2>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {hint && <p className="text-xs text-desk-500">{hint}</p>}
      {children}
    </section>
  )
}

/**
 * Why this one cannot be waved through. Null when it can, or when the status
 * badge already says everything — a scheduled placement is not a problem.
 */
function blockedBecause(placement: StoryPlacementDetail): string | null {
  if (placement.ready) return null
  switch (placement.status) {
    case 'PROPOSED':
    case 'DRAFTING':
      return 'the writer has not finished this one yet'
    case 'AWAITING_APPROVAL':
      return placement.missing.length > 0
        ? `still blank: ${placement.missing.join(', ')}`
        : 'this destination is switched off in the configuration'
    default:
      return null
  }
}

/** Only worth naming a zone when it is not the one the browser is already showing. */
function elsewhere(timezone: string): string | undefined {
  return timezone !== browserTimezone() ? timezone : undefined
}

function PlacementCard({
  placement,
  timezone,
  approving,
  onOpen,
  onApprove,
}: {
  placement: StoryPlacementDetail
  timezone: string
  approving: boolean
  onOpen: () => void
  /** A time, or nothing to send the moment it is approved. */
  onApprove: (at?: string) => void
}) {
  const zone = elsewhere(timezone)
  const blocked = blockedBecause(placement)
  const proposal = placement.schedule

  return (
    <li className="space-y-1.5 rounded-md border border-desk-200 px-3 py-2.5 dark:border-desk-800">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onOpen} className="font-medium hover:underline">
          {placement.outletName ?? placement.outletId}
        </button>
        <Badge>{placement.status.toLowerCase().replace(/_/g, ' ')}</Badge>
        {placement.origin === 'human' && <Badge>added by you</Badge>}
        {placement.urgency && placement.urgency !== 'normal' && <Badge>{placement.urgency}</Badge>}
      </div>

      {placement.placementReason && (
        <p className="text-sm text-desk-600 dark:text-desk-400">{placement.placementReason}</p>
      )}

      {placement.angle && (
        <p className="rounded bg-desk-100 px-2.5 py-1.5 text-xs text-desk-600 dark:bg-desk-900 dark:text-desk-400">
          <strong className="font-medium">Angle for the writer:</strong> {placement.angle}
        </p>
      )}

      {/* Committed. The proposal is gone by now — this is what was chosen. */}
      {placement.scheduledFor && (
        <p className="text-xs text-desk-600 dark:text-desk-400">
          <strong className="font-medium">Sending {stamp(placement.scheduledFor, zone)}</strong>{' '}
          {until(placement.scheduledFor)}
          {zone && ` · ${zone}`}
        </p>
      )}

      {/*
        The reason opens with the time in the desk's own zone, which is why it
        is not stamped again here — the button below says the same instant in
        the clock the person reading it is actually on.
      */}
      {proposal && <p className="text-xs text-desk-500">Proposed {proposal.reason}</p>}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {placement.ready && proposal && (
          <>
            <button
              onClick={() => onApprove(proposal.at)}
              disabled={approving}
              className="rounded-md bg-emerald-600 px-2.5 py-1 text-sm font-medium text-white disabled:opacity-40"
            >
              {approving ? 'Approving…' : `Approve → ${stamp(proposal.at, zone)}`}
            </button>
            <button
              onClick={() => onApprove(undefined)}
              disabled={approving}
              title="Approve and send immediately, ignoring the proposed slot"
              className="rounded-md bg-desk-100 px-2.5 py-1 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
            >
              Send now
            </button>
          </>
        )}

        {blocked && <span className="text-xs text-desk-500">{blocked}</span>}

        <button onClick={onOpen} className="ml-auto text-xs text-desk-500 hover:text-desk-700">
          open the draft
        </button>
      </div>
    </li>
  )
}

/**
 * What an approve-all came to. Every skipped destination says why, by name.
 *
 * The times are stamped in the same zone the cards above use — the desk's, when
 * that is not the reader's. Two renderings of one instant on one screen is a
 * bug report waiting to be filed.
 */
function BulkResult({ result, timezone }: { result: BulkApproval; timezone: string }) {
  const zone = elsewhere(timezone)

  return (
    <div className="space-y-1 rounded-md bg-desk-100 px-3 py-2 text-xs dark:bg-desk-900">
      {result.approved.length > 0 && (
        <p className="text-emerald-700 dark:text-emerald-400">
          Approved {result.approved.length}:{' '}
          {result.approved
            .map(
              (row) =>
                `${row.outlet}${row.scheduledFor ? ` → ${stamp(row.scheduledFor, zone)}` : ' → now'}`,
            )
            .join(' · ')}
          {zone && ` · ${zone}`}
        </p>
      )}
      {result.skipped.map((row) => (
        <p key={row.id} className="text-desk-600 dark:text-desk-400">
          <strong className="font-medium">{row.outlet}</strong> — {row.reason}
        </p>
      ))}
    </div>
  )
}

export function Story() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [outletId, setOutletId] = useState<string | null>(null)

  const { data, isPending, error } = useQuery({
    queryKey: ['story', id],
    queryFn: () => api.getStory(id!),
    enabled: Boolean(id),
  })

  // Named destinations for the picker. The same query the Write screen uses, so
  // one fetch serves both.
  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 60_000 })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['story', id] })
    void queryClient.invalidateQueries({ queryKey: ['stories'] })
    // Approving from here changes both of the screens that count what is
    // waiting and what is booked, and neither is on this page to notice.
    void queryClient.invalidateQueries({ queryKey: ['actions'] })
    void queryClient.invalidateQueries({ queryKey: ['calendar'] })
  }

  const rerun = useMutation({ mutationFn: () => api.rerunStory(id!), onSuccess: invalidate })
  const addPlacement = useMutation({
    mutationFn: () => api.addPlacement(id!, { outlet_id: outletId! }),
    onSuccess: () => {
      setOutletId(null)
      invalidate()
    },
  })

  /**
   * One destination, waved through without opening it. `variables` is what lets
   * the row that was clicked show the pending state rather than all of them.
   */
  const approve = useMutation({
    mutationFn: ({ publicationId, at }: { publicationId: string; at?: string }) =>
      api.approvePublication(publicationId, at),
    onSuccess: invalidate,
  })

  const approveAll = useMutation({
    mutationFn: () => api.approvePlacements(id!),
    onSuccess: invalidate,
  })

  if (isPending) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>
  if (error || !data) return <div className="px-6 pb-10 text-sm text-desk-500">No such story.</div>

  const { story, filings, placements, related, timezone } = data
  const ready = placements.filter((placement) => placement.ready)

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 pb-16 md:px-6">
      <button onClick={() => navigate(-1)} className="text-sm text-desk-500 hover:text-desk-700">
        ← back
      </button>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{story.status.toLowerCase()}</Badge>
          {story.dedupVerdict !== 'NEW' && <Badge>{story.dedupVerdict.toLowerCase()}</Badge>}
          {story.label && <Badge>{story.label}</Badge>}
          <span className="text-xs text-desk-500">{when(story.createdAt)}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{story.title}</h1>
        {story.url && (
          <a
            href={story.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-sm text-desk-500 underline"
          >
            {story.url}
          </a>
        )}
      </header>

      <Section title="Summary" hint="What the managing editor understood. This is the writers' factual basis.">
        <p className="text-sm whitespace-pre-wrap">{story.summary}</p>
      </Section>

      {story.dropReason && (
        <Section title="Why it was spiked">
          <p className="rounded-md bg-desk-100 px-3 py-2.5 text-sm dark:bg-desk-900">{story.dropReason}</p>
        </Section>
      )}

      {story.holdReason && (
        <Section title="Why it is held" hint="What the filing did not carry. Answer it and re-run.">
          <p className="rounded-md bg-desk-100 px-3 py-2.5 text-sm dark:bg-desk-900">{story.holdReason}</p>
        </Section>
      )}

      {related && (
        <Section
          title={story.dedupVerdict === 'UPDATE' ? 'Follows on from' : 'Matched against'}
          hint="Side by side, so the verdict can be checked rather than taken on trust."
        >
          <button
            onClick={() => navigate(`/stories/${related.id}`)}
            className="block w-full rounded-md border border-desk-200 px-3 py-2.5 text-left dark:border-desk-800"
          >
            <span className="font-medium">{related.title}</span>
            <span className="mt-1 block text-sm text-desk-600 dark:text-desk-400">{related.summary}</span>
          </button>
        </Section>
      )}

      <Section
        title="Placements"
        hint="Proposals, not decisions — where it runs, and when the desk would send it. Zero placements is how the managing editor says “not newsworthy”."
        aside={
          // One draft has its own button on its own row, and "approve all 1"
          // is a decision pretending to be a batch.
          ready.length > 1 && (
            <button
              onClick={() => approveAll.mutate()}
              disabled={approveAll.isPending}
              title="Approves each destination at the time proposed for it. Nothing is rewritten."
              className="rounded-md bg-emerald-600 px-2.5 py-1 text-sm font-medium text-white disabled:opacity-40"
            >
              {approveAll.isPending
                ? 'Approving…'
                : `Approve all ${ready.length} at the proposed times`}
            </button>
          )
        }
      >
        {placements.length === 0 ? (
          <p className="text-sm text-desk-500">No destination was proposed.</p>
        ) : (
          <ul className="space-y-2">
            {placements.map((placement) => (
              <PlacementCard
                key={placement.id}
                placement={placement}
                timezone={timezone}
                approving={
                  approve.isPending && approve.variables?.publicationId === placement.id
                }
                onOpen={() => navigate(`/review/${placement.id}`)}
                onApprove={(at) => approve.mutate({ publicationId: placement.id, ...(at ? { at } : {}) })}
              />
            ))}
          </ul>
        )}

        {approveAll.data && <BulkResult result={approveAll.data} timezone={timezone} />}
        {approve.error && <p className="text-xs text-red-600">{(approve.error as Error).message}</p>}
        {approveAll.error && (
          <p className="text-xs text-red-600">{(approveAll.error as Error).message}</p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <OutletPicker
            outlets={config.data?.config.outlets ?? []}
            taken={placements.map((placement) => placement.outletId)}
            value={outletId}
            onChange={setOutletId}
            disabled={addPlacement.isPending}
          />
          <button
            onClick={() => addPlacement.mutate()}
            disabled={!outletId || addPlacement.isPending}
            className="rounded-md bg-desk-900 px-2.5 py-1 text-sm text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
          >
            Add placement
          </button>
          <button
            onClick={() => rerun.mutate()}
            disabled={rerun.isPending}
            className="rounded-md bg-desk-100 px-2.5 py-1 text-sm text-desk-700 disabled:opacity-40 dark:bg-desk-900 dark:text-desk-300"
          >
            {rerun.isPending ? 'Re-queuing…' : 'Re-run the managing editor'}
          </button>
        </div>
        {addPlacement.error && (
          <p className="text-xs text-red-600">{(addPlacement.error as Error).message}</p>
        )}
        {rerun.isSuccess && (
          <p className="text-xs text-desk-500">Re-queued. The managing editor will re-read the filing.</p>
        )}
      </Section>

      <Section
        title={`Sources (${filings.length})`}
        hint="Every filing that contributed. More than one means two stringers found the same thing."
      >
        <ul className="space-y-2">
          {filings.map((filing) => (
            <li key={filing.id} className="rounded-md border border-desk-200 px-3 py-2.5 dark:border-desk-800">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{filing.stringerName ?? filing.stringerId}</span>
                <Badge>{filing.kind}</Badge>
                <span className="text-xs text-desk-500">{when(filing.receivedAt)}</span>
              </div>
              {filing.considered && (
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-desk-100 p-2.5 font-mono text-xs whitespace-pre-wrap dark:bg-desk-900">
                  {filing.considered}
                </pre>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
