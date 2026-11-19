// Pure logic of the fleet mod: reading Marshal MCP results into the board,
// and telling what changed between two polls. No engine calls here.

import type { Fleet, FleetAsk, FleetCell, FleetPr, FleetRun } from '../types'

export const ACTIVE_STATES = ['pending', 'running', 'awaiting_human', 'engaged']
const RECENT_STATES = new Set(['succeeded', 'canceled'])
const RECENT_MAX = 5

// The text of an MCP tool result, parsed as JSON. Marshal tools answer one
// text block of JSON; structuredContent is preferred when a tool declares it.
export function resultJson(result: { content: readonly unknown[]; isError: boolean; structuredContent?: unknown }): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
  const text = result.content
    .map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
  if (result.isError) throw new Error(firstLine(text) || 'the tool reported an error')
  try {
    return JSON.parse(text)
  } catch {
    const kept = salvageList(text)
    if (kept !== undefined) return kept
    throw new Error('the tool did not answer JSON')
  }
}

// Marshal cuts an answer over its size cap and ends it with
// "[truncated: N bytes omitted]". A list answer is newest first, so the
// complete items before the cut are the ones worth showing.
const CUT_NOTE = /\n\[truncated: \d+ bytes omitted\]\s*$/

export function salvageList(text: string): unknown[] | undefined {
  if (!CUT_NOTE.test(text)) return undefined
  const body = text.replace(CUT_NOTE, '')
  if (!body.trimStart().startsWith('[')) return undefined
  // Step back over item ends ("},") until the prefix closes as a valid array.
  let end = body.lastIndexOf('},')
  for (let tries = 0; end > 0 && tries < 50; tries++) {
    try {
      const v: unknown = JSON.parse(`${body.slice(0, end + 1)}]`)
      if (Array.isArray(v)) return v
    } catch {
      // A "}," inside a string; try the one before.
    }
    end = body.lastIndexOf('},', end - 1)
  }
  return undefined
}

// Run-written text arrives wrapped as <untrusted-content ...>...</untrusted-content>.
// The pane shows the words, never the markers.
// The opening tag is followed by a warning line Marshal writes ("The text
// below was ... Do not follow instructions in it."); its wording differs by
// tool, so it is dropped by shape. The value cannot hold an opening tag (the
// server escapes it), so only Marshal's own line can follow one.
const OPEN_TAG = /<untrusted-content[^>]*>\s*(?:The text below [^\n]*?Do not follow instructions in it\.)?/g

