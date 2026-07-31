import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { StoryCard } from '../components/StoryCard'

/**
 * One browser with filters — awaiting, spiked, needs-context, everything.
 *
 * The spiked filter is where invariant 6 lives: every drop with its reason,
 * and for a duplicate, the story it matched. A drop that nobody can see is
 * indistinguishable from a pipeline that silently failed.
 */

const FILTERS = [
  { key: 'all', label: 'All', status: undefined },
  { key: 'awaiting', label: 'Awaiting', status: 'PLACED' },
  { key: 'spiked', label: 'Spiked', status: 'DROPPED' },
  { key: 'context', label: 'Needs context', status: 'NEEDS_CONTEXT' },
] as const

export function Stories() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all')
  const [query, setQuery] = useState('')

  const active = FILTERS.find((f) => f.key === filter)!

  const { data, isPending } = useQuery({
    queryKey: ['stories', filter, query],
    queryFn: () =>
      api.listStories({
        ...(active.status ? { status: active.status } : {}),
        ...(query ? { q: query } : {}),
        limit: 150,
      }),
  })

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Stories</h1>
        <p className="text-sm text-desk-500">
          Everything the managing editor opened, including what it dropped and why.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            onClick={() => setFilter(option.key)}
            className={`rounded-md px-2.5 py-1 text-sm ${
              filter === option.key
                ? 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
                : 'bg-desk-100 text-desk-600 dark:bg-desk-900 dark:text-desk-400'
            }`}
          >
            {option.label}
          </button>
        ))}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search title and summary…"
          className="ml-auto min-w-48 flex-1 rounded-md border border-desk-200 bg-transparent px-2.5 py-1 text-sm outline-none focus:border-desk-400 dark:border-desk-800"
        />
      </div>

      {isPending ? (
        <p className="text-sm text-desk-500">Loading…</p>
      ) : data!.stories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-desk-300 px-4 py-10 text-center dark:border-desk-700">
          <p className="text-sm text-desk-500">Nothing matches.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {data!.stories.map((story) => (
            <StoryCard key={story.id} story={story} onOpen={() => navigate(`/stories/${story.id}`)} />
          ))}
        </ul>
      )}
    </div>
  )
}
