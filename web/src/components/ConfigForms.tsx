import { useState } from 'react'
import type { AppConfig, ConfigIssue, Outlet, PublishMode, Stringer, StringerKind, Voice } from '../api'

/**
 * The plain-prose half of the configuration: the charter, the voices, and who
 * files. None of it is technical — it is the standing brief you would give a
 * colleague — so none of it should look like a document format.
 *
 * Destinations and the reporting block still live in the Advanced editor; they
 * carry the argument spec, which needs the tool catalogue before it can become
 * a form. See IMPLEMENTATION.md 5.2.
 */

// ── issue routing ───────────────────────────────────────────────────────────

/**
 * Validation reports a path per problem. Semantic issues key an outlet by id
 * (`outlets.discord-test.args.channelId`) while shape issues key it by index
 * (`outlets.0.tool`), so a field matches on either.
 */
export function issuesUnder(issues: ConfigIssue[], ...prefixes: string[]): ConfigIssue[] {
  return issues.filter((issue) =>
    prefixes.some((prefix) => issue.path === prefix || issue.path.startsWith(`${prefix}.`)),
  )
}

function firstMessage(issues: ConfigIssue[], ...prefixes: string[]): string | undefined {
  return issuesUnder(issues, ...prefixes)[0]?.message
}

/** Issues that belong to a list itself rather than to one of its rows. */
function listIssues(issues: ConfigIssue[], root: string): ConfigIssue[] {
  return issues.filter((issue) => issue.path === root)
}

// ── ids ─────────────────────────────────────────────────────────────────────

