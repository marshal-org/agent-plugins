import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AutopilotEntry, AutopilotOutcome, AutopilotView, Fleet, FleetAsk, FleetCell, FleetPr, FleetRun } from '../types'
import { decide, type AskInput, type Verdict } from './autopilot-decide'
import { PR_REREAD_MS, PRS_PER_CYCLE, failureHash, nudgeText, readFailedLog, readRollup, redact, tailOf, watch, type PrWatch } from './autopilot-checks'
import { mergeBar, prFiles } from './autopilot-github'
import { journal, loadJournal, record, recentEntries, seen, type JournalEntry } from './autopilot-journal'
import {
  activeRules,
  appendDecision,
  loadOverlay,
  loadPolicy,
  readDecisions,
  ruleWords,
  type Overlay,
  type Policy,
} from './autopilot-policy'
import { presetRules, type Rule } from './autopilot-presets'
import { toolSpelling } from './config'
import { choicesOf, cut, firstLine, plainText, resultJson } from './fleet-model'

// Autopilot rides the fleet poll: after each poll wrote the board, it diffs
// the asks against its journal and wakes the model only for an ask it has
// never decided. A quiet poll makes no model call.

export const EMPTY_AUTOPILOT: AutopilotView = { state: 'off', reason: '', mode: '', recent: [], waiting: [], policyChangedAt: 0 }

const autopilotAtom = atom({ plugin: 'marshal', key: 'autopilot' } as const, EMPTY_AUTOPILOT, { shape: 'autopilot-1' })

// Per server: what Autopilot learned from its tool listing.
export type ApCell = {
  server: string
  hasPrs?: boolean
  // inbox_answer's listing says it takes a via note.
  hasVia: boolean
  hasInboxGet: boolean
  hasQueue: boolean
  hasMessage: boolean
  hasLogs?: boolean
  hasTimeout?: boolean
  hasContinue?: boolean
  hasStop?: boolean
  // In a space with answer_children: read with children_ask_get, answer with
  // children_ask_answer. The space has no inbox tools and no deputies_queue.
  hasChildAsks?: boolean
}

// Module state, rebuilt on every load (a reload drops it; the journal is
// read again from disk).
export const ap = {
  // Answers the person gave from the pane, by ask id, so a train decision
  // has the words even when the server does not say them.
  paneAnswers: new Map<string, string>(),
  spaceHosted: false,
  pollMs: 20_000,
  // The answers given this session, for the "answered" toast.
  lastCycleAt: 0,
}

export function resetEngine(): void {
  ap.paneAnswers.clear()
  ap.lastCycleAt = 0
}

const OPEN = new Set(['pending', 'claimed', ''])

// A question Autopilot waits on is decided again this often while it is open.
export const RECHECK_MS = 5 * 60_000

type Notice = { text: string; urgent: boolean }

type Cycle = {
  now: number
  policy: Policy
  mtime: number
  overlay: Overlay | undefined
  rules: Rule[]
  notices: Notice[]
  handled: Set<string>
}

function expiresInMin(a: FleetAsk, now: number): number | undefined {
  if (!a.expiresAt) return undefined
  const t = Date.parse(a.expiresAt)
  return Number.isFinite(t) ? (t - now) / 60_000 : undefined
}

function runOf(cell: FleetCell, runId: string): FleetRun | undefined {
  return [...cell.attention, ...cell.active, ...cell.recent].find(r => r.id === runId)
}

function askedText(a: { question: string; choices: string[] }): string {
  return a.choices.length ? `${a.question}\nChoices: ${a.choices.join(' | ')}` : a.question
}

function entryOf(e: JournalEntry): AutopilotEntry {
  return {
    askId: e.ask_id,
    runId: e.run_id,
    server: e.server,
    runLabel: e.run_label,
    question: e.ask.question,
    outcome: e.outcome,
    answer: e.answer,
    ruleId: e.rule_id,
    rule: e.rule,
    reasoning: e.reasoning,
    reason: e.reason,
    gate: e.gate,
    mode: e.mode,
    at: e.at,
    asked: askedText(e.ask),
    expiresInMin: e.expires_in_min ?? 0,
  }
}

async function setView($: EngineInterface, v: AutopilotView): Promise<void> {
  await update($, autopilotAtom, () => v)
}

function ruleText(rules: readonly Rule[], id: string, c: Cycle): string {
  const r = rules.find(x => x.id === id)
  return r ? ruleWords(r, c.policy.components) : ''
}

function entry(c: Cycle, cell: FleetCell, a: FleetAsk, outcome: AutopilotOutcome, v: Partial<Verdict> & { answer?: string; reason?: string }, extra: Partial<JournalEntry> = {}): JournalEntry {
  const run = runOf(cell, a.runId)
  return {
    t: new Date(c.now).toISOString(),
    at: c.now,
    server: cell.server,
    ask_id: a.askId,
    run_id: a.runId,
    run_label: a.runTitle || run?.title || a.deputy || a.runId.slice(0, 8),
    outcome,
    answer: v.answer ?? '',
    rule_id: v.ruleId ?? '',
    rule: v.ruleId ? ruleText(c.rules, v.ruleId, c) : '',
    reasoning: v.reasoning ?? '',
    reason: v.reason ?? '',
    gate: v.gate ?? '',
    mode: c.policy.mode,
    policy_mtime: c.mtime,
    ask: { question: a.question, choices: a.choices, rung: a.rung, deputy: a.deputy },
    accepted: false,
    via_stored: null,
    redacted: false,
    space_hosted: ap.spaceHosted,
    ...extra,
  }
}

