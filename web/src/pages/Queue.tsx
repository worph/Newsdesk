import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { StoryCard } from '../components/StoryCard'

/**
 * The gate: everything awaiting a decision, oldest first. This screen is just
 * the list of things standing at the gate — the gate itself is enforced at
 * review, where approve is the only path to the wire.
 */
export function Queue() {
  const navigate = useNavigate()

  const { data, isPending } = useQuery({
    queryKey: ['stories', 'queue'],
    queryFn: () => api.listStories({ status: 'ROUTED,NEEDS_CONTEXT', limit: 100 }),
    refetchInterval: 30_000,
  })

  const { data: jobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.listJobs,
    refetchInterval: 10_000,
  })

  if (isPending) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>

  const stories = [...data!.stories].reverse() // oldest first: the queue is a backlog
  const working = (jobs?.stats.pending ?? 0) + (jobs?.stats.running ?? 0)

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Queue</h1>
        <p className="text-sm text-desk-500">
          Stories awaiting a decision, oldest first. Each chip is one destination the director proposed —
          approving one never ships the others.
        </p>
        {working > 0 && (
          <p className="text-xs text-desk-500">
            {working} submission{working === 1 ? '' : 's'} still with the director…
          </p>
        )}
      </header>

      {stories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-desk-300 px-4 py-10 text-center dark:border-desk-700">
          <p className="text-sm text-desk-500">Nothing waiting.</p>
          <p className="mt-1 text-xs text-desk-500">
            Stories the director routed appear here. Spiked ones are under Stories.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {stories.map((story) => (
            <StoryCard key={story.id} story={story} onOpen={() => navigate(`/stories/${story.id}`)} />
          ))}
        </ul>
      )}
    </div>
  )
}