/**
 * An id is a reference, not a name: outlets point at voices by id and the
 * document is keyed by it. So it is derived from the name while a row is new
 * and frozen once it has been saved, which keeps it out of the form without
 * letting a rename break the thing pointing at it.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function uniqueId(base: string, taken: Set<string>): string {
  const root = base || 'new'
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// ── small inputs ────────────────────────────────────────────────────────────

const inputClass =
  'w-full rounded-md border bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm'
const okBorder = 'border-desk-200 focus:border-desk-400 dark:border-desk-800'
const badBorder = 'border-red-500'

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-medium tracking-wide text-desk-500 uppercase">{children}</span>
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  hint?: string
  error?: string
}) {
  return (
    <label className="block space-y-1">
      <Label>{label}</Label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${inputClass} ${error ? badBorder : okBorder}`}
      />
      {hint && !error && <span className="block text-xs text-desk-500">{hint}</span>}
      {error && <span className="block text-xs text-red-600">{error}</span>}
    </label>
  )
}

function AreaField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  rows = 4,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  hint?: string
  error?: string
  rows?: number
}) {
  return (
    <label className="block space-y-1">
      <Label>{label}</Label>
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${inputClass} resize-y leading-relaxed ${error ? badBorder : okBorder}`}
      />
      {hint && !error && <span className="block text-xs text-desk-500">{hint}</span>}
      {error && <span className="block text-xs text-red-600">{error}</span>}
    </label>
  )
}

function Toggle({
  on,
  onChange,
  labelOn,
  labelOff,
}: {
  on: boolean
  onChange: (next: boolean) => void
  labelOn: string
  labelOff: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex items-center gap-2 text-xs text-desk-500"
    >
      <span
        className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          on ? 'bg-emerald-500' : 'bg-desk-300 dark:bg-desk-700'
        }`}
      >
        <span
          className={`size-3 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`}
        />
      </span>
      {on ? labelOn : labelOff}
    </button>
  )
}

function Card({
  title,
  subtitle,
  onRemove,
  removeLabel,
  children,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  onRemove?: () => void
  removeLabel?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {subtitle && <p className="text-xs text-desk-500">{subtitle}</p>}
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded border border-desk-300 px-2 py-0.5 text-xs text-desk-500 hover:text-red-600 dark:border-desk-700"
          >
            {removeLabel ?? 'Remove'}
          </button>
        )}
      </header>
      {children}
    </section>
  )
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-dashed border-desk-300 px-4 py-3 text-sm text-desk-500 hover:border-desk-400 hover:text-desk-700 dark:border-desk-700 dark:hover:text-desk-300"
    >
      {children}
    </button>
  )
}

function ListErrors({ issues }: { issues: ConfigIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul className="space-y-1 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
      {issues.map((issue, i) => (
        <li key={i}>{issue.message}</li>
      ))}
    </ul>
  )
}

export interface FormProps {
  config: AppConfig
  onChange: (next: AppConfig) => void
  issues: ConfigIssue[]
}

// ── charter ─────────────────────────────────────────────────────────────────

export function CharterForm({ config, onChange, issues }: FormProps) {
  const error = firstMessage(issues, 'charter')
  return (
    <div className="space-y-4">
      <p className="text-sm text-desk-500">
        Your standing brief on what runs where. The desk reads it alongside the destinations below
        and proposes a placement for every story. Write it the way you would tell a colleague — what
        goes where, for whom, in what register.
      </p>

      <textarea
        value={config.charter}
        rows={16}
        onChange={(event) => onChange({ ...config, charter: event.target.value })}
        placeholder={
          'Release announcements go to #news, for a general audience: what the app is, who it is for, what is new.\n\nAnything about internals goes to the internal channel, and never further.'
        }
        className={`w-full resize-y rounded-md border bg-transparent px-3 py-2.5 text-base leading-relaxed outline-none md:text-sm ${
          error ? badBorder : okBorder
        }`}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
        <h3 className="text-sm font-medium">What you can send to</h3>
        {config.outlets.length === 0 ? (
          <p className="text-sm text-desk-500">
            No destinations configured yet — nothing can be published until there is one.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {config.outlets.map((outlet) => (
              <li key={outlet.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 translate-y-px rounded-full ${
                    outlet.enabled ? 'bg-emerald-500' : 'bg-desk-300 dark:bg-desk-700'
                  }`}
                />
                <span className="font-medium">{outlet.name}</span>
                <span className="text-xs text-desk-500">{outlet.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── voices ──────────────────────────────────────────────────────────────────

function usersOfVoice(outlets: Outlet[], voiceId: string): string[] {
  return outlets.filter((outlet) => outlet.voice === voiceId).map((outlet) => outlet.name)
}

export function VoicesForm({ config, onChange, issues }: FormProps) {
  // Ids follow the name only while a voice is new; anything already saved is
  // referenced by outlets and must not move under them.
  const [fresh, setFresh] = useState<Set<string>>(new Set())

  const setVoices = (voices: Voice[]) => onChange({ ...config, voices })

  const update = (index: number, patch: Partial<Voice>) => {
    const voices = config.voices.map((voice, i) => (i === index ? { ...voice, ...patch } : voice))
    const current = voices[index]!
    if (patch.name !== undefined && fresh.has(config.voices[index]!.id)) {
      const taken = new Set(voices.filter((_, i) => i !== index).map((v) => v.id))
      const nextId = uniqueId(slugify(patch.name), taken)
      setFresh((prev) => {
        const next = new Set(prev)
        next.delete(config.voices[index]!.id)
        next.add(nextId)
        return next
      })
      voices[index] = { ...current, id: nextId }
    }
    setVoices(voices)
  }

  const add = () => {
    const id = uniqueId('new-voice', new Set(config.voices.map((v) => v.id)))
    setFresh((prev) => new Set(prev).add(id))
    setVoices([...config.voices, { id, name: '', tone: '', audience: '' }])
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-desk-500">
        How the desk writes for a given audience. A destination picks one voice, and every draft for
        it is written in that register.
      </p>

      <ListErrors issues={listIssues(issues, 'voices')} />

      {config.voices.map((voice, index) => {
        const at = (field: string) => firstMessage(issues, `voices.${index}.${field}`, `voices.${voice.id}.${field}`)
        const used = usersOfVoice(config.outlets, voice.id)
        return (
          <Card
            // Keyed by position, not id: a new row's id follows what you type
            // into Name, and a changing key would remount the card and drop
            // focus on every keystroke.
            key={index}
            title={voice.name || 'Untitled voice'}
            subtitle={used.length ? `Used by ${used.join(', ')}` : 'Not used by any destination yet'}
            onRemove={
              used.length
                ? undefined
                : () => setVoices(config.voices.filter((_, i) => i !== index))
            }
          >
            <div className="grid gap-3 md:grid-cols-2">
              <TextField
                label="Name"
                value={voice.name}
                onChange={(name) => update(index, { name })}
                placeholder="Alicia"
                error={at('name')}
              />
              <TextField
                label="Audience"
                value={voice.audience}
                onChange={(audience) => update(index, { audience })}
                placeholder="self-hosters running a personal cloud"
                error={at('audience')}
              />
            </div>
            <TextField
              label="Tone"
              value={voice.tone}
              onChange={(tone) => update(index, { tone })}
              placeholder="concise, technical, anti-hype; never invents a claim"
              error={at('tone')}
            />
            <AreaField
              label="Rules"
              value={voice.rules ?? ''}
              onChange={(rules) => update(index, { rules: rules || undefined })}
              rows={3}
              placeholder="No marketing superlatives. Always say who should care and why."
              hint="Anything the writer must always or never do."
              error={at('rules')}
            />
            <AreaField
              label="Examples"
              value={voice.examples ?? ''}
              onChange={(examples) => update(index, { examples: examples || undefined })}
              rows={3}
              placeholder="A paragraph or two in the voice you want."
              hint="Optional. Shown to the writer as a model of the register."
              error={at('examples')}
            />
            <p className="text-xs text-desk-500">
              Referred to as <code className="font-mono">{voice.id}</code>
              {used.length > 0 && ' — fixed, because destinations point at it'}
            </p>
          </Card>
        )
      })}

      <AddButton onClick={add}>+ Add a voice</AddButton>
    </div>
  )
}

// ── sources ─────────────────────────────────────────────────────────────────

const KINDS: Array<{ id: StringerKind; label: string; blurb: string }> = [
  { id: 'report', label: 'Report', blurb: 'A written report of any depth — "what changed this week, with evidence".' },
  { id: 'timeline', label: 'Timeline', blurb: 'Dated entries. The desk remembers where it got to and never re-reads old ones.' },
  { id: 'snapshot', label: 'Snapshot', blurb: 'The current state of something. The desk reads what changed since last time.' },
  { id: 'tip', label: 'Tip line', blurb: 'A note or a link you file yourself. The desk researches it before proposing anything.' },
]

function KindPicker({
  value,
  onChange,
}: {
  value: StringerKind
  onChange: (next: StringerKind) => void
}) {
  const blurb = KINDS.find((kind) => kind.id === value)?.blurb
  return (
    <div className="space-y-1.5">
      <Label>What arrives</Label>
      <div className="flex flex-wrap gap-1">
        {KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            aria-pressed={value === kind.id}
            onClick={() => onChange(kind.id)}
            className={`rounded-md px-2.5 py-1 text-sm ${
              value === kind.id
                ? 'bg-desk-900 text-white dark:bg-desk-100 dark:text-desk-900'
                : 'bg-desk-100 text-desk-600 dark:bg-desk-900 dark:text-desk-400'
            }`}
          >
            {kind.label}
          </button>
        ))}
      </div>
      {blurb && <p className="text-xs text-desk-500">{blurb}</p>}
    </div>
  )
}

export function SourcesForm({
  config,
  onChange,
  issues,
  ingestToken,
  onRotateToken,
  rotating,
}: FormProps & { ingestToken: string; onRotateToken: () => void; rotating: boolean }) {
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)

  const setStringers = (stringers: Stringer[]) => onChange({ ...config, stringers })

  const update = (index: number, patch: Partial<Stringer>) => {
    const stringers = config.stringers.map((s, i) => (i === index ? { ...s, ...patch } : s))
    if (patch.name !== undefined && fresh.has(config.stringers[index]!.id)) {
      const taken = new Set(stringers.filter((_, i) => i !== index).map((s) => s.id))
      const nextId = uniqueId(slugify(patch.name), taken)
      setFresh((prev) => {
        const next = new Set(prev)
        next.delete(config.stringers[index]!.id)
        next.add(nextId)
        return next
      })
      stringers[index] = { ...stringers[index]!, id: nextId }
    }
    setStringers(stringers)
  }

  const add = () => {
    const id = uniqueId('new-source', new Set(config.stringers.map((s) => s.id)))
    setFresh((prev) => new Set(prev).add(id))
    setStringers([...config.stringers, { id, name: '', kind: 'report', enabled: true }])
  }

  const copy = async () => {
    await navigator.clipboard.writeText(ingestToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-desk-500">
        Who files to the desk. A source describes what arrives, not how it is fetched — the fetching
        lives in whatever workflow does it, and posts here.
      </p>

      <ListErrors issues={listIssues(issues, 'stringers')} />

      {config.stringers.map((stringer, index) => {
        const at = (field: string) =>
          firstMessage(issues, `stringers.${index}.${field}`, `stringers.${stringer.id}.${field}`)
        return (
          <Card
            key={index}
            title={stringer.name || 'Untitled source'}
            subtitle={
              <Toggle
                on={stringer.enabled}
                onChange={(enabled) => update(index, { enabled })}
                labelOn="filing accepted"
                labelOff="paused — filings refused"
              />
            }
            onRemove={() => setStringers(config.stringers.filter((_, i) => i !== index))}
          >
            <TextField
              label="Name"
              value={stringer.name}
              onChange={(name) => update(index, { name })}
              placeholder="GitHub — AppStore releases"
              error={at('name')}
            />
            <KindPicker value={stringer.kind} onChange={(kind) => update(index, { kind })} />
            <AreaField
              label="Narrowing note"
              value={stringer.hint ?? ''}
              onChange={(hint) => update(index, { hint: hint || undefined })}
              rows={2}
              placeholder="user-facing releases only"
              hint="Optional. Narrows a noisy source; your charter still decides where anything runs."
              error={at('hint')}
            />
            <p className="text-xs text-desk-500">
              Files as <code className="font-mono">{stringer.id}</code>
            </p>
          </Card>
        )
      })}

      <AddButton onClick={add}>+ Add a source</AddButton>

      <section className="space-y-2 rounded-lg border border-desk-200 px-4 py-3.5 dark:border-desk-800">
        <h3 className="text-sm font-medium">Filing key</h3>
        <p className="text-sm text-desk-500">
          The password a source uses to file. It is separate from your login, and rotating it stops
          every source until they are given the new one.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-desk-100 px-2 py-1 font-mono text-xs break-all dark:bg-desk-900">
            {ingestToken}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border border-desk-300 px-2.5 py-1 text-xs dark:border-desk-700"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onRotateToken}
            disabled={rotating}
            className="rounded-md border border-desk-300 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-desk-700"
          >
            {rotating ? 'Rotating…' : 'Rotate'}
          </button>
        </div>
        <details className="text-xs text-desk-500">
          <summary className="cursor-pointer">How a source files</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-desk-100 p-2.5 font-mono text-[11px] dark:bg-desk-900">
{`curl -X POST ${window.location.origin}/api/v1/filings \\
  -H "Authorization: Bearer ${ingestToken || '<filing key>'}" \\
  -H "Content-Type: application/json" \\
  -d '{"stringer": "${config.stringers[0]?.id ?? 'source-id'}", "body": "…"}'`}
          </pre>
        </details>
      </section>
    </div>
  )
}

// ── destinations ────────────────────────────────────────────────────────────

/**
 * Mirrors KNOWN_DESTINATION_KEYS in @newsdesk/shared. Display only — the
 * server does the checking; this just avoids showing "unknown" for a tool it
 * plainly knows.
 */