function notify(c: Cycle, a: FleetAsk, why: string, urgent = false, minutes?: number): void {
  const left = minutes !== undefined ? ` Expires in ${Math.max(0, Math.round(minutes))} min.` : ''
  c.notices.push({ text: `${a.deputy || 'A run'} asks: ${cut(a.question || a.rung, 140)} (Autopilot: ${why}).${left}`, urgent })
}

// Read the ask in full: its context, whether it takes free text, whether it
// is still open. A failed read falls back to what runs_attention said.
// Choices come both ways: exact (what an answer sends) in input.choices,
// collapsed (what the journal and the strip show) in shown.
type ReadAsk = { input: Partial<AskInput>; shown?: string[]; status: string; blocked: string; respondedBy: string; answer: string }

async function readAsk($: EngineInterface, server: string, a: FleetAsk, apc: ApCell): Promise<ReadAsk> {
  if (apc.hasChildAsks) return readChildAsk($, server, a)
  if (!apc.hasInboxGet) return { input: {}, status: '', blocked: '', respondedBy: '', answer: '' }
  try {
    const v = resultJson(await $.mcp.call(server, 'inbox_get', { ask_id: a.askId })) as Record<string, unknown>
    const req = (v.request && typeof v.request === 'object' ? v.request : {}) as Record<string, unknown>
    const offered = Array.isArray(req.choices) ? choicesOf(req.choices) : { shown: a.choices, exact: exactChoices(a) }
    const choices = offered.exact
    const resp = (v.response && typeof v.response === 'object' ? v.response : {}) as Record<string, unknown>
    return {
      input: {
        question: plainText(req.question) || plainText(req.message) || plainText(req.body) || a.question,
        context: plainText(req.context),
        choices,
        allowFreeText: req.allow_free_text === true || (req.allow_free_text === undefined && choices.length === 0 && a.rung !== 'approve'),
      },
      shown: offered.shown,
      status: typeof v.status === 'string' ? v.status : '',
      blocked: v.answerable === false ? String(v.blocked ?? 'blocked') : '',
      respondedBy: typeof v.responded_by === 'string' ? v.responded_by : '',
      answer: typeof resp.answer === 'string' ? resp.answer : '',
    }
  } catch {
    return { input: {}, status: '', blocked: '', respondedBy: '', answer: '' }
  }
}

// children_ask_get, in a space: the same facts as inbox_get, flat, with the
// question, context and each choice in its own untrusted-content envelope.
async function readChildAsk($: EngineInterface, server: string, a: FleetAsk): Promise<ReadAsk> {
  try {
    const v = resultJson(await $.mcp.call(server, 'children_ask_get', { ask_id: a.askId })) as Record<string, unknown>
    const offered = Array.isArray(v.choices) ? choicesOf(v.choices) : { shown: a.choices, exact: exactChoices(a) }
    return {
      input: {
        question: plainText(v.question) || a.question,
        context: plainText(v.context),
        choices: offered.exact,
        allowFreeText: v.allow_free_text === true,
      },
      shown: offered.shown,
      status: typeof v.status === 'string' ? v.status : '',
      blocked: v.answerable === false ? String(v.blocked ?? 'blocked') : '',
      respondedBy: typeof v.responded_by === 'string' ? v.responded_by : '',
      answer: '',
    }
  } catch {
    return { input: {}, status: '', blocked: '', respondedBy: '', answer: '' }
  }
}

// The ask's choices exactly as offered (the board keeps both forms).
function exactChoices(a: FleetAsk): string[] {
  return a.choiceTexts && a.choiceTexts.length === a.choices.length ? a.choiceTexts : a.choices
}

// The run's pull request repositories; empty when unknown.
function runRepos(cell: FleetCell, runId: string): string[] {
  return [...new Set((runOf(cell, runId)?.prs ?? []).map(p => p.repo).filter(r => r !== ''))]
}

// What the decision gets for one ask.
async function gather($: EngineInterface, c: Cycle, cell: FleetCell, a: FleetAsk, apc: ApCell) {
  const read = await readAsk($, cell.server, a, apc)
  const run = runOf(cell, a.runId)
  const prs = (run?.prs ?? []).filter(p => p.repo !== '')
  const input: AskInput = {
    askId: a.askId,
    runId: a.runId,
    rung: a.rung,
    deputy: a.deputy,
    runTitle: a.runTitle || run?.title || '',
    question: read.input.question ?? a.question,
    context: read.input.context ?? '',
    choices: read.input.choices ?? exactChoices(a),
    allowFreeText: read.input.allowFreeText ?? (a.choices.length === 0 && a.rung !== 'approve'),
    repos: [...new Set(prs.map(p => p.repo))],
  }
  // Component rules need what the run's work changes: its pull requests'
  // files, read with the person's gh. A server without runs_prs, or a PR
  // gh cannot read, makes them unreadable.
  if (c.rules.some(r => r.components?.length)) {
    if (!apc.hasPrs) input.files = 'unreadable'
    else {
      const files: NonNullable<Exclude<AskInput['files'], 'unreadable'>> = []
      for (const p of prs.filter(x => x.state === 'open').slice(0, 3)) {
        const f = await prFiles($, p.repo, p.number)
        if (!f) {
          input.files = 'unreadable'
          break
        }
        files.push({ repo: p.repo, number: p.number, title: f.title, paths: f.paths })
      }
      if (input.files === undefined) input.files = files
    }
  }
  return { input, read, prs }
}

