import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError, api, type ConfigIssue } from '../api'

function IssueList({ issues, tone }: { issues: ConfigIssue[]; tone: 'error' | 'ok' }) {
  if (tone === 'ok') {
    return (
      <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
        Valid — no issues.
      </p>
    )
  }
  return (
    <ul className="space-y-1.5 rounded-md bg-red-500/10 px-3 py-2.5 text-sm">
      {issues.map((issue, i) => (
        <li key={i} className="text-red-700 dark:text-red-400">
          {issue.path && <code className="font-mono text-xs opacity-80">{issue.path}</code>}
          {issue.path && ' — '}
          {issue.message}
        </li>
      ))}
    </ul>
  )
}

export function Config() {
  const queryClient = useQueryClient()
  const { data, isPending } = useQuery({ queryKey: ['config'], queryFn: api.getConfig })

  const [yaml, setYaml] = useState('')
  const [dirty, setDirty] = useState(false)
  const [issues, setIssues] = useState<ConfigIssue[] | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (data && !dirty) setYaml(data.yaml)
  }, [data, dirty])

  const validate = useMutation({
    mutationFn: () => api.validateConfig(yaml),
    onSuccess: (result) => setIssues(result.issues),
    onError: (err) => setIssues(err instanceof ApiError ? err.issues : [{ path: '', message: String(err) }]),
  })

  const save = useMutation({
    mutationFn: () => api.saveConfig(yaml),
    onSuccess: (result) => {
      setIssues([])
      setSaved(true)
      setDirty(false)
      setYaml(result.yaml)
      void queryClient.invalidateQueries({ queryKey: ['config'] })
      void queryClient.invalidateQueries({ queryKey: ['health'] })
      setTimeout(() => setSaved(false), 2500)
    },
    onError: (err) => setIssues(err instanceof ApiError ? err.issues : [{ path: '', message: String(err) }]),
  })

  const rotate = useMutation({
    mutationFn: api.rotateIngestToken,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['config'] }),
  })

  function download() {
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'config.yaml'
    link.click()
    URL.revokeObjectURL(url)
  }

  if (isPending) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>

  const busy = validate.isPending || save.isPending

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Configuration</h1>
        <p className="text-sm text-desk-500">
          The charter, voices, stringers and outlets, as one document. Saving validates first — a publish
          outlet that does not pin its destination is rejected, because an unpinned destination posts to
          the bridge default.
        </p>
      </header>

      <textarea
        value={yaml}
        spellCheck={false}
        onChange={(e) => {
          setYaml(e.target.value)
          setDirty(true)
          setIssues(null)
        }}
        className="h-[55vh] w-full resize-y rounded-md border border-desk-300 bg-white p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-desk-500 dark:border-desk-700 dark:bg-desk-900"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => validate.mutate()}
          disabled={busy}
          className="rounded-md border border-desk-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-desk-700"
        >
          Validate
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={busy || !dirty}
          className="rounded-md bg-desk-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={download}
          className="rounded-md border border-desk-300 px-3 py-1.5 text-sm dark:border-desk-700"
        >
          Export
        </button>
        {dirty && <span className="text-xs text-desk-500">unsaved changes</span>}
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">saved</span>}
      </div>

      {issues !== null && <IssueList issues={issues} tone={issues.length ? 'error' : 'ok'} />}

      <section className="space-y-2 border-t border-desk-200 pt-5 dark:border-desk-800">
        <h2 className="text-sm font-medium">Ingest token</h2>
        <p className="text-sm text-desk-500">
          Stringers present this as <code className="font-mono text-xs">Authorization: Bearer …</code> when
          filing to <code className="font-mono text-xs">/api/v1/filings</code>. It is separate from your
          session and can be rotated.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-desk-100 px-2 py-1 font-mono text-xs break-all dark:bg-desk-900">
            {data?.ingestToken}
          </code>
          <button
            onClick={() => rotate.mutate()}
            className="rounded-md border border-desk-300 px-2.5 py-1 text-xs dark:border-desk-700"
          >
            Rotate
          </button>
        </div>
      </section>
    </div>
  )
}
