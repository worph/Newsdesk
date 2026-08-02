import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError, api, type AppConfig, type ConfigInput, type ConfigIssue } from '../api'
import {
  CharterForm,
  DestinationsForm,
  SourcesForm,
  VoicesForm,
} from '../components/ConfigForms'
import { ConfigHistory } from '../components/ConfigHistory'

/**
 * One configuration, two ways in: forms for the parts that are prose, and the
 * document itself for the parts that are not (yet). They are never two sources
 * of truth — switching between them round-trips through the server, which owns
 * both the object model and its rendering, and the save path is the same
 * `writeConfig` either way.
 */

type TabId = 'charter' | 'voices' | 'sources' | 'destinations' | 'advanced'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'charter', label: 'Charter' },
  { id: 'voices', label: 'Voices' },
  { id: 'sources', label: 'Sources' },
  { id: 'destinations', label: 'Destinations' },
  { id: 'advanced', label: 'Advanced' },
]

/** Which tab owns a validation issue, by the root of its path. */
function tabOf(issue: ConfigIssue): TabId {
  const root = issue.path.split(/[.[]/, 1)[0]
  if (root === 'charter') return 'charter'
  if (root === 'voices') return 'voices'
  if (root === 'stringers') return 'sources'
  if (root === 'outlets') return 'destinations'
  // mcp_endpoints, reporting, and anything unplaced: the editor is the only
  // place they can be fixed, so that is where the badge goes.
  return 'advanced'
}

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

  const [tab, setTab] = useState<TabId>('charter')
  const [draft, setDraft] = useState<AppConfig | null>(null)
  const [yaml, setYaml] = useState('')
  /** Which view was edited last — that one is the candidate to validate and save. */
  const [edited, setEdited] = useState<'none' | 'form' | 'yaml'>('none')
  const [issues, setIssues] = useState<ConfigIssue[] | null>(null)
  const [saved, setSaved] = useState(false)
  const [switching, setSwitching] = useState(false)

  const dirty = edited !== 'none'

  useEffect(() => {
    if (data && !dirty) {
      setDraft(data.config)
      setYaml(data.yaml)
    }
  }, [data, dirty])

  const candidate = (): ConfigInput => (edited === 'yaml' ? { yaml } : { config: draft! })

  const validate = useMutation({
    mutationFn: () => api.validateConfig(candidate()),
    onSuccess: (result) => {
      setIssues(result.issues)
      // Keep the other view in step with what was just checked.
      setDraft(result.config)
      setYaml(result.yaml)
    },
    onError: (err) => setIssues(err instanceof ApiError ? err.issues : [{ path: '', message: String(err) }]),
  })

  const save = useMutation({
    mutationFn: () => api.saveConfig(candidate()),
    onSuccess: (result) => {
      setIssues([])
      setSaved(true)
      setEdited('none')
      setDraft(result.config)
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

  /**
   * Moving between the forms and the editor converts the pending edit. A
   * candidate that cannot be parsed has no other rendering, so the move is
   * refused rather than silently showing the stale one.
   */
  const goTo = async (next: TabId) => {
    const crossing = (next === 'advanced') !== (tab === 'advanced')
    if (!crossing || !dirty) {
      setTab(next)
      return
    }
    setSwitching(true)
    try {
      const result = await api.validateConfig(candidate())
      setDraft(result.config)
      setYaml(result.yaml)
      setEdited(next === 'advanced' ? 'yaml' : 'form')
      setIssues(result.issues)
      setTab(next)
    } catch (err) {
      setIssues(err instanceof ApiError ? err.issues : [{ path: '', message: String(err) }])
    } finally {
      setSwitching(false)
    }
  }

  function download() {
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'config.yaml'
    link.click()
    URL.revokeObjectURL(url)
  }

  if (isPending || !draft) return <div className="px-6 pb-10 text-sm text-desk-500">Loading…</div>

  const busy = validate.isPending || save.isPending || switching
  const shown = issues ?? data?.issues ?? []
  const counts = shown.reduce<Record<string, number>>((acc, issue) => {
    const id = tabOf(issue)
    acc[id] = (acc[id] ?? 0) + 1
    return acc
  }, {})

  const onFormChange = (next: AppConfig) => {
    setDraft(next)
    setEdited('form')
    setIssues(null)
  }

  const formProps = { config: draft, onChange: onFormChange, issues: shown }

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 pb-16 md:px-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Configuration</h1>
        <p className="text-sm text-desk-500">
          What the desk covers, how it writes, and where it sends. Saving checks the whole thing
          first — a destination that does not pin its address is refused, because an unpinned
          address posts wherever the bridge happens to default to.
        </p>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-desk-200 dark:border-desk-800">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => void goTo(entry.id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === entry.id
                ? 'border-desk-900 font-medium dark:border-desk-100'
                : 'border-transparent text-desk-500 hover:text-desk-700 dark:hover:text-desk-300'
            }`}
          >
            {entry.label}
            {counts[entry.id] && (
              <span className="rounded-full bg-red-500/15 px-1.5 text-[11px] text-red-700 dark:text-red-400">
                {counts[entry.id]}
              </span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'charter' && <CharterForm {...formProps} />}
      {tab === 'voices' && <VoicesForm {...formProps} />}
      {tab === 'sources' && (
        <SourcesForm
          {...formProps}
          ingestToken={data?.ingestToken ?? ''}
          onRotateToken={() => rotate.mutate()}
          rotating={rotate.isPending}
        />
      )}
      {tab === 'destinations' && (
        <DestinationsForm {...formProps} onOpenAdvanced={() => void goTo('advanced')} />
      )}
      {tab === 'advanced' && (
        <div className="space-y-3">
          <p className="text-sm text-desk-500">
            The whole configuration as one document — the only place endpoints, destination
            arguments and the research block can be edited for now. Everything the forms above
            change ends up here, and nothing here is lost by using them.
          </p>
          <textarea
            value={yaml}
            spellCheck={false}
            onChange={(e) => {
              setYaml(e.target.value)
              setEdited('yaml')
              setIssues(null)
            }}
            className="h-[55vh] w-full resize-y rounded-md border border-desk-300 bg-white p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-desk-500 dark:border-desk-700 dark:bg-desk-900"
          />
        </div>
      )}

      {issues !== null && <IssueList issues={issues} tone={issues.length ? 'error' : 'ok'} />}

      <ConfigHistory />

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-desk-200 bg-desk-50/95 py-3 backdrop-blur dark:border-desk-800 dark:bg-desk-950/95">
        <button
          onClick={() => validate.mutate()}
          disabled={busy}
          className="rounded-md border border-desk-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-desk-700"
        >
          Check
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
    </div>
  )
}