const KNOWN_DESTINATION_ARG: Record<string, string> = {
  'discord-mcp__send_embed': 'channelId',
  'discord-mcp__send_message': 'channelId',
  'telegram-mcp__send_message': 'chatId',
  'telegram-mcp__send_photo': 'chatId',
  'nextcloud-talk-mcp__talk_send_message': 'token',
}

/** The destination as configured, for the summary line. */
function destinationOf(outlet: Outlet): string | undefined {
  const key = outlet.destination_key ?? KNOWN_DESTINATION_ARG[outlet.tool ?? '']
  const value = key ? outlet.args[key] : undefined
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function slotLabels(outlet: Outlet): string[] {
  return Object.values(outlet.args)
    .filter((value): value is { slot: string; label: string; primary?: boolean } =>
      typeof value === 'object' && value !== null && 'slot' in value,
    )
    .map((slot) => `${slot.label}${slot.primary ? ' ★' : ''}`)
}

/**
 * How a browser destination finishes — the one decision on this screen that
 * changes whether the desk sends without you.
 *
 * Worth a control rather than a line in the YAML editor for exactly that
 * reason: it is a one-word change with a large consequence, and burying it in a
 * document nobody reads end to end is how it gets flipped by accident. Each
 * option says what it *does*, not what it is called.
 *
 * A destination marked `requires_human` cannot be set to `auto` at all — the
 * option is shown, disabled, with the reason, because hiding it would make the
 * constraint look like a missing feature.
 */
const PUBLISH_MODES: Array<{ id: PublishMode; label: string; because: string }> = [
  { id: 'auto', label: 'The desk publishes it', because: 'composed, checked and sent at its slot — you are told afterwards' },
  { id: 'tethered', label: 'You press their button', because: 'the desk composes the page and stops; you finish it in the viewer' },
  { id: 'detached', label: 'The desk files a draft', because: 'filed at the destination with a link — finish it in your own browser' },
]

function PublishModePicker({
  outlet,
  onChange,
}: {
  outlet: Outlet
  onChange: (mode: PublishMode) => void
}) {
  const current = outlet.publish ?? 'tethered'

  return (
    <div className="space-y-1.5">
      {PUBLISH_MODES.map((mode) => {
        const forbidden = mode.id === 'auto' && Boolean(outlet.requires_human)
        return (
          <label
            key={mode.id}
            className={`flex gap-2 text-sm ${forbidden ? 'opacity-45' : 'cursor-pointer'}`}
          >
            <input
              type="radio"
              name={`publish-${outlet.id}`}
              checked={current === mode.id}
              disabled={forbidden}
              onChange={() => onChange(mode.id)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{mode.label}</span>
              <span className="block text-xs text-desk-500">
                {forbidden ? 'this destination is marked as requiring a person' : mode.because}
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

export function DestinationsForm({
  config,
  onChange,
  issues,
  onOpenAdvanced,
}: FormProps & { onOpenAdvanced: () => void }) {
  const setOutlets = (outlets: Outlet[]) => onChange({ ...config, outlets })

  return (
    <div className="space-y-4">
      <p className="text-sm text-desk-500">
        Where the desk can send a story. You can switch one off here, and choose how a browser
        destination finishes; adding or rewiring one still happens in{' '}
        <button type="button" onClick={onOpenAdvanced} className="underline underline-offset-2">
          Advanced
        </button>{' '}
        until the destination editor lands.
      </p>

      <ListErrors issues={listIssues(issues, 'outlets')} />

      {config.outlets.length === 0 && (
        <p className="rounded-lg border border-dashed border-desk-300 px-4 py-8 text-center text-sm text-desk-500 dark:border-desk-700">
          No destinations yet. Nothing can be published until there is one.
        </p>
      )}

      {config.outlets.map((outlet, index) => {
        const own = issuesUnder(issues, `outlets.${index}`, `outlets.${outlet.id}`)
        const destination = destinationOf(outlet)
        const voice = config.voices.find((v) => v.id === outlet.voice)
        const slots = slotLabels(outlet)
        return (
          <Card
            key={outlet.id}
            title={outlet.name}
            subtitle={
              <Toggle
                on={outlet.enabled}
                onChange={(enabled) =>
                  setOutlets(config.outlets.map((o, i) => (i === index ? { ...o, enabled } : o)))
                }
                labelOn="in use"
                labelOff="switched off"
              />
            }
          >
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-xs text-desk-500 uppercase">When to use</dt>
              <dd>{outlet.description}</dd>

              <dt className="text-xs text-desk-500 uppercase">Voice</dt>
              <dd>{voice ? voice.name : outlet.role === 'publish' ? '— none set' : 'not needed'}</dd>

              <dt className="text-xs text-desk-500 uppercase">Sends via</dt>
              <dd className="font-mono text-xs break-all">
                {outlet.driver === 'mcp' ? `${outlet.endpoint ?? '?'} · ${outlet.tool ?? '?'}` : outlet.driver}
              </dd>

              <dt className="text-xs text-desk-500 uppercase">Address</dt>
              <dd className="font-mono text-xs break-all">{destination ?? '— not pinned'}</dd>

              {slots.length > 0 && (
                <>
                  <dt className="text-xs text-desk-500 uppercase">You review</dt>
                  <dd>{slots.join(', ')}</dd>
                </>
              )}

              {outlet.driver === 'browser' && (
                <>
                  <dt className="text-xs text-desk-500 uppercase">Finishing</dt>
                  <dd>
                    <PublishModePicker
                      outlet={outlet}
                      onChange={(publish) =>
                        setOutlets(config.outlets.map((o, i) => (i === index ? { ...o, publish } : o)))
                      }
                    />
                  </dd>
                </>
              )}
            </dl>
            {own.length > 0 && <ListErrors issues={own} />}
          </Card>
        )
      })}
    </div>
  )
}