// The answer path: inbox_answer, as the person, with the exact choice text
// and Autopilot's note where the server keeps one; in a space with
// answer_children, children_ask_answer, as the space's owner. One try: an
// answer the platform refuses is never sent again.
const ELSEWHERE = /already been answered|settled while you were answering|someone else is already answering/i
export const VIA_MAX = 120

export function viaNote(ruleId: string): string {
  return cut(`Autopilot: rule ${ruleId}`, VIA_MAX)
}

async function act($: EngineInterface, c: Cycle, cell: FleetCell, a: FleetAsk, v: Extract<Verdict, { kind: 'answer' }>, apc: ApCell): Promise<void> {
  const args: Record<string, unknown> = { ask_id: a.askId, answer: v.answer }
  if (apc.hasVia) args.via = viaNote(v.ruleId)
  try {
    resultJson(await $.mcp.call(cell.server, apc.hasChildAsks ? 'children_ask_answer' : 'inbox_answer', args))
  } catch (err) {
    const why = firstLine(err instanceof Error ? err.message : String(err))
    if (ELSEWHERE.test(why)) {
      await record($, entry(c, cell, a, 'answered_elsewhere', { ...v, reason: why }))
      return
    }
    await record($, entry(c, cell, a, 'refused', { ...v, reason: `the platform refused the answer: ${why}` }))
    notify(c, a, `its answer was refused: ${cut(why, 120)}`)
    return
  }
  await record(
    $,
    entry(c, cell, a, 'answered', { ...v, reason: apc.hasVia ? '' : 'via_not_stored: this Marshal server does not keep the note yet' }, { accepted: true, via_stored: apc.hasVia }),
  )
  $.ui.toast(`Autopilot answered ${a.deputy || 'a run'}: "${cut(plainText(v.answer), 60)}" (${v.ruleId})`, { timeoutMs: 5000 })
}

// What code checks on the model's own classification before acting: a merge
// only on the repository's bar in Cruise, a resume only with room. Returns
// why not, or '' to go ahead.
async function holdBack($: EngineInterface, c: Cycle, cell: FleetCell, a: FleetAsk, v: Extract<Verdict, { kind: 'answer' }>, apc: ApCell, prs: FleetPr[]): Promise<string> {
  if (v.gate === 'approve_merge') {
    if (c.policy.mode !== 'cruise') return 'merges go to you outside Cruise'
    if (!c.policy.mergeBar) return 'the merge bar is off'
    const open = prs.filter(p => p.state === 'open')
    if (open.length !== 1) return open.length === 0 ? 'the run has no open pull request to check' : `the run has ${open.length} open pull requests`
    const bar = await mergeBar($, open[0]!.repo, open[0]!.number)
    return bar.ok ? '' : `the merge bar does not hold: ${bar.reason}`
  }
  if (v.gate === 'resume') {
    // In a space, deputies_queue is not an orchestration tool: there is no way
    // to see whether the cell has room, so a resume always goes to the person.
    if (!apc.hasQueue && apc.hasChildAsks) return 'in a space Autopilot cannot check the server has room (deputies_queue is not available to a space), so resumes go to you'
    if (!apc.hasQueue || !a.deputy) return 'cannot check the server has room (no deputy queue)'
    try {
      const q = resultJson(await $.mcp.call(cell.server, 'deputies_queue', { deputy: a.deputy })) as { queued?: unknown[] }
      const n = Array.isArray(q.queued) ? q.queued.length : -1
      if (n < 0) return 'cannot read the deputy queue'
      if (n > 0) return `no room: ${n} launch${n > 1 ? 'es wait' : ' waits'} in the ${a.deputy} queue`
    } catch {
      return 'cannot read the deputy queue'
    }
  }
  return ''
}

// Merge-bar failures that can still clear on their own while the ask is open.
const WAITABLE = /required checks not passing|unresolved|required reviews are not given|is a draft|moved while it was checked|could not read/

