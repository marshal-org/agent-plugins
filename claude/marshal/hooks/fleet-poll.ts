import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Answering, Fleet, FleetCell, FleetPr, FleetRun } from '../types'
import { EMPTY_FLEET } from './atoms'
import { ap, autopilotCycle, EMPTY_AUTOPILOT } from './autopilot-engine'
import { versions } from './version'
import { buildCell, changes, cut, errorCell, prsFrom, resultJson, savedAnswerPath, statusLine, toRun } from './fleet-model'

const fleetAtom = atom({ plugin: 'marshal', key: 'fleet' } as const, EMPTY_FLEET, { shape: 'fleet-1' })
const autopilotAtom = atom({ plugin: 'marshal', key: 'autopilot' } as const, EMPTY_AUTOPILOT, { shape: 'autopilot-1' })
const answeringAtom = atom({ plugin: 'marshal', key: 'answering' } as const, null as Answering)

// Call a Marshal tool and parse its JSON answer. An answer over Claude Code's
// token limit is read back from the file Claude Code saved it to.
export async function callJson($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await $.mcp.call(server, tool, args)
  const saved = savedAnswerPath(result)
  if (saved === undefined) return resultJson(result)
  return resultJson({ content: [{ type: 'text', text: await $.fs.read(saved) }], isError: false })
}

// hasPrs: the server lists runs_prs (older servers do not; no PRs then).
// hasQueue: the server lists runs_cancel_queued, so its runs_list takes
// include_queued (added before it); an older server refuses the argument.
// hasVia: inbox_answer's listing says it takes Autopilot's via note.
// hasChildAsks: a space with answer_children lists children_attention,
// children_ask_get and children_ask_answer: its children's asks are read and
// answered through them (the space never has the inbox tools).
export type Cell = {
  server: string
  webUrl: string
  hasPrs?: boolean
  hasSpaceReads?: boolean
  hasAttention?: boolean
  hasQueue?: boolean
  hasVia?: boolean
  hasInboxGet?: boolean
  hasDeputyQueue?: boolean
  hasMessage?: boolean
  hasLogs?: boolean
  hasTimeout?: boolean
  hasContinue?: boolean
  hasStop?: boolean
  hasUsage?: boolean
  hasChildAsks?: boolean
}

// The servers whose asks are answered through children_ask_answer.
const childAskServers = new Set<string>()

// Failed runs the person cleared from the pane, per server, kept across
// sessions. Marshal has no "seen" mark for a run, so this is the plugin's own.
const CLEARED_MAX = 200

function clearedKey(server: string): string {
  return `cleared:${server}`
}

