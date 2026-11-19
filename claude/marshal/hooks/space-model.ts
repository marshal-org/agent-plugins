// Pure logic of the space inspector: which tool feeds each tab, and turning
// each tool's JSON into rows. Formatters are tolerant: a field a server does
// not send is left out, never shown as "undefined".

import type { InspectorLine } from '../types'
import { age, cut, plainText } from './fleet-model'

export type TabId = 'overview' | 'audit' | 'requests' | 'reviews' | 'ports' | 'changes' | 'cost'

// The orchestration scope resolves "self" to the space (and run) the
// credential belongs to, so the inspector never needs to know an id.
export const SELF = 'self'

export type TabSpec = { id: TabId; label: string; tool: string; args: Record<string, unknown> }

// Servers with spaces_changes and spaces_usage read the space itself, so a
// space with no run (an interactive one) still shows its changes and cost.
const SPACE_READS: Partial<Record<TabId, Pick<TabSpec, 'tool' | 'args'>>> = {
  changes: { tool: 'spaces_changes', args: { space: SELF } },
  cost: { tool: 'spaces_usage', args: { space: SELF } },
}

export const TABS: readonly TabSpec[] = [
  { id: 'overview', label: 'Overview', tool: 'spaces_get', args: { space: SELF } },
  { id: 'audit', label: 'Audit', tool: 'spaces_audit', args: { space: SELF } },
  { id: 'requests', label: 'Requests', tool: 'spaces_requests_list', args: { space_id: SELF } },
  { id: 'reviews', label: 'Reviews', tool: 'spaces_reviews_list', args: { space_id: SELF } },
  { id: 'ports', label: 'Ports', tool: 'spaces_ports', args: { space: SELF } },
  { id: 'changes', label: 'Changes', tool: 'runs_changes', args: { run_id: SELF } },
  { id: 'cost', label: 'Cost', tool: 'runs_usage', args: { run_id: SELF } },
]

