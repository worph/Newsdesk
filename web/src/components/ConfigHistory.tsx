import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type ConfigVersion } from '../api'

/**
 * The way back from a configuration change.
 *
 * Restore is three steps rather than one button on purpose. It can be refused
 * outright — an outlet that publications reference cannot be removed — and it
 * carries one consequence that cannot be undone: an endpoint dropped by a
 * restore loses its authorization, which no snapshot holds. So the preview is
 * not a nicety, and the button stays behind it.
 */

function when(iso: string): string {
  const date = new Date(iso)
  const mins = Math.round((Date.now() - date.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

const AUTHOR_LABEL: Record<string, string> = {
  ui: 'saved here',
  'config.yaml': 'seeded from file',
  assistant: 'assistant remedy',
  restore: 'a restore',
}

function Preview({ id, onDone }: { id: number; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [acknowledged, setAcknowledged] = useState(false)

  const { data, isPending } = useQuery({
    queryKey: ['config-restore-preview', id],
    queryFn: () => api.previewConfigRestore(id),
  })

  const restore = useMutation({
    mutationFn: () => api.restoreConfigVersion(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config'] })
      void queryClient.invalidateQueries({ queryKey: ['config-versions'] })
      onDone()
    },
  })

  if (isPending) return <p className="px-4 py-3 text-sm text-desk-500">Loading…</p>
  if (!data) return null

  const blocked = data.issues.length > 0
  const needsAcknowledgement = data.warnings.length > 0 && !acknowledged

  return (
    <div className="space-y-3 border-t border-desk-200 px-4 py-3 dark:border-desk-800">
      {blocked && (
        <div className="space-y-1 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <p className="font-medium">This version cannot be restored as things stand.</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs">
            {data.issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {data.warnings.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          <p className="font-medium">This would go through, but it cannot be undone:</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs">
            {data.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
          {!blocked && (
            <label className="flex items-center gap-2 pt-1 text-xs">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I understand and want to restore anyway
            </label>
          )}
        </div>
      )}

      <div>
        <h4 className="pb-1 text-xs font-medium tracking-wide text-desk-500 uppercase">
          The version, in full
        </h4>
        <pre className="max-h-72 overflow-auto rounded-md bg-desk-100 p-3 font-mono text-xs dark:bg-desk-900">
          {data.versionYaml}
        </pre>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => restore.mutate()}
          disabled={blocked || needsAcknowledgement || restore.isPending}
          className="rounded-md bg-desk-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-desk-100 dark:text-desk-900"
        >
          {restore.isPending ? 'Restoring…' : 'Restore this version'}
        </button>
        {restore.error && (
          <span className="text-xs text-red-600">{(restore.error as Error).message}</span>
        )}
      </div>
    </div>
  )
}

function Version({ version }: { version: ConfigVersion }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="rounded-lg border border-desk-200 dark:border-desk-800">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-3 px-4 py-2.5 text-left"
      >
        <span className="mt-0.5 w-20 shrink-0 font-mono text-[11px] text-desk-500">
          {when(version.at)}
        </span>
        <span className="min-w-0 flex-1 text-sm">
          {version.reason ?? `Before a change ${AUTHOR_LABEL[version.author] ?? version.author}`}
          <span className="block text-xs text-desk-500">{version.summary}</span>
        </span>
        <span className="shrink-0 text-[11px] text-desk-500">{open ? 'close' : 'review'}</span>
      </button>
      {open && <Preview id={version.id} onDone={() => setOpen(false)} />}
    </li>
  )
}

export function ConfigHistory() {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['config-versions'],
    queryFn: api.listConfigVersions,
    enabled: open,
  })

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed border-desk-300 px-3 py-2 text-xs text-desk-500 hover:border-desk-400 hover:text-desk-700 dark:border-desk-700"
      >
        History — every configuration this desk has had, and the way back to it
      </button>
    )
  }

  const versions = data?.versions ?? []

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wide text-desk-500 uppercase">History</h3>
        <button onClick={() => setOpen(false)} className="text-xs text-desk-500 hover:underline">
          hide
        </button>
      </div>
      <p className="text-xs text-desk-500">
        Each entry is the configuration as it stood immediately before a change. Restoring goes
        through the same validation as any save, and takes its own restore point first.
      </p>
      {versions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-desk-300 px-4 py-6 text-center text-xs text-desk-500 dark:border-desk-700">
          Nothing has changed yet, so there is nothing to go back to.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {versions.map((version) => (
            <Version key={version.id} version={version} />
          ))}
        </ul>
      )}
    </section>
  )
}
