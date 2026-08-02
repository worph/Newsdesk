import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, type StagedPage } from '../api'
import { Badge } from '../components/StoryCard'

/**
 * Publishing somewhere the desk cannot reach on its own.
 *
 * The page is composed here and now — opening this screen is what takes the
 * browser and types the approved copy into the destination's own composer. Then
 * it stops, and a person presses the destination's own button. That last click
 * is the point of the whole feature: it is what makes this safe against sites
 * whose terms require a human, and it is why no model is anywhere in this path.
 *
 * Nothing on this screen can change what goes out. The bytes were frozen at
 * approval and the desk has already read them back off the page and compared
 * them before showing you anything.
 *
 * See docs/browser-publishing.md sections 4 and 6.
 */

/** While the live view is open the lease is ours; say so often enough to keep it. */
const KEEPALIVE_MS = 60_000

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-xs">
      <div className="text-desk-500">{label}</div>
      <div className="text-desk-800 dark:text-desk-200">{children}</div>
    </div>
  )
}

export function Live() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [staged, setStaged] = useState<StagedPage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** The sign-in page is open in the browser and the lease is ours. */
  const [opened, setOpened] = useState(false)

  const detail = useQuery({
    queryKey: ['publication', id],
    queryFn: () => api.getPublication(id!),
    enabled: Boolean(id),
  })

  /**
   * Enabled for both halves of this screen: the sign-in handoff and the staged
   * page use the same viewer, pointed at the same browser. One mechanism.
   */
  const viewerInfo = useQuery({
    queryKey: ['viewer', id],
    queryFn: () => api.getViewer(id!),
    enabled: Boolean(id) && (Boolean(staged) || opened),
  })

  /**
   * Staging runs once per visit and takes the browser with it. It is a mutation
   * rather than a query on purpose — a query that retried on focus would
   * re-type an approved post into a live composer every time the operator
   * switched tabs.
   */
  const stage = useMutation({
    mutationFn: () => api.stagePublication(id!),
    onSuccess: (page) => {
      setStaged(page)
      setBusy(null)
      setFailed(null)
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) setBusy(err.message)
      else setFailed(err instanceof Error ? err.message : String(err))
    },
  })

  const sent = useMutation({
    mutationFn: () => api.markSent(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['publication', id] })
      void queryClient.invalidateQueries({ queryKey: ['publications'] })
      navigate(`/review/${id}`)
    },
  })

  const notSent = useMutation({
    mutationFn: () => api.markNotSent(id!),
    onSuccess: () => {
      setStaged(null)
      navigate('/queue')
    },
  })

  /**
   * The browser is signed out of the destination. Verified by the desk, not
   * taken on trust — clicking too early would otherwise publish into a login
   * page.
   */
  const signedIn = useMutation({
    mutationFn: () => api.confirmSignedIn(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publication', id] }),
  })

  /**
   * Put the destination's login page in front of them and hold the browser.
   * The viewer on its own would show a blank window — the browser starts
   * lazily, is reaped when idle, and nothing else points it at this outlet.
   */
  const openSignIn = useMutation({
    mutationFn: () => api.openSignIn(id!),
    onSuccess: () => setOpened(true),
  })

  const status = detail.data?.publication.status

  // Open the login page on arrival, for the same reason staging happens on
  // arrival: the browser is only worth taking once somebody is looking.
  useEffect(() => {
    if (!id || status !== 'NEEDS_AUTH') return
    if (opened || openSignIn.isPending || openSignIn.isError) return
    openSignIn.mutate()
  }, [id, status, opened, openSignIn])

  // Hold the browser while they are typing a password into it, and give it back
  // on the way out.
  useEffect(() => {
    if (!id || !opened) return
    const timer = setInterval(() => void api.keepBrowserAlive(id).catch(() => undefined), KEEPALIVE_MS)
    return () => {
      clearInterval(timer)
      void api.markNotSent(id).catch(() => undefined)
    }
  }, [id, opened])

  // Compose on arrival, but only for a row that is actually waiting to be sent.
  useEffect(() => {
    if (!id || status !== 'AWAITING_SEND') return
    if (staged || stage.isPending || busy || failed) return
    stage.mutate()
  }, [id, status, staged, stage, busy, failed])

  // Hold the browser while this screen is open, and give it back on the way out
  // rather than making the next person wait for the lease to time out.
  useEffect(() => {
    if (!id || !staged) return
    const timer = setInterval(() => void api.keepBrowserAlive(id).catch(() => undefined), KEEPALIVE_MS)
    return () => {
      clearInterval(timer)
      void api.markNotSent(id).catch(() => undefined)
    }
    // Only the identity of the staged page matters; re-running on every render
    // would release the lease it just took.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, staged?.stagedAt])

  // Someone else has it. Try again on a slow loop rather than making them
  // refresh — the wait is normally a minute or two.
  useEffect(() => {
    if (!busy || !id) return
    const timer = setTimeout(() => {
      setBusy(null)
      stage.mutate()
    }, 15_000)
    return () => clearTimeout(timer)
  }, [busy, id, stage])

  if (detail.isPending) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>
  if (!detail.data) return <div className="px-6 pb-10 text-sm text-desk-500">No such publication.</div>

  const { publication, story, outlet } = detail.data

  /**
   * The sign-in handoff. The same viewer, pointed at the destination's own
   * login page: the operator signs in with their own credentials, in a browser
   * the desk drives but whose cookie jar it never reads.
   */
  if (status === 'NEEDS_AUTH') {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 pb-16 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => navigate('/queue')} className="text-sm text-desk-500 hover:text-desk-700">
            ← the queue
          </button>
          <span className="text-desk-300 dark:text-desk-700">·</span>
          <Badge tone="bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900">{outlet.name}</Badge>
          <Badge>signed out</Badge>
        </div>

        <h1 className="text-lg font-medium text-desk-900 dark:text-desk-100">{story.title}</h1>

        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <strong>The desk's browser is signed out of {outlet.name}.</strong> Sign in below with your own
          account, then press <em>I'm signed in</em>. Nothing goes out until you do — the post is
          approved and waiting.
        </div>

        {openSignIn.isError && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <p>
              <strong>Could not open {outlet.name} in the browser.</strong>{' '}
              {(openSignIn.error as Error).message}
            </p>
            <button
              onClick={() => openSignIn.mutate()}
              className="mt-2 rounded-md bg-red-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
            >
              Try again
            </button>
          </div>
        )}

        {!opened && !openSignIn.isError && (
          <div className="rounded-lg border border-desk-200 p-6 text-sm text-desk-600 dark:border-desk-800 dark:text-desk-400">
            Starting the browser and opening {outlet.name}…
          </div>
        )}

        {opened &&
          (viewerInfo.data?.kind === 'novnc' && viewerInfo.data.url ? (
            <div className="overflow-hidden rounded-lg border border-desk-200 dark:border-desk-800">
              <iframe
                src={viewerInfo.data.url}
                title={`sign in to ${outlet.name}`}
                className="h-[70vh] w-full bg-black"
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            </div>
          ) : (
            <p className="text-sm text-desk-600 dark:text-desk-400">
              This engine has no viewer — sign in using the browser directly, then press the button
              below.
            </p>
          ))}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => signedIn.mutate()}
            disabled={signedIn.isPending}
            className="rounded-md bg-desk-900 px-4 py-2 text-sm font-medium text-white hover:bg-desk-700 disabled:opacity-50 dark:bg-desk-100 dark:text-desk-900"
          >
            {signedIn.isPending ? 'Checking…' : "I'm signed in"}
          </button>
          <span className="text-xs text-desk-500">
            The desk checks the page itself before it will publish.
          </span>
        </div>

        {signedIn.error && (
          <p className="text-sm text-red-700 dark:text-red-300">{(signedIn.error as Error).message}</p>
        )}
      </div>
    )
  }

  if (status !== 'AWAITING_SEND') {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 pb-16 md:px-6">
        <button onClick={() => navigate(`/review/${id}`)} className="text-sm text-desk-500 hover:text-desk-700">
          ← back to the draft
        </button>
        <div className="rounded-lg border border-desk-200 p-4 text-sm dark:border-desk-800">
          This is <strong>{publication.status.toLowerCase().replace(/_/g, ' ')}</strong>, not waiting to be
          published. There is nothing to open in the browser.
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 pb-16 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => navigate(`/review/${id}`)} className="text-sm text-desk-500 hover:text-desk-700">
          ← the draft
        </button>
        <span className="text-desk-300 dark:text-desk-700">·</span>
        <Badge tone="bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900">{outlet.name}</Badge>
        <Badge>publish by hand</Badge>
      </div>

      <h1 className="text-lg font-medium text-desk-900 dark:text-desk-100">{story.title}</h1>

      {busy && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {busy}. Waiting for the browser…
        </div>
      )}

      {failed && (
        <div className="space-y-3 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p>
            <strong>The desk could not compose this.</strong> Nothing was sent.
          </p>
          <p className="font-mono text-xs">{failed}</p>
          <p className="text-xs">
            The draft is unchanged and still approved. Fix the recipe or the sign-in, then try again.
          </p>
          <button
            onClick={() => {
              setFailed(null)
              stage.mutate()
            }}
            className="rounded-md bg-red-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
          >
            Try again
          </button>
        </div>
      )}

      {stage.isPending && !staged && (
        <div className="rounded-lg border border-desk-200 p-6 text-sm text-desk-600 dark:border-desk-800 dark:text-desk-400">
          Opening {outlet.name} and typing the approved copy… this takes a few seconds.
        </div>
      )}

      {staged && (
        <>
          {/*
            The recipe's own words, verbatim. The cookbook is one document —
            what the desk did and what the person does next are two halves of
            the same instruction, and paraphrasing here would make them drift.
          */}
          <div className="rounded-lg border border-desk-200 bg-desk-50 p-4 dark:border-desk-800 dark:bg-desk-900">
            <div className="text-xs font-medium uppercase tracking-wide text-desk-500">Your turn</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-desk-800 dark:text-desk-200">
              {staged.handover}
            </p>
            <div className="mt-3 flex flex-wrap gap-6">
              <Stat label="composed">{new Date(staged.stagedAt).toLocaleTimeString()}</Stat>
              <Stat label="copy checked">byte for byte against what you approved</Stat>
            </div>
          </div>

          {viewerInfo.data?.kind === 'novnc' && viewerInfo.data.url ? (
            <div className="overflow-hidden rounded-lg border border-desk-200 dark:border-desk-800">
              <iframe
                src={viewerInfo.data.url}
                title={`${outlet.name} in the desk's browser`}
                className="h-[70vh] w-full bg-black"
                // The browser holds live sessions; nothing in this frame should
                // be able to reach back out into the desk.
                sandbox="allow-scripts allow-same-origin allow-forms"
              />
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-desk-200 p-4 dark:border-desk-800">
              <p className="text-sm text-desk-600 dark:text-desk-400">
                This engine has no viewer — the page is open in the browser you are already in front of.
              </p>
              {staged.screenshotPath && (
                <img
                  src={`/api/v1/browser/screenshot/${staged.screenshotPath}`}
                  alt="the composed page"
                  className="w-full rounded border border-desk-200 dark:border-desk-800"
                />
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => sent.mutate()}
              disabled={sent.isPending}
              className="rounded-md bg-desk-900 px-4 py-2 text-sm font-medium text-white hover:bg-desk-700 disabled:opacity-50 dark:bg-desk-100 dark:text-desk-900"
            >
              {sent.isPending ? 'Recording…' : 'I published it'}
            </button>
            <button
              onClick={() => notSent.mutate()}
              disabled={notSent.isPending}
              className="rounded-md border border-desk-300 px-4 py-2 text-sm hover:bg-desk-100 disabled:opacity-50 dark:border-desk-700 dark:hover:bg-desk-800"
            >
              Not now
            </button>
            <span className="text-xs text-desk-500">
              “Not now” keeps the slot and frees the browser. The desk will remind you.
            </span>
          </div>

          {sent.error && (
            <p className="text-sm text-red-700 dark:text-red-300">{(sent.error as Error).message}</p>
          )}
        </>
      )}
    </div>
  )
}