async function decideOne($: EngineInterface, c: Cycle, cell: FleetCell, a: FleetAsk, apc: ApCell): Promise<void> {
  const { input, read, prs } = await gather($, c, cell, a, apc)
  if (read.status && !OPEN.has(read.status)) {
    await record($, entry(c, cell, a, 'answered_elsewhere', { reason: `already ${read.status}${read.respondedBy ? ` by ${read.respondedBy}` : ''}` }))
    c.handled.add(a.askId)
    return
  }
  if (read.blocked && c.policy.mode !== 'shadow') {
    // The org answers this kind only in the web app: no call can succeed.
    await record($, entry(c, cell, a, 'notified', { reason: `this org does not let automated clients answer it (${read.blocked})` }))
    notify(c, a, 'your org answers this kind only in the web app')
    c.handled.add(a.askId)
    return
  }
  // Unreadable inputs count as protected: a protect rule that depends on
  // the PR's files matches when they cannot be read.
  const blind = input.files === 'unreadable' ? c.rules.find(r => r.action === 'protect' && r.components?.length) : undefined
  if (blind) {
    await record($, entry(c, cell, a, 'notified', { reason: `the pull request's files could not be read, and protect rule ${blind.id} depends on them`, ruleId: blind.id }))
    notify(c, a, `protect rule ${blind.id} may match (PR files unreadable)`)
    c.handled.add(a.askId)
    return
  }
  // The train's decisions, read again before every decision (FR-021).
  const decisions = c.overlay ? [...c.overlay.decisions, ...(await readDecisions($, c.overlay.train))] : []
  const verdict = await decide($, input, {
    model: c.policy.model,
    rules: c.rules,
    components: c.policy.components,
    decisions,
    mode: c.policy.mode,
    mergeBarWords: c.policy.mergeBar ? c.policy.mergeBarWords : '',
    // In a space the asks are its children's: reads stay off there.
    ...(!apc.hasChildAsks && { read: { server: cell.server, runId: a.runId, hasMessage: apc.hasMessage, hasLogs: apc.hasLogs === true, messaged: false } }),
  })
  c.handled.add(a.askId)
  // The journal and the strip show the choices collapsed; the answer sent is
  // the exact choice text.
  const asked = { ...a, question: input.question, choices: read.shown ?? a.choices }
  if (verdict.kind === 'wait') {
    // Decided again on a later check; the person hears only near expiry.
    await record($, entry(c, cell, asked, 'waiting', verdict))
    return
  }
  if (verdict.kind === 'notify') {
    const left = expiresInMin(a, c.now)
    const near = left !== undefined && left < c.policy.limits.expiryMinutes
    await record($, entry(c, cell, asked, 'notified', verdict, near ? { expires_in_min: Math.round(left) } : {}))
    notify(c, a, verdict.reason, near, near ? left : undefined)
    return
  }
  if (c.policy.mode === 'shadow') {
    await record($, entry(c, cell, asked, 'would_answer', verdict))
    return
  }
  const why = await holdBack($, c, cell, a, verdict, apc, prs)
  if (why) {
    // A bar that can still be met (checks running, threads open, reviews
    // coming) is waited on, not handed to the person.
    if (verdict.gate === 'approve_merge' && WAITABLE.test(why)) {
      await record($, entry(c, cell, asked, 'waiting', { ...verdict, reason: why }))
      return
    }
    await record($, entry(c, cell, asked, 'notified', { ...verdict, reason: why }))
    notify(c, a, why)
    return
  }
  await act($, c, cell, asked, verdict, apc)
}

// The person's own answers on watched runs during a train become the
// train's decisions: an ask that left the board and that Autopilot did not
// answer.
async function captureAnswers($: EngineInterface, c: Cycle, prevCell: FleetCell | undefined, cell: FleetCell, apc: ApCell): Promise<void> {
  if (!c.overlay || !prevCell || cell.error) return
  const open = new Set(cell.asks.map(a => a.askId))
  for (const a of prevCell.asks) {
    if (open.has(a.askId)) continue
    const j = seen(a.askId)
    if (j && (j.outcome === 'answered' || j.outcome === 'answered_elsewhere' || j.outcome === 'refused')) continue
    let answer = ap.paneAnswers.get(a.askId) ?? ''
    if (!answer && apc.hasInboxGet) {
      const read = await readAsk($, cell.server, a, { ...apc, hasInboxGet: true })
      if (read.status && read.status !== 'resolved') continue
      answer = read.answer
    }
    const run = runOf(prevCell, a.runId)
    try {
      await appendDecision($, c.overlay.train, {
        at: new Date(c.now).toISOString(),
        kind: j?.gate ?? '',
        repo: [...new Set((run?.prs ?? []).map(p => p.repo))].join(','),
        deputy: a.deputy,
        question: a.question,
        answer,
        source: 'person',
      })
    } catch (err) {
      c.notices.push({ text: `Autopilot could not keep your answer as a train decision: ${cut(firstLine(err instanceof Error ? err.message : String(err)), 160)}.`, urgent: false })
    }
    ap.paneAnswers.delete(a.askId)
  }
}

// The person's other channels (policy reach): each notice goes out once,
// through the tool they named, with "{text}" replaced by the notice. A
// channel that fails is told in a toast and never blocks the cycle.
async function reachOut($: EngineInterface, c: Cycle, text: string): Promise<void> {
  for (const r of c.policy.reach) {
    const args = Object.fromEntries(Object.entries(r.args).map(([k, v]) => [k, v.split('{text}').join(text)]))
    try {
      await $.mcp.call(r.server, r.tool, args)
    } catch (err) {
      $.ui.toast(`Autopilot could not reach you through ${r.says || `${r.server} ${r.tool}`}: ${cut(firstLine(err instanceof Error ? err.message : String(err)), 120)}`, { timeoutMs: 8000 })
    }
  }
}

async function deliver($: EngineInterface, c: Cycle, desktop: boolean): Promise<void> {
  const group = c.policy.limits.notifyGroupOver
  if (c.notices.length === 0) return
  if (c.notices.length > group) {
    const urgent = c.notices.filter(n => n.urgent).length
    const text = `Autopilot: ${c.notices.length} questions wait on you${urgent ? `, ${urgent} close to expiry` : ''}. See the fleet pane.`
    $.ui.toast(text, { timeoutMs: 8000 })
    if (desktop) void $.ui.notify(text, { title: 'Marshal Autopilot' }).catch(() => undefined)
    await reachOut($, c, text)
    return
  }
  for (const n of c.notices) {
    $.ui.toast(n.text, { timeoutMs: n.urgent ? 10000 : 8000 })
    if (desktop) void $.ui.notify(n.urgent ? `Expiring soon. ${n.text}` : n.text, { title: 'Marshal Autopilot' }).catch(() => undefined)
    await reachOut($, c, n.urgent ? `Expiring soon. ${n.text}` : n.text)
  }
}

