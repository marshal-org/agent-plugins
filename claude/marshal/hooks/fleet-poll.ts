import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Answering, Fleet, FleetCell, FleetPr, FleetRun } from '../types'
import { EMPTY_FLEET } from './atoms'
import { buildCell, changes, cut, errorCell, prsFrom, resultJson, savedAnswerPath, statusLine } from './fleet-model'

const fleetAtom = atom({ plugin: 'marshal', key: 'fleet' } as const, EMPTY_FLEET, { shape: 'fleet-1' })
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
export type Cell = { server: string; webUrl: string; hasPrs?: boolean; hasSpaceReads?: boolean }

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
    const [attention, list] = await Promise.all([
      $.mcp.call(cell.server, 'runs_attention', { minutes: ATTENTION_MINUTES }),
      $.mcp.call(cell.server, 'runs_list', { limit: LIST_LIMIT, task_chars: -1 }),
    ])
    const built = buildCell(cell.server, false, cell.webUrl, resultJson(attention), resultJson(list))
    return cell.hasPrs ? await attachPrs($, cell.server, built) : built
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
  $.ui.status(statusLine(next))
  for (const change of changes(prev, next)) {
    $.ui.toast(change.text, { timeoutMs: change.isUrgent ? 8000 : 4000 })
    // A desktop notification only for what waits on the person.
    if (notify && change.kind === 'ask') void $.ui.notify(change.text, { title: 'Marshal' }).catch(() => undefined)
  }
}

// Answer one ask as the person. The press that calls this is the person's
// own act; the run that asked continues.
export async function answerAsk($: EngineInterface, server: string, askId: string, answer: string): Promise<boolean> {
  const text = answer.trim()
  if (text === '') return false
  let isAnswered = false
  try {
    resultJson(await $.mcp.call(server, 'inbox_answer', { ask_id: askId, answer: text }))
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