export async function clearedRuns($: EngineInterface, server: string): Promise<Set<string>> {
  try {
    const v = await $.store.get(clearedKey(server))
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

// Clear one failed run from the pane now, and from every later poll.
export async function clearRun($: EngineInterface, server: string, runId: string): Promise<void> {
  const kept = [...(await clearedRuns($, server))].filter(id => id !== runId)
  await $.store.set(clearedKey(server), [...kept, runId].slice(-CLEARED_MAX))
  await update($, fleetAtom, f => ({
    ...f,
    cells: f.cells.map(c => (c.server === server ? { ...c, attention: c.attention.filter(r => r.id !== runId) } : c)),
  }))
  $.ui.status(statusLine(await read($, fleetAtom), versions, await read($, autopilotAtom)))
}

// The title of an asking run that is not among the newest runs, read once.
const askTitles = new Map<string, string>()

async function attachAskTitles($: EngineInterface, server: string, c: FleetCell): Promise<FleetCell> {
  const missing = c.asks.filter(a => a.runTitle === '' && a.runId !== '' && !askTitles.has(a.runId))
  await Promise.all(
    missing.map(async a => {
      try {
        askTitles.set(a.runId, toRun(resultJson(await $.mcp.call(server, 'runs_get', { run_id: a.runId }))).title)
      } catch {
        // The card then shows the run id alone.
      }
    }),
  )
  return { ...c, asks: c.asks.map(a => (a.runTitle === '' ? { ...a, runTitle: askTitles.get(a.runId) ?? '' } : a)) }
}

// PRs per run, kept between polls: a run's PRs change while it runs and until
// they are merged or closed, so those are read again after a while.
const prCache = new Map<string, { at: number; prs: FleetPr[] }>()
const PR_FRESH_ACTIVE_MS = 60_000
const PR_FRESH_OPEN_MS = 5 * 60_000

function prsAreFresh(r: FleetRun, hit: { at: number; prs: FleetPr[] } | undefined, now: number): boolean {
  if (!hit) return false
  if (r.completedAt === '') return now - hit.at < PR_FRESH_ACTIVE_MS
  if (hit.prs.some(p => p.state === 'open')) return now - hit.at < PR_FRESH_OPEN_MS
  return true
}

// Fill in each run's PRs. A failed read leaves that run without them.
async function attachPrs($: EngineInterface, server: string, c: FleetCell): Promise<FleetCell> {
  const now = await $.clock.now()
  const runs = [...c.attention, ...c.active, ...c.recent]
  await Promise.all(
    runs
      .filter(r => !prsAreFresh(r, prCache.get(r.id), now))
      .map(async r => {
        try {
          prCache.set(r.id, { at: now, prs: prsFrom(resultJson(await $.mcp.call(server, 'runs_prs', { run_id: r.id }))) })
        } catch {
          // A run the server cannot read PRs for just shows none.
        }
      }),
  )
  const withPrs = (r: FleetRun): FleetRun => ({ ...r, prs: prCache.get(r.id)?.prs ?? [] })
  return { ...c, attention: c.attention.map(withPrs), active: c.active.map(withPrs), recent: c.recent.map(withPrs) }
}

const ATTENTION_MINUTES = 60
const LIST_LIMIT = 30

// Read one cell: what needs a person, and the newest runs.
export async function readCell($: EngineInterface, cell: Cell): Promise<FleetCell> {
  try {
    // A space's marshal-orchestration has no runs_attention: its runs_list
    // holds only the runs this space launched. With answer_children,
    // children_attention says what those runs wait on; without it, nothing
    // that waits on a person is read here.
    const launchedOnly = cell.hasAttention === false
    if (cell.hasChildAsks) childAskServers.add(cell.server)
    else childAskServers.delete(cell.server)
    const [attention, list, cleared] = await Promise.all([
      cell.hasChildAsks
        ? $.mcp.call(cell.server, 'children_attention', { minutes: ATTENTION_MINUTES })
        : launchedOnly
          ? undefined
          : $.mcp.call(cell.server, 'runs_attention', { minutes: ATTENTION_MINUTES }),
      $.mcp.call(cell.server, 'runs_list', { limit: LIST_LIMIT, task_chars: -1, ...(cell.hasQueue && { include_queued: true }) }),
      clearedRuns($, cell.server),
    ])
    const built = buildCell(cell.server, false, cell.webUrl, attention ? resultJson(attention) : {}, resultJson(list), launchedOnly)
    const shown = { ...built, attention: built.attention.filter(r => !cleared.has(r.id)) }
    const titled = await attachAskTitles($, cell.server, shown)
    return cell.hasPrs ? await attachPrs($, cell.server, titled) : titled
  } catch (err) {
    return errorCell(cell.server, false, cell.webUrl, err instanceof Error ? err.message : String(err))
  }
}

// Poll, store the board, and tell the person what changed.
export async function pollFleet($: EngineInterface, cells: readonly Cell[], notify: boolean): Promise<void> {
  const prev = await read($, fleetAtom)
  const fresh = await Promise.all(cells.map(c => readCell($, c)))
  const next: Fleet = { cells: fresh, polledAt: await $.clock.now() }
  await update($, fleetAtom, () => next)
  $.ui.status(statusLine(next, versions, await read($, autopilotAtom)))
  // Autopilot decides the new asks before they are announced: the ones it
  // answers or would answer are not announced, the ones it hands to the
  // person it announces itself.
  let handled = new Set<string>()
  try {
    handled = await autopilotCycle($, {
      prev,
      next,
      desktop: notify,
      cells: cells.map(c => ({
        server: c.server,
        hasPrs: c.hasPrs === true,
        // children_ask_answer always takes the via note.
        hasVia: c.hasVia === true || c.hasChildAsks === true,
        hasInboxGet: c.hasInboxGet === true || c.hasChildAsks === true,
        hasQueue: c.hasDeputyQueue === true,
        hasMessage: c.hasMessage === true,
        hasLogs: c.hasLogs === true,
        hasTimeout: c.hasTimeout === true,
        hasContinue: c.hasContinue === true,
        hasStop: c.hasStop === true,
        hasUsage: c.hasUsage === true,
        hasChildAsks: c.hasChildAsks === true,
      })),
    })
  } catch {
    // Autopilot never stands between the person and their notifications.
  }
  for (const change of changes(prev, next)) {
    if (change.askId !== undefined && handled.has(change.askId)) continue
    $.ui.toast(change.text, { timeoutMs: change.isUrgent ? 8000 : 4000 })
    // A desktop notification only for what waits on the person.
    if (notify && change.kind === 'ask') void $.ui.notify(change.text, { title: 'Marshal' }).catch(() => undefined)
  }
}

// The runs on the board, for the Autopilot skill: which are still going,
// and each run's deputy.
export async function fleetRuns($: EngineInterface): Promise<{ watched: Set<string>; active: Set<string>; deputies: Map<string, string> }> {
  const f = await read($, fleetAtom)
  const all = f.cells.flatMap(c => [...c.attention, ...c.active, ...c.recent])
  const active = new Set(f.cells.flatMap(c => [...c.active.map(r => r.id), ...c.asks.map(a => a.runId), ...c.attention.filter(r => r.state === 'parked').map(r => r.id)]))
  return { watched: new Set(all.map(r => r.id)), active, deputies: new Map(all.map(r => [r.id, r.deputy])) }
}

// Answer one ask as the person. The press that calls this is the person's
// own act; the run that asked continues.
export async function answerAsk($: EngineInterface, server: string, askId: string, answer: string): Promise<boolean> {
  const text = answer.trim()
  if (text === '') return false
  // The person's own words, for the train's decisions (Autopilot).
  ap.paneAnswers.set(askId, text)
  let isAnswered = false
  try {
    const tool = childAskServers.has(server) ? 'children_ask_answer' : 'inbox_answer'
    resultJson(await $.mcp.call(server, tool, { ask_id: askId, answer: text }))
    $.ui.toast(`Answered: ${cut(text, 60)}`)
    isAnswered = true
  } catch (err) {
    // Approval gates answer here only when the org allows it: say why, and
    // where to answer instead.
    const why = err instanceof Error ? err.message : String(err)
    $.ui.toast(`Not answered: ${cut(why, 200)} Answer it in the Marshal web app.`, { timeoutMs: 10000 })
  }
  await update($, answeringAtom, () => null)
  return isAnswered
}