async function view($: EngineInterface, state: AutopilotView['state'], reason: string, mode: string, mtime: number, fleet: Fleet): Promise<void> {
  const open = new Set(fleet.cells.flatMap(c => c.asks.map(a => `${c.server} ${a.askId}`)))
  const all = recentEntries(200)
  const nudges = journal.checks
    .filter(e => e.outcome === 'nudged' || e.outcome === 'cared')
    .map(e => ({ ...e, ask_id: `check:${e.run_id}:${e.check}:${e.at}`, answer: e.outcome === 'nudged' ? 'sent the failing log' : '', ask: { ...e.ask, question: e.pr ? `${e.check} on ${e.pr}` : e.check ?? '' } }))
  const waitingNow = all.filter(e => e.outcome === 'waiting' && open.has(`${e.server} ${e.ask_id}`))
  const recent = [...all.filter(e => e.outcome === 'answered' || e.outcome === 'would_answer'), ...waitingNow, ...nudges]
    .sort((a, b) => b.at - a.at)
    .slice(0, 6)
    .map(entryOf)
  const waiting = all
    .filter(e => (e.outcome === 'notified' || e.outcome === 'escalated' || e.outcome === 'refused') && open.has(`${e.server} ${e.ask_id}`))
    .slice(0, 6)
    .map(entryOf)
  await setView($, { state, reason, mode, recent, waiting, policyChangedAt: mtime })
}

function checkEntry(c: Cycle, w: PrWatch, label: string, outcome: AutopilotOutcome, check: string, reason: string, extra: Partial<JournalEntry> = {}): JournalEntry {
  return {
    t: new Date(c.now).toISOString(),
    at: c.now,
    server: w.server,
    ask_id: '',
    run_id: w.runId,
    run_label: label,
    outcome,
    answer: '',
    rule_id: '',
    rule: '',
    reasoning: '',
    reason,
    gate: 'check',
    mode: c.policy.mode,
    policy_mtime: c.mtime,
    ask: { question: '', choices: [], rung: '', deputy: '' },
    accepted: false,
    via_stored: null,
    redacted: false,
    space_hosted: ap.spaceHosted,
    check,
    pr: `${w.repo}#${w.number}`,
    ...extra,
  }
}

function checkNotice(c: Cycle, label: string, text: string): void {
  c.notices.push({ text: `${label}: ${text} (Autopilot).`, urgent: false })
}

// One PR: read its checks, count each failing identity once per failing
// job, nudge the run on the second, tell the person on the third.
async function watchPr($: EngineInterface, c: Cycle, w: PrWatch, label: string, apc: ApCell): Promise<void> {
  w.readAt = c.now
  const r = await readRollup($, w.repo, w.number)
  if (typeof r === 'string' || r === undefined) {
    const why = typeof r === 'string' ? r : 'no checks'
    if (w.skipped !== why) {
      w.skipped = why
      await record($, checkEntry(c, w, label, 'notified', '', `skipped: ${why}`))
    }
    return
  }
  w.skipped = ''
  if (r.head !== w.head) {
    if (w.head) touch(w.runId, c.now)
    w.head = r.head
  }
  for (const name of r.passed) for (const k of [...w.ids.keys()]) if (k.startsWith(`${name} / `)) w.ids.delete(k)
  for (const f of r.failed) {
    if ([...w.ids.values()].some(i => i.jobs.has(`${f.runId}/${f.jobId}`))) continue
    const log = await readFailedLog($, w.repo, f)
    const step = log?.step ?? 'unknown step'
    const key = `${f.name} / ${step}`
    const id = w.ids.get(key) ?? { count: 0, jobs: new Set<string>(), hash: '', messaged: false, notified: false, step }
    const tail = tailOf(log?.lines ?? [])
    const hash = failureHash(tail)
    const changed = id.hash !== '' && id.hash !== hash
    id.jobs.add(`${f.runId}/${f.jobId}`)
    id.count++
    id.hash = hash
    w.ids.set(key, id)
    const pr = `${w.repo}#${w.number}`
    if (id.count >= 3 && !id.notified) {
      id.notified = true
      await record($, checkEntry(c, w, label, 'notified', key, `the check failed ${id.count} times`))
      checkNotice(c, label, `the check "${f.name}" failed ${id.count} times at "${step}" on ${pr}`)
    } else if (id.count === 2 && !id.messaged) {
      id.messaged = true
      if (c.policy.mode === 'shadow' || !apc.hasMessage) {
        await record($, checkEntry(c, w, label, 'notified', key, c.policy.mode === 'shadow' ? 'failed twice (Shadow only notifies)' : 'failed twice; this server cannot message runs'))
        checkNotice(c, label, `the check "${f.name}" failed twice at "${step}" on ${pr}`)
        continue
      }
      const { text, redacted } = redact(tail)
      try {
        resultJson(await $.mcp.call(w.server, 'runs_message', { run_id: w.runId, text: nudgeText(f.name, step, pr, id.count, changed, text) }))
        await record($, checkEntry(c, w, label, 'nudged', key, `sent the run the failing log tail (${text.split('\n').length} lines)`, { redacted, accepted: true }))
      } catch (err) {
        await record($, checkEntry(c, w, label, 'notified', key, `could not message the run: ${firstLine(err instanceof Error ? err.message : String(err))}`, { redacted }))
        checkNotice(c, label, `the check "${f.name}" failed twice at "${step}" on ${pr}, and the run could not be told`)
      }
    }
  }
}