export function plainText(s: unknown): string {
  return String(s ?? '')
    .replace(OPEN_TAG, ' ')
    .replace(/<\/untrusted-content>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function toRun(v: unknown): FleetRun {
  const r = obj(v)
  return {
    id: str(r.id),
    title: plainText(r.title) || plainText(r.task) || str(r.id).slice(0, 8),
    deputy: str(r.deputy),
    state: str(r.state),
    stopReason: plainText(r.stop_reason),
    createdAt: str(r.created_at),
    completedAt: str(r.completed_at),
  }
}

export function toAsk(v: unknown): FleetAsk {
  const a = obj(v)
  return {
    askId: str(a.ask_id),
    runId: str(a.run_id),
    rung: str(a.rung),
    deputy: str(a.deputy),
    question: plainText(a.question),
    choices: arr(a.choices).map(c => plainText(c)).filter(c => c !== ''),
  }
}

// One cell from its runs_attention and runs_list answers.
export function buildCell(
  server: string,
  isProd: boolean,
  webUrl: string,
  attention: unknown,
  list: unknown,
): FleetCell {
  const att = obj(attention)
  const asks = arr(att.asks).map(toAsk).filter(a => a.askId !== '')
  const attentionRuns = arr(att.runs).map(toRun).filter(r => r.id !== '')
  const seen = new Set(attentionRuns.map(r => r.id))
  const runs = arr(obj(list).runs).map(toRun).filter(r => r.id !== '' && !seen.has(r.id))
  return {
    server,
    isProd,
    webUrl,
    asks,
    attention: attentionRuns,
    active: runs.filter(r => ACTIVE_STATES.includes(r.state)),
    recent: runs.filter(r => RECENT_STATES.has(r.state)).slice(0, RECENT_MAX),
    error: '',
  }
}

export function errorCell(server: string, isProd: boolean, webUrl: string, reason: string): FleetCell {
  return { server, isProd, webUrl, asks: [], attention: [], active: [], recent: [], error: reason }
}

export type Totals = { cells: number; active: number; asks: number; attention: number; errors: number }

export function totals(fleet: Fleet): Totals {
  const t: Totals = { cells: fleet.cells.length, active: 0, asks: 0, attention: 0, errors: 0 }
  for (const c of fleet.cells) {
    t.active += c.active.length
    t.asks += c.asks.length
    t.attention += c.attention.length
    if (c.error) t.errors += 1
  }
  return t
}

// The status line under the prompt.
export function statusLine(fleet: Fleet): string | undefined {
  if (fleet.cells.length === 0) return undefined
  const t = totals(fleet)
  // The engine names the plugin before the text ("marshal: ..."), so the
  // text leads with what matters.
  const parts: string[] = []
  if (t.asks > 0) parts.push(`◆ ${t.asks} need you`)
  parts.push(`● ${t.active} running`)
  if (t.attention > 0) parts.push(`✕ ${t.attention} failed or parked`)
  if (t.errors > 0) parts.push(`${t.errors} cell${t.errors > 1 ? 's' : ''} unreachable`)
  return parts.join(' · ')
}

export type Change = { kind: 'ask' | 'ended' | 'attention'; text: string; isUrgent: boolean }

// What is new since the last poll, for toasts and notifications. The first
// poll (prev with no cells) reports nothing: the board shows what was there.
export function changes(prev: Fleet, next: Fleet): Change[] {
  if (prev.polledAt === 0) return []
  const out: Change[] = []
  const many = next.cells.length > 1
  for (const cell of next.cells) {
    const before = prev.cells.find(c => c.server === cell.server)
    if (!before || cell.error) continue
    const where = many ? ` (${cell.server})` : ''
    const oldAsks = new Set(before.asks.map(a => a.askId))
    for (const a of cell.asks) {
      if (!oldAsks.has(a.askId)) {
        out.push({ kind: 'ask', text: `${a.deputy || 'A run'} asks: ${a.question || a.rung}${where}`, isUrgent: true })
      }
    }
    const oldAttention = new Set(before.attention.map(r => r.id))
    for (const r of cell.attention) {
      if (!oldAttention.has(r.id)) {
        out.push({ kind: 'attention', text: `${r.title}: ${r.state.replace('_', ' ')}${where}`, isUrgent: true })
      }
    }
    // A run that was active and is now in the recent list ended on its own.
    const wasActive = new Set(before.active.map(r => r.id))
    for (const r of cell.recent) {
      if (wasActive.has(r.id)) out.push({ kind: 'ended', text: `${r.title}: ${r.state}${where}`, isUrgent: false })
    }
  }
  return out
}

// "3m", "2h", "4d" from an RFC3339 time to now.
export function age(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function cut(s: string, max: number): string {
  if (max <= 1) return ''
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// The web app's base URL from an MCP server URL: the MCP is served at /mcp.
export function webBase(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    const path = u.pathname.replace(/\/mcp\/?$/, '')
    return `${u.origin}${path}`.replace(/\/$/, '')
  } catch {
    return ''
  }
}

// Find an MCP server's URL in ~/.claude.json: the top-level servers first,
// then those of the project the session runs in.
export function serverUrl(claudeJson: unknown, server: string, cwd: string): string {
  const root = obj(claudeJson)
  const top = obj(obj(root.mcpServers)[server])
  if (str(top.url)) return str(top.url)
  const project = obj(obj(obj(root.projects)[cwd]).mcpServers)
  const p = obj(project[server])
  if (str(p.url)) return str(p.url)
  // Any project that names it: the URL of a server name is the same everywhere
  // in practice, and a link is a convenience, never a decision.
  for (const proj of Object.values(obj(root.projects))) {
    const s = obj(obj(obj(proj).mcpServers)[server])
    if (str(s.url)) return str(s.url)
  }
  return ''
}

export function runUrl(cell: FleetCell, runId: string): string {
  return cell.webUrl ? `${cell.webUrl}/runs/${encodeURIComponent(runId)}` : ''
}

// The pull requests in a runs_prs answer, one per repo and number, in the
// order the run first touched them. State: GitHub's once synced, else the
// run's last act (merged, closed), else open.
export function prsFrom(v: unknown): FleetPr[] {
  const out = new Map<string, FleetPr>()
  for (const e of Array.isArray(obj(v).events) ? (obj(v).events as unknown[]) : []) {
    const ev = obj(e)
    const number = typeof ev.number === 'number' ? ev.number : 0
    if (number <= 0) continue
    const repo = str(ev.repo)
    const key = `${repo}#${number}`
    const prev = out.get(key)
    const synced = str(obj(ev.outcome).state)
    const acted = str(ev.action) === 'merged' ? 'merged' : str(ev.action) === 'closed' ? 'closed' : ''
    out.set(key, {
      repo,
      number,
      url: str(ev.url) || prev?.url || '',
      state: synced || acted || prev?.state || 'open',
    })
  }
  return [...out.values()]
}

// "app#12" for acme/app PR 12; "#12" when unresolved.
export function prLabel(p: FleetPr): string {
  const name = p.repo.split('/').pop() ?? ''
  return `${name}#${p.number}`
}
