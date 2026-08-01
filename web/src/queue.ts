import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/**
 * The two halves of the queue, as one definition.
 *
 * The Queue screen renders them and the sidebar counts them, and they must
 * never disagree about what "waiting" means — a badge that says 3 over a screen
 * showing 2 is worse than no badge. Same keys, same query: react-query serves
 * both from one fetch.
 */

/** A story the managing editor placed, or held pending an answer. */
export const PLACEMENT_STATUS = 'PLACED,HELD'

/**
 * A finished draft, or one whose send failed. FAILED belongs in the queue
 * because it is still waiting on a person — the desk cannot fix a refused
 * delivery on its own.
 */
export const ARTICLE_STATUS = 'AWAITING_APPROVAL,FAILED'

export function usePlacementQueue() {
  return useQuery({
    queryKey: ['stories', 'queue'],
    queryFn: () => api.listStories({ status: PLACEMENT_STATUS, limit: 100 }),
    refetchInterval: 30_000,
  })
}

export function useArticleQueue() {
  return useQuery({
    queryKey: ['publications', 'queue'],
    queryFn: () => api.listPublications({ status: ARTICLE_STATUS, limit: 100 }),
    refetchInterval: 30_000,
  })
}