function touch(runId: string, now: number): void {
  const r = watch.runs.get(runId)
  if (r) watch.runs.set(runId, { ...r, since: now, reported: false })
}

// Running runs: their PRs' checks (at most PRS_PER_CYCLE a cycle, round
// robin, each at most once a minute), and silence past the limit.
async function watchRuns($: EngineInterface, c: Cycle, cell: FleetCell, apc: ApCell): Promise<void> {
  const running = cell.active.filter(r => r.state === 'running' && (!c.policy.watchDeputies.length || c.policy.watchDeputies.includes(r.deputy)))
  const asking = new Set(cell.asks.map(a => a.runId))
  for (const r of running) {
    const seenRun = watch.runs.get(r.id)
    if (!seenRun || seenRun.state !== r.state || asking.has(r.id)) watch.runs.set(r.id, { state: r.state, since: c.now, reported: false })
  }
  for (const id of [...watch.runs.keys()]) if (!running.some(r => r.id === id)) watch.runs.delete(id)
  const prs: { w: PrWatch; label: string }[] = []
  for (const r of running) {
    for (const p of (r.prs ?? []).filter(x => x.state === 'open' && x.repo && (!c.policy.watchRepos.length || c.policy.watchRepos.includes(x.repo)))) {
      const key = `${cell.server} ${p.repo}#${p.number}`
      const w = watch.prs.get(key) ?? { key, server: cell.server, runId: r.id, repo: p.repo, number: p.number, readAt: 0, head: '', ids: new Map(), skipped: '' }
      w.runId = r.id
      watch.prs.set(key, w)
      prs.push({ w, label: r.title || r.id.slice(0, 8) })
    }
  }
  const due = prs.filter(x => c.now - x.w.readAt >= PR_REREAD_MS)
  if (due.length > 0) {
    const start = watch.cursor % due.length
    const pick = [...due.slice(start), ...due.slice(0, start)].slice(0, PRS_PER_CYCLE)
    watch.cursor += pick.length
    for (const { w, label } of pick) await watchPr($, c, w, label, apc)
  }
  const limit = c.policy.limits.silenceMinutes * 60_000
  for (const r of running) {
    const s = watch.runs.get(r.id)
    if (!s || s.reported || c.now - s.since < limit) continue
    s.reported = true
    const label = r.title || r.id.slice(0, 8)
    const w: PrWatch = { key: '', server: cell.server, runId: r.id, repo: '', number: 0, readAt: 0, head: '', ids: new Map(), skipped: '' }
    await record($, { ...checkEntry(c, w, label, 'notified', '', `silent for ${Math.round((c.now - s.since) / 60_000)} minutes`), pr: '' })
    checkNotice(c, label, `running for ${Math.round((c.now - s.since) / 60_000)} minutes with no new push, question or state`)
  }
}

// ── Run care (policy care) ───────────────────────────────────────────────────
// What the orchestrate watcher did for runs, by the person's switches: add
// time before a run runs out, stop a run that is stuck (never one whose pull
// request merged) and resume it, resume a run that ended failed or timed out
// with an open pull request. Each run is resumed at most once; a second
// failure goes to the person. Shadow only writes what it would do.

export const EXTEND_EVERY_MS = 90 * 60_000
export const EXTEND_SECS = 2 * 3600
// Only runs that ended this recently are resumed (not old failures).
export const RESUME_WINDOW_MS = 2 * 3600_000
const ENDED_BAD = new Set(['failed', 'timed_out'])

function lastCare(runId: string, check: string): number {
  let at = 0
  for (const e of journal.checks) if (e.run_id === runId && e.check === check && e.at > at) at = e.at
  return at
}

function careEntry(c: Cycle, server: string, r: FleetRun, outcome: AutopilotOutcome, check: string, reason: string): JournalEntry {
  const w: PrWatch = { key: '', server, runId: r.id, repo: '', number: 0, readAt: 0, head: '', ids: new Map(), skipped: '' }
  return { ...checkEntry(c, w, r.title || r.id.slice(0, 8), outcome, check, reason), pr: '' }
}

export function resumeTask(why: string, pr: FleetPr | undefined): string {
  const which = pr ? `the existing pull request ${pr.repo}#${pr.number}` : 'your existing work'
  return `Marshal Autopilot: your last segment ended (${why}). RESUME ${which}; do not start over. Re-derive the state first, then continue to the next gate.`
}