export function tabSpec(id: string, spaceReads = false): TabSpec {
  const spec = TABS.find(t => t.id === id) ?? (TABS[0] as TabSpec)
  const alt = spaceReads ? SPACE_READS[spec.id] : undefined
  return alt ? { ...spec, ...alt } : spec
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function s(v: unknown): string {
  if (typeof v === 'string') return plainText(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

// The rows of a list answer: the answer itself when it is an array, else its
// first array field (events, requests, ports, files, items, ...).
export function rowsOf(v: unknown, prefer: readonly string[] = []): unknown[] {
  if (Array.isArray(v)) return v
  const o = obj(v)
  for (const k of prefer) if (Array.isArray(o[k])) return o[k] as unknown[]
  for (const val of Object.values(o)) if (Array.isArray(val)) return val
  return []
}

function line(text: string, tone: InspectorLine['tone'] = '', href = ''): InspectorLine {
  return { text, tone, href }
}

function fact(key: string, text: string): InspectorLine {
  return { text, tone: '', href: '', key }
}

const BAD = new Set(['denied', 'error', 'blocked', 'policy_break', 'failed'])

export function formatOverview(v: unknown): InspectorLine[] {
  const o = obj(obj(v).space ?? v)
  const out: InspectorLine[] = []
  const name = s(o.name) || s(o.id)
  if (name) out.push(line(`${name}${o.state ? ` · ${s(o.state)}` : ''}`))
  for (const [label, key] of [
    ['id', 'id'],
    ['owner', 'user_name'],
    ['run', 'run_id'],
    ['started', 'started_at'],
    ['last activity', 'last_activity_at'],
    ['last stop', 'last_stop_reason'],
    ['last error', 'last_error'],
    ['restarts', 'restart_count'],
    ['last OOM', 'last_oom_at'],
  ] as const) {
    const val = s(o[key])
    if (val && !(key === 'id' && val === name)) out.push(fact(label, val))
  }
  return out.length > 0 ? out : [line('No details returned.', 'dim')]
}

export function formatAudit(v: unknown, now: number, max = 50): InspectorLine[] {
  const rows = rowsOf(v, ['events']).slice(0, max)
  if (rows.length === 0) return [line('No audit events yet.', 'dim')]
  return rows.map(r => {
    const e = obj(r)
    const status = s(e.status)
    const meta = obj(e.metadata)
    const target = s(meta.host) || s(meta.url) || s(meta.command) || s(meta.tool) || s(e.resource_id)
    const who = s(e.user_name)
    const text = [age(s(e.created_at), now), s(e.action), target, status && status !== 'ok' ? status.toUpperCase() : '', who]
      .filter(Boolean)
      .join('  ')
    return line(text, BAD.has(status) ? 'error' : '')
  })
}

export function formatRequests(v: unknown, now: number): InspectorLine[] {
  const rows = rowsOf(v, ['items', 'requests'])
  if (rows.length === 0) return [line('No requests.', 'dim')]
  return rows.map(r => {
    const q = obj(r)
    const p = obj(q.payload)
    const what = s(p.question) || s(p.filename) || s(p.host) || s(p.title) || s(p.tool) || s(p.reason)
    const status = s(q.status)
    const text = [age(s(q.created_at), now), s(q.type), what, status].filter(Boolean).join('  ')
    return line(text, status === 'pending' ? 'warning' : status === 'denied' ? 'error' : 'dim')
  })
}

export function formatReviews(v: unknown, now: number): InspectorLine[] {
  const rows = rowsOf(v, ['items', 'reviews'])
  if (rows.length === 0) return [line('No reviews.', 'dim')]
  return rows.map(r => {
    const q = obj(r)
    const status = s(q.status)
    const text = [age(s(q.created_at), now), q.port ? `port ${s(q.port)}` : '', status].filter(Boolean).join('  ')
    return line(text, status === 'pending' ? 'warning' : 'dim')
  })
}

export function formatPorts(v: unknown): InspectorLine[] {
  const rows = rowsOf(v, ['ports'])
  if (rows.length === 0) return [line('Nothing is listening.', 'dim')]
  return rows.map(r => {
    const p = obj(r)
    const scheme = s(p.scheme)
    const text = [`:${s(p.port)}`, scheme || 'tcp', s(p.process)].filter(Boolean).join('  ')
    return line(text, scheme === 'http' || scheme === 'https' ? '' : 'dim', s(p.preview_url) || s(p.url))
  })
}

export function formatChanges(v: unknown): InspectorLine[] {
  const o = obj(v)
  const repos = Array.isArray(o.repos) ? o.repos : []
  const out: InspectorLine[] = []
  for (const r of repos) {
    const repo = obj(r)
    const files = rowsOf(repo, ['files'])
    out.push(line(`${s(repo.name) || 'checkout'} · ${files.length} file${files.length === 1 ? '' : 's'}`))
    for (const f of files.slice(0, 40)) {
      const file = obj(f)
      const stat = [file.added !== undefined ? `+${s(file.added)}` : '', file.removed !== undefined ? `-${s(file.removed)}` : '']
        .filter(Boolean)
        .join(' ')
      out.push(line(`  ${s(file.status)} ${s(file.path)} ${stat}`.trimEnd(), 'dim'))
    }
  }
  if (out.length === 0) {
    const files = rowsOf(v, ['files'])
    for (const f of files.slice(0, 40)) out.push(line(s(obj(f).path), 'dim'))
  }
  return out.length > 0 ? out : [line('No changes.', 'dim')]
}

function money(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : ''
}

// Reads both answers: a run's (runs_usage: LLM fields at the top) and a
// space's (spaces_usage: LLM fields under llm_cost, like the web's Costs tab).
export function formatCost(v: unknown): InspectorLine[] {
  const o = obj(obj(v).usage ?? v)
  const llm = o.llm_cost !== undefined ? obj(o.llm_cost) : o
  const out: InspectorLine[] = []
  if (llm.available === false && o.compute_cost === undefined) return [line('No usage recorded yet.', 'dim')]
  const total = money(o.combined_est_cost_usd) || money(llm.total_est_cost_usd)
  if (total) out.push(fact('total', total))
  const llmCost = money(llm.total_est_cost_usd)
  if (llmCost) out.push(fact('model', llmCost))
  const sources = (Array.isArray(llm.by_source) ? llm.by_source : []).map(src => {
    const b = obj(src)
    const n = typeof b.est_cost_usd === 'number' ? b.est_cost_usd : typeof b.total_est_cost_usd === 'number' ? b.total_est_cost_usd : NaN
    return { name: s(b.model) || s(b.source) || s(b.name), usd: n }
  })
  const top = Math.max(0, ...sources.map(x => (Number.isFinite(x.usd) ? x.usd : 0)))
  for (const x of sources) {
    const cost = money(x.usd)
    if (x.name && cost) out.push({ text: cost, tone: '', href: '', key: x.name, bar: top > 0 ? x.usd / top : 0 })
  }
  const compute = obj(o.compute_cost)
  const computeCost = money(compute.total_est_cost_usd) || money(compute.est_cost_usd) || money(compute.cost_usd)
  if (computeCost) out.push(fact('compute', `${computeCost}${compute.estimated === true ? ' (estimated)' : ''}`))
  const convs = Array.isArray(llm.conversations) ? llm.conversations : []
  for (const c of convs.slice(0, 10)) {
    const x = obj(c)
    const turns = typeof x.turns === 'number' ? `${x.turns} turn${x.turns === 1 ? '' : 's'}` : ''
    const win = typeof x.context_window === 'number' && x.context_window > 0 && typeof x.context_tokens === 'number'
      ? `context ${Math.round((x.context_tokens / x.context_window) * 100)}%`
      : ''
    const text = [money(x.est_cost_usd), s(x.model), turns, win].filter(Boolean).join(' · ')
    if (text) out.push(fact(cut(s(x.label) || 'conversation', 16), text))
  }
  return out.length > 0 ? out : [line('No usage reported yet.', 'dim')]
}

export function format(tab: TabId, v: unknown, now: number): InspectorLine[] {
  switch (tab) {
    case 'overview':
      return formatOverview(v)
    case 'audit':
      return formatAudit(v, now)
    case 'requests':
      return formatRequests(v, now)
    case 'reviews':
      return formatReviews(v, now)
    case 'ports':
      return formatPorts(v)
    case 'changes':
      return formatChanges(v)
    case 'cost':
      return formatCost(v)
  }
}

// Counts for the status line inside a space.
export function pendingCount(lines: readonly InspectorLine[]): number {
  return lines.filter(l => l.tone === 'warning').length
}

export function clip(lines: readonly InspectorLine[], width: number): InspectorLine[] {
  return lines.map(l => ({ ...l, text: cut(l.text, Math.max(10, width)) }))
}
