import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type StoryPlacement } from '../api'
import { Badge, when } from '../components/StoryCard'

/**
 * One story: what the managing editor understood, what it compared against, where it
 * proposed to run it and why, and the filings that contributed.
 *
 * For a duplicate this is the side-by-side that makes the verdict reviewable —
 * a drop you cannot inspect is a drop you cannot trust.
 */

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-xs font-medium tracking-wide text-desk-500 uppercase">{title}</h2>
      {hint && <p className="text-xs text-desk-500">{hint}</p>}
      {children}
    </section>
  )
}

function PlacementCard({ placement, onOpen }: { placement: StoryPlacement; onOpen: () => void }) {
  return (
    <li className="rounded-md border border-desk-200 dark:border-desk-800">
      <button onClick={onOpen} className="w-full px-3 py-2.5 text-left">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{placement.outletName ?? placement.outletId}</span>
        <Badge>{placement.status.toLowerCase()}</Badge>
        {placement.origin === 'human' && <Badge>added by you</Badge>}
      </div>
      {placement.placementReason && (
        <p className="mt-1 text-sm text-desk-600 dark:text-desk-400">{placement.placementReason}</p>
      )}
      {placement.angle && (
        <p className="mt-1.5 rounded bg-desk-100 px-2.5 py-1.5 text-xs text-desk-600 dark:bg-desk-900 dark:text-desk-400">
          <strong className="font-medium">Angle for the writer:</strong> {placement.angle}
        </p>
      )}
      </button>
    </li>
  )
}

export function Story() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [outletId, setOutletId] = useState('')

  const { data, isPending, error } = useQuery({
    queryKey: ['story', id],
    queryFn: () => api.getStory(id!),
    enabled: Boolean(id),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['story', id] })
    void queryClient.invalidateQueries({ queryKey: ['stories'] })
  }

  const rerun = useMutation({ mutationFn: () => api.rerunStory(id!), onSuccess: invalidate })
  const addPlacement = useMutation({
    mutationFn: () => api.addPlacement(id!, { outlet_id: outletId }),
    onSuccess: () => {
      setOutletId('')
      invalidate()
    },
  })

  if (isPending) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>
  if (error || !data) return <div className="px-6 pb-10 text-sm text-desk-500">No such story.</div>

  const { story, filings, placements, related } = data

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
        hint="Proposals, not decisions. Zero placements is how the managing editor says “not newsworthy”."
      >
        {placements.length === 0 ? (
          <p className="text-sm text-desk-500">No destination was proposed.</p>
        ) : (
          <ul className="space-y-2">
            {placements.map((placement) => (
              <PlacementCard key={placement.id} placement={placement} onOpen={() => navigate(`/review/${placement.id}`)} />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <input
            value={outletId}
            onChange={(event) => setOutletId(event.target.value)}
            placeholder="outlet id to add…"
            className="min-w-40 flex-1 rounded-md border border-desk-200 bg-transparent px-2.5 py-1 text-sm outline-none focus:border-desk-400 dark:border-desk-800"
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