async function resumeRun($: EngineInterface, c: Cycle, cell: FleetCell, apc: ApCell, r: FleetRun, why: string): Promise<void> {
  const label = r.title || r.id.slice(0, 8)
  if (lastCare(r.id, 'resume')) return
  const pr = (r.prs ?? []).find(p => p.state === 'open')
  if (!c.policy.care.relaunch || !apc.hasContinue) {
    await record($, careEntry(c, cell.server, r, 'notified', 'resume', `ended (${why}); ${apc.hasContinue ? 'resuming is off' : 'this server cannot continue runs'}`))
    checkNotice(c, label, `ended (${why})${pr ? ` with ${pr.repo}#${pr.number} open` : ''}; resume it`)
    return
  }
  if (c.policy.mode === 'shadow') {
    await record($, careEntry(c, cell.server, r, 'notified', 'resume', `Shadow: would resume it (${why})`))
    return
  }
  try {
    resultJson(await $.mcp.call(cell.server, 'runs_continue', { run_id: r.id, task: resumeTask(why, pr) }))
    await record($, careEntry(c, cell.server, r, 'cared', 'resume', `resumed it (${why})`))
  } catch (err) {
    const e = firstLine(err instanceof Error ? err.message : String(err))
    await record($, careEntry(c, cell.server, r, 'notified', 'resume', `could not resume it: ${e}`))
    checkNotice(c, label, `ended (${why}) and Autopilot could not resume it: ${cut(e, 100)}`)
  }
}

async function careRuns($: EngineInterface, c: Cycle, cell: FleetCell, apc: ApCell): Promise<void> {
  const care = c.policy.care
  const shadow = c.policy.mode === 'shadow'
  const watched = (r: FleetRun) => !c.policy.watchDeputies.length || c.policy.watchDeputies.includes(r.deputy)
  const running = cell.active.filter(r => r.state === 'running' && watched(r))
  const asking = new Set(cell.asks.map(a => a.runId))

  if (care.extendTimeouts && apc.hasTimeout) {
    for (const r of running) {
      if (c.now - lastCare(r.id, 'extend') < EXTEND_EVERY_MS) continue
      if (shadow) {
        await record($, careEntry(c, cell.server, r, 'notified', 'extend', 'Shadow: would add 2 hours to its time budget'))
        continue
      }
      try {
        resultJson(await $.mcp.call(cell.server, 'runs_timeout', { run_id: r.id, action: 'add', add_secs: EXTEND_SECS }))
        await record($, careEntry(c, cell.server, r, 'cared', 'extend', 'added 2 hours to its time budget'))
      } catch (err) {
        await record($, careEntry(c, cell.server, r, 'notified', 'extend', `could not add time: ${firstLine(err instanceof Error ? err.message : String(err))}`))
      }
    }
  }

  if (care.stopStuck && apc.hasStop) {
    const limit = 2 * c.policy.limits.silenceMinutes * 60_000
    for (const r of running) {
      const seenRun = watch.runs.get(r.id)
      if (!seenRun || c.now - seenRun.since < limit || asking.has(r.id) || lastCare(r.id, 'stop')) continue
      const minutes = Math.round((c.now - seenRun.since) / 60_000)
      const label = r.title || r.id.slice(0, 8)
      // Marshal records any outside stop as canceled, even after a merge:
      // a run whose pull request merged is never stopped.
      if ((r.prs ?? []).some(p => p.state === 'merged')) {
        await record($, careEntry(c, cell.server, r, 'notified', 'stop', `silent ${minutes} minutes, but its pull request merged: not stopped`))
        checkNotice(c, label, `silent ${minutes} minutes after its pull request merged; not stopped`)
        continue
      }
      if (shadow) {
        await record($, careEntry(c, cell.server, r, 'notified', 'stop', `Shadow: would stop it (silent ${minutes} minutes) and resume it`))
        continue
      }
      try {
        resultJson(await $.mcp.call(cell.server, 'runs_stop', { run_id: r.id }))
        await record($, careEntry(c, cell.server, r, 'cared', 'stop', `stopped it: silent ${minutes} minutes with no question`))
      } catch (err) {
        await record($, careEntry(c, cell.server, r, 'notified', 'stop', `could not stop it: ${firstLine(err instanceof Error ? err.message : String(err))}`))
        checkNotice(c, label, `stuck (silent ${minutes} minutes) and Autopilot could not stop it`)
        continue
      }
      await resumeRun($, c, cell, apc, r, `stuck, silent ${minutes} minutes; Autopilot stopped it`)
    }
  }

  for (const r of [...cell.attention, ...cell.recent]) {
    if (!ENDED_BAD.has(r.state) || !watched(r)) continue
    const ended = Date.parse(r.completedAt)
    if (!Number.isFinite(ended) || c.now - ended > RESUME_WINDOW_MS) continue
    const resumedAt = lastCare(r.id, 'resume')
    if (resumedAt) {
      // Resumed once and ended badly again: the person's.
      if (ended > resumedAt && !lastCare(r.id, 'resume-failed')) {
        await record($, careEntry(c, cell.server, r, 'notified', 'resume-failed', `ended ${r.state} again after Autopilot resumed it`))
        checkNotice(c, r.title || r.id.slice(0, 8), `ended ${r.state} again after Autopilot resumed it (${r.stopReason || 'no reason given'})`)
      }
      continue
    }
    if (!(r.prs ?? []).some(p => p.state === 'open')) continue
    await resumeRun($, c, cell, apc, r, `${r.state}${r.stopReason ? `: ${r.stopReason}` : ''}`)
  }
}

export type CycleInput = {
  prev: Fleet
  next: Fleet
  cells: readonly ApCell[]
  desktop: boolean
}

// One Autopilot cycle after a fleet poll. Returns the asks whose new-ask
// notice Autopilot took over (answered, would answer, or notified itself),
// so the fleet does not notify them twice.
export async function autopilotCycle($: EngineInterface, input: CycleInput): Promise<Set<string>> {
  const handled = new Set<string>()
  const now = await $.clock.now()
  const loaded = await loadPolicy($)
  if ('error' in loaded) {
    await setView($, { ...EMPTY_AUTOPILOT, state: 'off', reason: loaded.error })
    return handled
  }
  const policy = loaded.policy
  await loadJournal($, now, policy.limits.journalDays)
  if (!policy.enabled) {
    await view($, 'off', 'stopped. Press s or ask Claude to turn Marshal Autopilot on.', policy.mode, loaded.mtime, input.next)
    return handled
  }
  const { overlay, error } = await loadOverlay($, policy)
  const c: Cycle = { now, policy, mtime: loaded.mtime, overlay, rules: activeRules(policy, overlay), notices: [], handled }
  const watched = new Set(policy.servers.map(toolSpelling))
  const cells = input.next.cells.filter(cell => watched.has(cell.server) && !cell.error)
  for (const cell of cells) {
    const apc = input.cells.find(x => x.server === cell.server) ?? { server: cell.server, hasVia: false, hasInboxGet: false, hasQueue: false, hasMessage: false }
    await captureAnswers($, c, input.prev.cells.find(p => p.server === cell.server), cell, apc)
  }
  if (policy.paused) {
    await view($, 'paused', '', policy.mode, loaded.mtime, input.next)
    await deliver($, c, input.desktop && policy.notifyDesktop)
    return handled
  }
  // A train overlay that does not validate fails closed: its rules and
  // decisions cannot be applied, and the standing rules alone could answer
  // what the train meant to keep, so nothing is answered (as when paused:
  // the fleet tells the person of each question) until it is fixed.
  if (error) {
    await view($, 'paused', `answers nothing until the train overlay is fixed or the train is ended: ${error}`, policy.mode, loaded.mtime, input.next)
    await deliver($, c, input.desktop && policy.notifyDesktop)
    return handled
  }
  for (const cell of cells) {
    const apc = input.cells.find(x => x.server === cell.server) ?? { server: cell.server, hasVia: false, hasInboxGet: false, hasQueue: false, hasMessage: false }
    const fresh: FleetAsk[] = []
    for (const a of cell.asks) {
      if (policy.watchDeputies.length && !policy.watchDeputies.includes(a.deputy)) continue
      // Only runs whose pull requests are in a watched repository; a run
      // with none known is not watched (the person hears of it as without
      // Autopilot).
      if (policy.watchRepos.length && !runRepos(cell, a.runId).some(r => policy.watchRepos.includes(r))) continue
      const left = expiresInMin(a, now)
      const j = seen(a.askId)
      if (j && j.outcome === 'waiting') {
        // Waiting: near expiry it goes to the person; otherwise it is decided
        // again once RECHECK_MS has passed.
        if (left !== undefined && left < policy.limits.expiryMinutes && left > 0) {
          await record($, { ...j, t: new Date(now).toISOString(), at: now, outcome: 'escalated', expires_in_min: Math.round(left), reason: `still waiting: ${j.reason}` })
          notify(c, a, `still waiting: ${cut(j.reason, 100)}`, true, left)
          handled.add(a.askId)
          continue
        }
        if (now - j.at >= RECHECK_MS) {
          fresh.push(a)
          continue
        }
        handled.add(a.askId)
        continue
      }
      if (j) {
        // Decided before: escalate once when it nears expiry still open.
        if ((j.outcome === 'notified' || j.outcome === 'refused') && left !== undefined && left < policy.limits.expiryMinutes && left > 0 && j.expires_in_min === undefined) {
          await record($, { ...j, t: new Date(now).toISOString(), at: now, outcome: 'escalated', expires_in_min: Math.round(left) })
          notify(c, a, 'still waiting on you', true, left)
        }
        handled.add(a.askId)
        continue
      }
      if (left !== undefined && left <= 0) continue
      fresh.push(a)
    }
    // Oldest first: the one closest to expiry first, then as listed.
    fresh.sort((x, y) => (expiresInMin(x, now) ?? Infinity) - (expiresInMin(y, now) ?? Infinity))
    let budget = policy.limits.answersPerCycle
    for (const a of fresh) {
      if (budget <= 0) {
        // Waits for the next cycle, unless it would expire before then.
        const left = expiresInMin(a, now)
        if (left !== undefined && left * 60_000 < ap.pollMs * 2) {
          await record($, entry(c, cell, a, 'notified', { reason: 'too many questions at once, and this one expires before the next check' }, { expires_in_min: Math.round(left) }))
          notify(c, a, 'too many questions at once', true, left)
          handled.add(a.askId)
        }
        // Otherwise it is not handled: the fleet announces it as new now,
        // and Autopilot decides it on a later cycle.
        continue
      }
      budget--
      try {
        await decideOne($, c, cell, a, apc)
      } catch (err) {
        await record($, entry(c, cell, a, 'notified', { reason: `Autopilot failed: ${firstLine(err instanceof Error ? err.message : String(err))}` }))
        notify(c, a, 'it could not decide')
        handled.add(a.askId)
      }
    }
  }
  for (const cell of cells) {
    const apc = input.cells.find(x => x.server === cell.server) ?? { server: cell.server, hasVia: false, hasInboxGet: false, hasQueue: false, hasMessage: false }
    try {
      await watchRuns($, c, cell, apc)
    } catch {
      // Watching is best effort; it never blocks the asks.
    }
    try {
      await careRuns($, c, cell, apc)
    } catch {
      // Care is best effort too.
    }
  }
  await deliver($, c, input.desktop && policy.notifyDesktop)
  await view($, 'on', error, policy.mode, loaded.mtime, input.next)
  ap.lastCycleAt = now
  return handled
}

// Kept for the skill and explain: the rules a mode applies, by id.
export function knownRules(p: Policy, o: Overlay | undefined): Rule[] {
  return [...activeRules(p, o), ...presetRules('cruise')]
}

export { journal }
