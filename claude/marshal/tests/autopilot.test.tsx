// Marshal Autopilot, through the engine's own test kit.
//
// The model is stubbed at its hook (`model.complete`) in the kit: the kit
// lets a test answer any `$` call beneath the plugin, so the plugin needs no
// model port of its own (T003). The pipeline's own functions are never
// mocked. Tests are named by story (US1: ...), so a run maps to the
// Verification rows of the plan.

import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import {
  checkRollup,
  failedLog,
  BILLING_ASK,
  BILLING_FILES,
  DOCS_FILES,
  FAKE,
  NEVER_AUTO_ASKS,
  NOW,
  PRESET_OF,
  ROUTINE_ASKS,
  UNTRUE_ASK,
  prEvents,
  attention,
  decision,
  inboxGet,
  policyYaml,
  runsFor,
  text,
  type AskFixture,
} from './fixtures'

export const HOME = '/home/p'
export const DATA = `${HOME}/.claude/plugins/data/marshal-marshal/autopilot`
export const POLICY = `${DATA}/policy.yaml`

export const FLEET = {
  plugin: 'marshal',
  component: 'Pane',
  requestId: 'marshal-fleet',
  props: { title: 'Marshal fleet', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const SERVER = 'marshal-example'
export const VIA_DESCRIPTION = 'Answer one ask from inbox_list, as you. Optional via: a short note stored with the answer saying who or what answered.'

export function toolsFor(server: string, extra: string[] = []): string[] {
  return ['runs_attention', 'runs_get', 'runs_list', 'inbox_answer', 'inbox_get', 'runs_prs', 'deputies_queue', 'runs_message', ...extra].map(t => `mcp__${server}__${t}`)
}

export type Call = { server: string; tool: string; args: Record<string, unknown> }
type ModelReply = string | { fail: 'api-error' | 'empty-reply' | 'aborted' }
type Run = { argv: string[]; stdin?: string }

export type WorldOpts = {
  asks?: AskFixture[]
  // The asks' list per poll: called with the poll number (0 first).
  asksAt?: (n: number) => AskFixture[]
  runs?: unknown[]
  mcp?: (c: Call, w: World) => unknown | undefined
  model?: (prompt: string, ask: string) => ModelReply | Promise<ModelReply>
  gh?: (argv: string[]) => { exitCode?: number; stdout?: string; stderr?: string } | undefined
  files?: Record<string, string>
  tools?: string[]
  viaDescription?: string
  server?: string
  inSpace?: boolean
  // sh for Autopilot's private files: 'fail' exits 1 having written nothing,
  // 'nostart' cannot start (no POSIX shell).
  sh?: (op: string) => 'fail' | 'nostart' | undefined
}

export type World = ReturnType<typeof world>

// The engine beneath the plugin: MCP, a file system in memory, sh and gh, the
// model, the screen.
export function world(on: On, opts: WorldOpts = {}) {
  const server = opts.server ?? SERVER
  const calls: Call[] = []
  const prompts: { prompt: string; system: string; model: string }[] = []
  const toasts: string[] = []
  const notified: string[] = []
  const runs: Run[] = []
  const files = new Map<string, { text: string; mtime: number; mode: string }>()
  let tick = 1
  const clock = mock.clock(on, { now: NOW })
  for (const [k, v] of Object.entries(opts.files ?? {})) files.set(k, { text: v, mtime: NOW - 60_000 + tick++, mode: '0600' })
  const tools = opts.tools ?? toolsFor(server)
  let polls = 0
  const asksNow = () => (opts.asksAt ? opts.asksAt(polls) : (opts.asks ?? []))

  on('tool.list', () => ({
    value: tools.map(name => ({ name, description: name.endsWith('__inbox_answer') ? (opts.viaDescription ?? VIA_DESCRIPTION) : '', mcp: name.startsWith('mcp__') })),
  }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__marshal__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('env.get', (_, e) => ({ value: ({ HOME, TERM_PROGRAM: 'ghostty' } as Record<string, string>)[e.name] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))

  // Files in memory, with the mode sh's umask gave them.
  const isDir = (p: string) => [...files.keys()].some(k => k.startsWith(`${p.replace(/\/$/, '')}/`))
  on('fs.stat', (_, e) => {
    if (e.path === '/run/marshal-agent.sock') return opts.inSpace ? { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }
    const f = files.get(e.path)
    if (f) return { value: { kind: 'file', size: new TextEncoder().encode(f.text).length, mtimeMs: f.mtime, isLink: false } }
    if (isDir(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return { deny: 'ENOENT' }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', (_, e) => {
    const f = files.get(e.path)
    return f ? { value: f.text } : { deny: 'ENOENT' }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, { text: e.text, mtime: clock.now() + tick++, mode: '0644' })
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = e.path?.replace(/\/$/, '') ?? ''
    const names = new Set<string>()
    for (const k of files.keys()) if (k.startsWith(`${dir}/`)) names.add(k.slice(dir.length + 1).split('/')[0]!)
    if (names.size === 0) return { deny: 'ENOENT' }
    return { value: [...names].map(name => ({ name, kind: files.has(`${dir}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    const stdin = e.init?.stdin
    runs.push({ argv, stdin })
    if (argv[0] === 'sh') {
      const script = argv[2] ?? ''
      const op = argv[3]
      const path = argv[4] ?? ''
      const how = opts.sh?.(op ?? '')
      if (how === 'nostart') return { deny: 'spawn sh ENOENT' }
      if (how === 'fail') return { value: { exitCode: 1, stdout: '', stderr: `sh: 1: cannot create ${path}.tmp: Permission denied`, isStdoutTruncated: false, isStderrTruncated: false } }
      const mode = script.includes('umask 077') ? '0600' : '0644'
      if (op === 'autopilot-write') files.set(path, { text: stdin ?? '', mtime: clock.now() + tick++, mode })
      else if (op === 'autopilot-append') {
        const before = files.get(path)?.text ?? ''
        files.set(path, { text: before + (stdin ?? ''), mtime: clock.now() + tick++, mode })
      } else if (op === 'autopilot-remove') files.delete(path)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'gh') {
      const r = opts.gh?.(argv)
      if (r) return { value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
      return { value: { exitCode: 1, stdout: '', stderr: 'gh: not stubbed', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 127, stdout: '', stderr: `${argv[0]}: not found`, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', async (_, e) => {
    const prompt = String(e.prompt)
    prompts.push({ prompt, system: String(e.system ?? ''), model: e.model })
    const askId = /ASK (\S+) from run/.exec(prompt)?.[1] ?? ''
    const r = opts.model ? await opts.model(prompt, askId) : decision({ gate: 'other' })
    const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    if (typeof r === 'string') return { value: { isAnswered: true, text: r, usage } }
    if (r.fail === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } }
    return { value: { isAnswered: false, reason: r.fail, usage } }
  })
  on('mcp.call', async (_, e) => {
    const c: Call = { server: e.server, tool: e.tool, args: (e.args ?? {}) as Record<string, unknown> }
    calls.push(c)
    const custom = opts.mcp?.(c, w)
    if (custom !== undefined) return { value: custom as never }
    const asks = asksNow()
    switch (c.tool) {
      case 'runs_attention':
        polls++
        return { value: text(attention(asks)) as never }
      case 'runs_list':
        return { value: text(runsFor(asks, opts.runs ?? [])) as never }
      case 'inbox_get': {
        const a = asks.find(x => x.ask_id === c.args.ask_id)
        return { value: text(a ? inboxGet(a) : { status: 'resolved' }) as never }
      }
      case 'inbox_answer':
        return { value: text({ ask_id: c.args.ask_id, status: 'resolved', run_id: 'r', rung: 'ask' }) as never }
      case 'runs_prs':
        return { value: text({ events: [] }) as never }
      case 'deputies_queue':
        return { value: text({ queued: [] }) as never }
      case 'runs_message':
        return { value: text({ ok: true }) as never }
    }
    return { value: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } as never }
  })

  const w = {
    calls,
    prompts,
    toasts,
    notified,
    runs,
    files,
    clock,
    get polls() {
      return polls
    },
    journal(): Record<string, unknown>[] {
      return [...files.entries()]
        .filter(([k]) => k.startsWith(`${DATA}/journal/`))
        .flatMap(([, f]) => f.text.split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>))
    },
    answers(): Call[] {
      return calls.filter(c => c.tool === 'inbox_answer' || c.tool === 'children_ask_answer')
    },
  }
  return w
}

// Every string a drawn tree shows, joined.
export function shown(tree: unknown): string {
  if (typeof tree === 'string') return tree
  if (Array.isArray(tree)) return tree.map(shown).join('')
  if (tree && typeof tree === 'object') return shown((tree as { children?: unknown }).children ?? [])
  return ''
}

export async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
}

export async function tool($: Engine, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown; deny?: string }>
  const r = await call({ tool: `mcp__marshal__${name}`, ...args })
  if (r.deny) throw new Error(r.deny)
  // Core accepts only text or content blocks from a registered tool.
  if (typeof r.result !== 'string') throw new Error(`mcp__marshal__${name} returned ${typeof r.result}, not text`)
  return JSON.parse(r.result) as Record<string, unknown>
}

// The routine ask a preset answers, decided by its kind.
export function byKind(asks: readonly AskFixture[]) {
  return (_: string, id: string) => {
    const a = asks.find(x => x.ask_id === id)
    const rule = a ? { pick_approach: 'preset.pick-approach', proceed: 'preset.proceed', rerun_check: 'preset.rerun-flake', resume: 'preset.resume', approve_plan: 'preset.approve-plan', approve_merge: 'preset.approve-merge' }[a.kind] : undefined
    return decision({ gate: a?.kind ?? 'other', rule_id: rule ?? null })
  }
}

const PROCEED = ROUTINE_ASKS[1]!

// ── US1 ──────────────────────────────────────────────────────────────────────

test('US1: setup shows the modes and the never-auto list, reads the policy back, and saves it in Shadow', async ($, on) => {
  const w = world(on)
  await start($, w)
  const status = await tool($, 'autopilot_status')
  expect(status.state).toBe('off')
  expect((status.modes as string[]).map(m => m.split(':')[0])).toEqual(['Shadow', 'Routine', 'Cruise'])
  expect((status.never_auto as string[]).join(' ')).toMatch(/taking over.*credentials.*staging or production.*release.*deleting/)

  const preview = await tool($, 'autopilot_setup', { confirm: false })
  expect(preview.saved).toBe(false)
  expect((preview.read_back as string[])[0]).toBe('Mode shadow. On.')
  // The read-back says every setting it saves, desktop notifications too (G-015).
  expect(preview.read_back as string[]).toContain('Desktop notifications on (toasts and the strip always).')
  expect(w.files.has(POLICY)).toBe(false)

  const saved = await tool($, 'autopilot_setup', { confirm: true })
  expect(saved.saved).toBe(true)
  const f = w.files.get(POLICY)
  expect(f?.text).toContain('mode: shadow')
  expect(f?.text).toContain(`- ${SERVER}`)
  // Private to the person: written through sh with umask 077.
  expect(f?.mode).toBe('0600')
  expect((await tool($, 'autopilot_status')).state).toBe('on')
})

test('US1: in Shadow a routine ask gets a would-answer entry and a strip row, and stays open', async ($, on) => {
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: policyYaml() }, model: byKind([PROCEED]) })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  const j = w.journal()
  expect(j).toHaveLength(1)
  expect(j[0]).toMatchObject({ ask_id: 'proceed', outcome: 'would_answer', rule_id: 'preset.proceed', answer: 'Proceed', mode: 'shadow' })
  expect(String(j[0]!.reasoning)).toBe('stub')
  // Not announced: Autopilot took it.
  expect(w.toasts.some(t => t.includes('asks:'))).toBe(false)
  expect(w.notified).toHaveLength(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FLEET, surface })
    expect(await ui.find({ type: 'Text', text: /would answer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /"Proceed" · preset\.proceed/ })).toBeDefined()
    // The ask is still open on the platform: its card is still there.
    expect(await ui.find({ key: 'ans:proceed:0' } as never)).toBeDefined()
    await ui.unmount()
  }
})

test('US1: an ask no rule covers notifies the person and waits on them', async ($, on) => {
  const other = { ...PROCEED, ask_id: 'odd', run_id: 'run-odd', kind: 'other', question: 'Rename the project?' }
  const w = world(on, { asks: [other], files: { [POLICY]: policyYaml() }, model: () => decision({ gate: 'other' }) })
  await start($, w)
  expect(w.journal()[0]).toMatchObject({ ask_id: 'odd', outcome: 'notified', reason: 'no rule covers it' })
  expect(w.toasts.some(t => t.includes('Rename the project?') && t.includes('Autopilot: no rule covers it'))).toBe(true)
  expect(w.notified).toHaveLength(1)
  expect(w.answers()).toHaveLength(0)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /WAITING ON YOU 1/ })).toBeDefined()
  await ui.unmount()
})

test('US1: idle cycles make no model call, a new ask makes exactly one, a re-seen ask none', async ($, on) => {
  const second = ROUTINE_ASKS[0]!
  const w = world(on, {
    asksAt: n => (n < 3 ? [] : n < 6 ? [PROCEED] : [PROCEED, second]),
    files: { [POLICY]: policyYaml() },
    model: byKind(ROUTINE_ASKS),
  })
  await start($, w)
  await w.clock.advance(40_000)
  expect(w.polls).toBe(3)
  expect(w.prompts).toHaveLength(0)
  await w.clock.advance(60_000)
  expect(w.prompts).toHaveLength(1)
  await w.clock.advance(20_000)
  expect(w.prompts).toHaveLength(2)
  await w.clock.advance(100_000)
  expect(w.prompts).toHaveLength(2)
})

test('US1: an idle cycle adds no MCP call and no model call', async ($, on) => {
  const w = world(on, { asks: [], files: { [POLICY]: policyYaml({ mode: 'routine' }) } })
  await start($, w)
  await w.clock.advance(100_000)
  expect(w.polls).toBe(6)
  // Only the fleet's own reads, as without Autopilot.
  expect([...new Set(w.calls.map(c => c.tool))].sort()).toEqual(['runs_attention', 'runs_list'])
  expect(w.prompts).toHaveLength(0)
})

test('US1: a restarted session never decides a journaled ask again', async ($, on) => {
  const journal = JSON.stringify({ t: '2026-11-16T09:59:00Z', at: NOW - 60_000, server: SERVER, ask_id: 'proceed', run_id: 'run-proceed', run_label: 'x', outcome: 'would_answer', answer: 'Proceed', rule_id: 'preset.proceed', rule: '', reasoning: 'r', reason: '', gate: 'proceed', mode: 'shadow', policy_mtime: 1, ask: { question: 'q', choices: [], rung: 'ask', deputy: 'shipper' }, accepted: false, via_stored: null, redacted: false, space_hosted: false })
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: policyYaml(), [`${DATA}/journal/2026-11-16.jsonl`]: `${journal}\n` }, model: byKind([PROCEED]) })
  await start($, w)
  await w.clock.advance(40_000)
  expect(w.prompts).toHaveLength(0)
})

test('US1: the strip says "Autopilot is on" with a moving indicator and its mode', async ($, on) => {
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: byKind([PROCEED]) })
  await start($, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FLEET, surface })
    expect(await ui.find({ type: 'Client', key: 'ap:indicator' } as never)).toBeDefined()
    const before = JSON.stringify(await ui.drawn({ in: 'ap:indicator' }))
    expect(shown(await ui.drawn({ in: 'ap:indicator' }))).toContain('Autopilot is on')
    await ui.advance(500)
    const after = JSON.stringify(await ui.drawn({ in: 'ap:indicator' }))
    expect(after).not.toBe(before)
    // The strip names the mode next to "Autopilot is on".
    expect(await ui.find({ type: 'Text', text: /· (Shadow|Routine|Cruise)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('US1: paused stills the indicator, stop says it is off', async ($, on) => {
  const w = world(on, { asks: [], files: { [POLICY]: policyYaml() } })
  await start($, w)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  await ui.press({ key: 'ap:pause' })
  expect(w.files.get(POLICY)?.text).toContain('paused: true')
  expect(await ui.find({ type: 'Client', key: 'ap:indicator' } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Autopilot is paused/ })).toBeDefined()
  await ui.press({ key: 'ap:stop' })
  expect(w.files.get(POLICY)?.text).toContain('enabled: false')
  expect(await ui.find({ type: 'Text', text: /Autopilot is off/ })).toBeDefined()
  await ui.unmount()
})

test('US1: with no policy Autopilot stays off and the strip says why', async ($, on) => {
  const w = world(on, { asks: [PROCEED], model: byKind([PROCEED]) })
  await start($, w)
  expect(w.prompts).toHaveLength(0)
  // Without Autopilot the fleet announces the ask as before.
  expect(w.toasts.some(t => t.includes('asks:'))).toBe(false)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Autopilot is off: no policy yet/ })).toBeDefined()
  await ui.unmount()
})

// ── US2 ──────────────────────────────────────────────────────────────────────

const NEVER_TOOLS = ['runs_launch', 'runs_continue', 'runs_retry', 'runs_stop', 'deputies_run_adhoc', 'runs_cancel_queued', 'runs_interrupt', 'runs_take_wheel', 'inbox_claim']

function neverActs(w: World): void {
  expect(w.calls.filter(c => NEVER_TOOLS.includes(c.tool)).map(c => c.tool)).toEqual([])
  // Autopilot never merges: no gh write of any kind.
  expect(w.runs.filter(r => r.argv[0] === 'gh' && /^(merge|close|edit|review|comment)$/.test(r.argv[2] ?? '')).length).toBe(0)
}

function expiring(a: AskFixture, minutes: number): AskFixture {
  return { ...a, expires_at: new Date(NOW + minutes * 60_000).toISOString() }
}

test('US2: Routine answers a routine ask once, as the person, with the via note', async ($, on) => {
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: byKind([PROCEED]) })
  await start($, w)
  expect(w.answers().map(c => c.args)).toEqual([{ ask_id: 'proceed', answer: 'Proceed', via: 'Autopilot: rule preset.proceed' }])
  expect(w.journal()[0]).toMatchObject({ outcome: 'answered', accepted: true, via_stored: true, rule_id: 'preset.proceed' })
  expect(w.toasts.some(t => t.startsWith('Autopilot answered shipper: "Proceed" (preset.proceed)'))).toBe(true)
  // The ask is still listed on later polls: answered once only.
  await w.clock.advance(60_000)
  expect(w.answers()).toHaveLength(1)
  expect(w.prompts).toHaveLength(1)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /answered/ })).toBeDefined()
  await ui.unmount()
  neverActs(w)
})

test('US2: an ask the person or another session answered first is left alone, with no retry', async ($, on) => {
  const w = world(on, {
    asks: [PROCEED],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: byKind([PROCEED]),
    mcp: c =>
      c.tool === 'inbox_answer'
        ? { content: [{ type: 'text', text: 'ask proceed has already been answered by someone else via web; nothing was changed' }], isError: true }
        : undefined,
  })
  await start($, w)
  await w.clock.advance(60_000)
  expect(w.answers()).toHaveLength(1)
  expect(w.journal().map(e => e.outcome)).toEqual(['answered_elsewhere'])
  expect(w.notified).toHaveLength(0)
})

test('US2: an ask already settled when read is not decided at all', async ($, on) => {
  const w = world(on, {
    asks: [PROCEED],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: byKind([PROCEED]),
    mcp: c => (c.tool === 'inbox_get' ? text(inboxGet(PROCEED, { status: 'resolved', responded_by: 'Pat' })) : undefined),
  })
  await start($, w)
  expect(w.prompts).toHaveLength(0)
  expect(w.answers()).toHaveLength(0)
  expect(w.journal()[0]).toMatchObject({ outcome: 'answered_elsewhere', reason: 'already resolved by Pat' })
})

test('US2: a refused answer is recorded with the reason, notifies, and is never retried', async ($, on) => {
  const w = world(on, {
    asks: [PROCEED],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: byKind([PROCEED]),
    mcp: c => (c.tool === 'inbox_answer' ? { content: [{ type: 'text', text: 'refused: you are not one of the people this ask was put to' }], isError: true } : undefined),
  })
  await start($, w)
  await w.clock.advance(60_000)
  expect(w.answers()).toHaveLength(1)
  expect(w.journal()[0]).toMatchObject({ outcome: 'refused', reason: 'the platform refused the answer: refused: you are not one of the people this ask was put to' })
  expect(w.notified).toHaveLength(1)
})

test('US2: a model failure or invalid JSON answers nothing and notifies', async ($, on) => {
  const a2 = ROUTINE_ASKS[0]!
  const w = world(on, {
    asks: [PROCEED, a2],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: (_, id) => (id === 'proceed' ? { fail: 'api-error' } : 'Sure, I would pick the lite flow.'),
  })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  const j = w.journal()
  expect(j.find(e => e.ask_id === 'proceed')).toMatchObject({ outcome: 'notified', reason: 'the model call failed (api-error)' })
  expect(j.find(e => e.ask_id === 'pick')).toMatchObject({ outcome: 'notified', reason: 'the decision was not valid JSON' })
  expect(w.notified).toHaveLength(2)
  // Autopilot keeps polling; the failed asks are not tried again.
  await w.clock.advance(40_000)
  expect(w.prompts).toHaveLength(2)
})

test('US2: at most 3 decisions per cycle; the rest wait, and notices over 3 are grouped', async ($, on) => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...PROCEED, ask_id: `q${i}`, run_id: `run-q${i}`, kind: 'other' }))
  const w = world(on, { asks: many, files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: () => decision({ gate: 'other' }) })
  await start($, w)
  expect(w.prompts).toHaveLength(3)
  expect(w.notified).toHaveLength(3)
  await w.clock.advance(20_000)
  expect(w.prompts).toHaveLength(6)
  await w.clock.advance(40_000)
  expect(w.prompts).toHaveLength(10)
})

test('US2: an ask held back by the limit that would expire before the next check is escalated', async ($, on) => {
  const minutes = [0.4, 0.5, 30]
  const many = minutes.map((m, i) => expiring({ ...PROCEED, ask_id: `q${i}`, run_id: `run-q${i}`, kind: 'other' }, m))
  const w = world(on, { asks: many, files: { [POLICY]: policyYaml({ mode: 'routine', extra: 'limits:\n  answers_per_cycle: 1' }) }, model: () => decision({ gate: 'other' }) })
  await start($, w)
  // The one closest to expiry goes first; one decision fits this cycle.
  expect(w.prompts.map(p => /ASK (\S+)/.exec(p.prompt)?.[1])).toEqual(['q0'])
  expect(w.journal().find(e => e.ask_id === 'q1')).toMatchObject({ outcome: 'notified', reason: 'too many questions at once, and this one expires before the next check' })
  expect(w.journal().find(e => e.ask_id === 'q2')).toBeUndefined()
  await w.clock.advance(20_000)
  expect(w.prompts.map(p => /ASK (\S+)/.exec(p.prompt)?.[1])).toEqual(['q0', 'q2'])
})

test('US2: more than 3 notices in one cycle arrive as one summary', async ($, on) => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...PROCEED, ask_id: `q${i}`, run_id: `run-q${i}`, kind: 'other' }))
  const w = world(on, { asks: many, files: { [POLICY]: policyYaml({ mode: 'routine', extra: 'limits:\n  answers_per_cycle: 5' }) }, model: () => decision({ gate: 'other' }) })
  await start($, w)
  expect(w.prompts).toHaveLength(5)
  expect(w.notified).toEqual(['Autopilot: 5 questions wait on you. See the fleet pane.'])
})

test('US2: an ask it will not answer that is close to expiry is escalated', async ($, on) => {
  const soon = expiring({ ...PROCEED, kind: 'other' }, 5)
  const w = world(on, { asks: [soon], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: () => decision({ gate: 'other' }) })
  await start($, w)
  expect(w.notified[0]).toMatch(/^Expiring soon\. .*Expires in 5 min\.$/)
  expect(w.journal()[0]).toMatchObject({ outcome: 'notified', expires_in_min: 5 })
})

test('US2: an ask notified earlier is escalated once when it nears expiry', async ($, on) => {
  const later = expiring({ ...PROCEED, kind: 'other' }, 12)
  const w = world(on, { asks: [later], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: () => decision({ gate: 'other' }) })
  await start($, w)
  expect(w.notified).toHaveLength(1)
  await w.clock.advance(4 * 60_000)
  expect(w.notified).toHaveLength(2)
  expect(w.notified[1]).toMatch(/still waiting on you/)
  await w.clock.advance(60_000)
  expect(w.notified).toHaveLength(2)
  expect(w.prompts).toHaveLength(1)
})

test('US2: a server without via gets the answer without it, and the journal says so', async ($, on) => {
  const w = world(on, {
    asks: [PROCEED],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: byKind([PROCEED]),
    viaDescription: 'Answer one ask from inbox_list, as you. The run that asked continues. Otherwise answer them in the Marshal web UI or in Slack.',
  })
  await start($, w)
  expect(w.answers().map(c => c.args)).toEqual([{ ask_id: 'proceed', answer: 'Proceed' }])
  expect(w.journal()[0]).toMatchObject({ outcome: 'answered', via_stored: false })
  expect(String(w.journal()[0]!.reason)).toMatch(/^via_not_stored/)
})

test('US2: open asks are evaluated oldest first, and an expired one is never answered', async ($, on) => {
  const a = expiring({ ...ROUTINE_ASKS[0]! }, 50)
  const b = expiring({ ...PROCEED }, 20)
  const gone = expiring({ ...ROUTINE_ASKS[3]! }, -1)
  const w = world(on, { asks: [a, gone, b], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: byKind(ROUTINE_ASKS) })
  await start($, w)
  expect(w.prompts.map(p => /ASK (\S+)/.exec(p.prompt)?.[1])).toEqual(['proceed', 'pick'])
  expect(w.answers().some(c => c.args.ask_id === 'resume')).toBe(false)
})

test('US2: a resume question with a non-empty deputy queue notifies, and Autopilot never launches', async ($, on) => {
  const resume = ROUTINE_ASKS[3]!
  const w = world(on, {
    asks: [resume],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: () => decision({ gate: 'resume', rule_id: 'preset.resume' }),
    mcp: c => (c.tool === 'deputies_queue' ? text({ queued: [{ id: 'q1' }] }) : undefined),
  })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(String(w.journal()[0]!.reason)).toMatch(/no room: 1 launch waits/)
  expect(w.calls.find(c => c.tool === 'deputies_queue')?.args).toEqual({ deputy: 'shipper' })
  neverActs(w)
})

test('US2: a resume question with an unreadable deputy queue notifies', async ($, on) => {
  const resume = ROUTINE_ASKS[3]!
  const w = world(on, {
    asks: [resume],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: byKind([resume]),
    mcp: c => (c.tool === 'deputies_queue' ? { content: [{ type: 'text', text: 'nope' }], isError: true } : undefined),
  })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(String(w.journal()[0]!.reason)).toMatch(/cannot read the deputy queue/)
  neverActs(w)
})

test('US2: a resume question with room is answered', async ($, on) => {
  const resume = ROUTINE_ASKS[3]!
  const w = world(on, { asks: [resume], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: byKind([resume]) })
  await start($, w)
  expect(w.answers().map(c => c.args.answer)).toEqual(['Resume'])
  neverActs(w)
})

// In a Marshal space with answer_children (docs/specs/feat-orch-child-asks):
// the space has no inbox and no attention view of the person. It reads and
// answers its own children's asks through the three children_* tools, polls
// without the pane open, and never calls the person's inbox tools.
const CHILD_TOOLS = ['children_attention', 'children_ask_get', 'children_ask_answer', 'runs_get', 'runs_list', 'runs_message']

function childAskGet(a: AskFixture, over: Record<string, unknown> = {}) {
  const wrap = (t: string) => `<untrusted-content source="ask ${a.ask_id}">${t}</untrusted-content>`
  return {
    ask_id: a.ask_id,
    run_id: a.run_id,
    deputy: a.deputy,
    rung: a.rung,
    status: 'pending',
    question: wrap(a.question),
    choices: (a.choices ?? []).map(wrap),
    allow_free_text: a.rung !== 'approve',
    answerable: true,
    ...over,
  }
}

function spaceWorld(on: On, asks: AskFixture[], extra: Partial<WorldOpts> = {}) {
  return world(on, {
    asks,
    inSpace: true,
    tools: CHILD_TOOLS.map(t => `mcp__${SERVER}__${t}`),
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    ...extra,
    mcp: (c, w) => {
      const custom = extra.mcp?.(c, w)
      if (custom !== undefined) return custom
      switch (c.tool) {
        case 'children_attention':
          return text(attention(asks))
        case 'children_ask_get': {
          const a = asks.find(x => x.ask_id === c.args.ask_id)
          return text(a ? childAskGet(a) : { status: 'resolved' })
        }
        case 'children_ask_answer':
          return text({ ask_id: c.args.ask_id, status: 'resolved', run_id: 'r', rung: 'ask' })
      }
      return undefined
    },
  })
}

const INBOX_TOOLS = ['runs_attention', 'inbox_list', 'inbox_get', 'inbox_answer', 'inbox_reply']

test('US2: in a space Autopilot reads and answers through the children tools, with the via note, never the inbox', async ($, on) => {
  const w = spaceWorld(on, [PROCEED], { model: byKind([PROCEED]) })
  await start($, w)
  expect(w.calls.some(c => c.tool === 'children_attention')).toBe(true)
  expect(w.calls.find(c => c.tool === 'children_ask_get')?.args).toEqual({ ask_id: 'proceed' })
  expect(w.answers().map(c => ({ tool: c.tool, ...c.args }))).toEqual([
    { tool: 'children_ask_answer', ask_id: 'proceed', answer: 'Proceed', via: 'Autopilot: rule preset.proceed' },
  ])
  expect(w.journal()[0]).toMatchObject({ outcome: 'answered', accepted: true, via_stored: true, space_hosted: true })
  expect(w.calls.filter(c => INBOX_TOOLS.includes(c.tool)).map(c => c.tool)).toEqual([])
  neverActs(w)
})

test('US2: in a space a resume question goes to the person: deputies_queue is not available to a space', async ($, on) => {
  const resume = ROUTINE_ASKS[3]!
  const w = spaceWorld(on, [resume], { model: byKind([resume]) })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(String(w.journal()[0]!.reason)).toMatch(/in a space Autopilot cannot check the server has room/)
  expect(w.calls.some(c => c.tool === 'deputies_queue')).toBe(false)
  neverActs(w)
})

test('US2: in a space a takeover the platform will not let it answer goes to the person without an answer call', async ($, on) => {
  const takeover = NEVER_AUTO_ASKS[0]!
  const w = spaceWorld(on, [takeover], {
    model: byKind([takeover]),
    mcp: c => (c.tool === 'children_ask_get' ? text(childAskGet(takeover, { answerable: false, blocked: 'takeover_not_answerable' })) : undefined),
  })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(String(w.journal()[0]!.reason)).toMatch(/takeover_not_answerable/)
  expect(w.prompts).toHaveLength(0)
})

// The protection table (G-004): every preset gate kind and every never-auto
// action, in every mode and paused, with the protect rule listed before and
// after the answer rule. The stubbed model reports the match; code obeys it.
const TABLE_ASKS = [...ROUTINE_ASKS, ...NEVER_AUTO_ASKS]
for (const mode of ['shadow', 'routine', 'cruise', 'paused'] as const) {
  for (const order of ['protect first', 'answer first'] as const) {
    test(`US2: the protection table: ${mode}, ${order}: nothing answered, one notice each`, async ($, on) => {
      const w = world(on, {
        asksAt: n => (n === 0 ? [] : TABLE_ASKS),
        files: {
          [POLICY]: policyYaml({
            mode: mode === 'paused' ? 'cruise' : mode,
            paused: mode === 'paused',
            mergeBar: true,
            extra: 'limits:\n  answers_per_cycle: 20\n  notify_group_over: 50\nrules:\n  - id: guard-all\n    action: protect\n    says: everything goes to me',
          }),
        },
        model: (_, id) => {
          const a = TABLE_ASKS.find(x => x.ask_id === id)!
          const answerRule = PRESET_OF[a.kind] ?? 'preset.proceed'
          const matched = order === 'protect first' ? ['guard-all', answerRule] : [answerRule, 'guard-all']
          return decision({ gate: a.kind, rule_id: answerRule, matched })
        },
      })
      await start($, w)
      await w.clock.advance(20_000)
      expect(w.answers()).toHaveLength(0)
      expect(w.prompts).toHaveLength(mode === 'paused' ? 0 : TABLE_ASKS.length)
      for (const a of TABLE_ASKS) {
        const q = a.question.split('\n')[2]!.slice(0, 40)
        expect(w.notified.filter(n => n.includes(q)), `${a.ask_id}`).toHaveLength(1)
      }
      neverActs(w)
    })
  }
}

test('US2: pause takes effect before the next cycle; resume restores answering', async ($, on) => {
  const w = world(on, { asksAt: n => (n < 2 ? [] : [PROCEED]), files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: byKind([PROCEED]) })
  await start($, w)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  await ui.press({ key: 'ap:pause' })
  await w.clock.advance(40_000)
  expect(w.polls).toBe(3)
  expect(w.prompts).toHaveLength(0)
  expect(w.answers()).toHaveLength(0)
  // Paused: the person is told as without Autopilot.
  expect(w.toasts.some(t => t.includes('shipper asks:'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Autopilot is paused/ })).toBeDefined()
  await ui.press({ key: 'ap:pause' })
  await w.clock.advance(20_000)
  expect(w.answers()).toHaveLength(1)
  await ui.unmount()
})

test('US2: stop turns Autopilot off; turning it on again keeps the mode it had', async ($, on) => {
  const w = world(on, { asksAt: n => (n < 2 ? [] : [PROCEED]), files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: byKind([PROCEED]) })
  await start($, w)
  expect((await tool($, 'autopilot_control', { action: 'stop' })).state).toBe('off')
  await w.clock.advance(40_000)
  expect(w.prompts).toHaveLength(0)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Autopilot is off/ })).toBeDefined()
  await ui.press({ key: 'ap:stop' })
  expect(w.files.get(POLICY)?.text).toContain('mode: routine')
  await w.clock.advance(20_000)
  expect(w.answers()).toHaveLength(1)
  expect(await ui.find({ type: 'Client', key: 'ap:indicator' } as never)).toBeDefined()
  await ui.unmount()
  expect((await tool($, 'autopilot_control', { action: 'pause' })).state).toBe('paused')
  expect((await tool($, 'autopilot_control', { action: 'resume' })).state).toBe('on')
})

function mergeWorld(on: On, opts: { bar?: boolean; mode?: string; threads?: readonly boolean[]; morePages?: boolean; checks?: readonly { name: string; bucket: string }[]; review?: string; ghDown?: boolean }) {
  const merge = ROUTINE_ASKS[5]!
  return world(on, {
    asks: [merge],
    files: { [POLICY]: policyYaml({ mode: opts.mode ?? 'cruise', mergeBar: opts.bar ?? true }) },
    model: byKind([merge]),
    mcp: c => (c.tool === 'runs_prs' && c.args.run_id === merge.run_id ? text(prEvents('acme/app', 12)) : undefined),
    gh: argv => {
      if (opts.ghDown) return { exitCode: 1, stderr: 'gh: not logged in' }
      const a = argv.join(' ')
      if (a.startsWith('gh pr view 12 --repo acme/app --json headRefOid')) return { stdout: JSON.stringify({ headRefOid: 'abc', reviewDecision: opts.review ?? 'APPROVED', state: 'OPEN', isDraft: false }) }
      if (a.startsWith('gh pr checks 12 --repo acme/app --required')) return { stdout: JSON.stringify(opts.checks ?? [{ name: 'ci', bucket: 'pass' }]) }
      if (a.startsWith('gh api graphql')) {
        const nodes = (opts.threads ?? [true]).map(isResolved => ({ isResolved }))
        const reviewThreads = { totalCount: nodes.length + (opts.morePages ? 100 : 0), pageInfo: { hasNextPage: opts.morePages === true }, nodes }
        return { stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: 'abc', reviewThreads } } } }) }
      }
      return undefined
    },
  })
}

test('US2: Cruise approves a merge only when checks, reviews and threads hold at the head, and never merges', async ($, on) => {
  const ok = mergeWorld(on, {})
  await start($, ok)
  expect(ok.answers().map(c => c.args.answer)).toEqual(['Merge'])
  // The threads are read with their count and whether more pages exist.
  expect(ok.runs.some(r => r.argv[0] === 'gh' && r.argv.join(' ').includes('reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved}}'))).toBe(true)
  neverActs(ok)
})

for (const [name, opts, why] of [
  ['an unresolved thread', { threads: [true, false] }, /1 review thread is unresolved/],
  // All threads on the first page resolved, but more pages exist.
  ['review threads past the first page', { morePages: true }, /more review threads than one read shows \(101\)/],
  ['a failing required check', { checks: [{ name: 'ci', bucket: 'fail' }] }, /required checks not passing \(ci: fail\)/],
  ['a missing review', { review: 'REVIEW_REQUIRED' }, /required reviews are not given/],
  ['gh that cannot read', { ghDown: true }, /could not read acme\/app#12/],
  ['the merge bar off', { bar: false }, /the merge bar is off/],
  // Routine has no merge rule at all: the model naming one is not obeyed.
  ['Routine mode', { mode: 'routine' }, /"preset\.approve-merge" does not exist/],
] as const) {
  test(`US2: Cruise does not approve a merge with ${name}`, async ($, on) => {
    const w = mergeWorld(on, opts)
    await start($, w)
    expect(w.answers()).toHaveLength(0)
    expect(String(w.journal()[0]!.reason)).toMatch(why)
    expect(w.notified).toHaveLength(1)
    neverActs(w)
  })
}

test('US2: when every choice but one is untrue, the honest one is sent, or the person is asked', async ($, on) => {
  const w = world(on, {
    asks: [UNTRUE_ASK],
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    model: () => decision({ gate: 'proceed', rule_id: 'preset.proceed', choice_index: 1, reasoning: 'Choice 0 claims tests pass; they were not run.' }),
  })
  await start($, w)
  expect(w.answers().map(c => c.args.answer)).toEqual(['Report: tests were not run'])
})

test('US2: when the model finds every choice untrue it asks the person', async ($, on) => {
  const w = world(on, { asks: [UNTRUE_ASK], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: () => decision({ gate: 'proceed', outcome: 'notify', reasoning: 'every choice is untrue' }) })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(w.journal()[0]).toMatchObject({ outcome: 'notified', reasoning: 'every choice is untrue' })
})

test('US2: a choice that is not offered is never sent', async ($, on) => {
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: () => decision({ gate: 'proceed', rule_id: 'preset.proceed', choice_index: 5 }) })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(w.journal()[0]).toMatchObject({ outcome: 'notified', reason: 'the chosen answer is not one of the offered choices' })
})

test('US2: an org that answers approvals only on the web: the ask goes to the person without a model call', async ($, on) => {
  const plan = ROUTINE_ASKS[4]!
  const w = world(on, {
    asks: [plan],
    files: { [POLICY]: policyYaml({ mode: 'cruise' }) },
    model: byKind([plan]),
    mcp: c => (c.tool === 'inbox_get' ? text(inboxGet(plan, { answerable: false, blocked: 'approval_gates_disabled' })) : undefined),
  })
  await start($, w)
  expect(w.prompts).toHaveLength(0)
  expect(w.answers()).toHaveLength(0)
  expect(String(w.journal()[0]!.reason)).toMatch(/approval_gates_disabled/)
})

// ── US3 ──────────────────────────────────────────────────────────────────────

const BILLING_POLICY = policyYaml({
  mode: 'routine',
  extra: [
    'components:',
    '  - name: billing',
    '    repo: acme/app',
    '    paths:',
    '      - services/billing/**',
    'rules:',
    '  - id: billing-ask-me',
    '    action: protect',
    '    components:',
    '      - billing',
    '    says: Anything touching billing, ask me, never auto-answer.',
  ].join('\n'),
})

// A model stand-in that finds the billing match from the files in the prompt.
function billingModel(prompt: string, id: string): string {
  // The PR's own file, not the component's glob the rules block names.
  const touches = prompt.includes('services/billing/rounding.go')
  return touches
    ? decision({ gate: 'proceed', rule_id: 'preset.proceed', matched: ['preset.proceed', 'billing-ask-me'], touches: ['billing'] })
    : decision({ gate: id === 'billing' || id === 'docs' ? 'proceed' : 'other', rule_id: 'preset.proceed' })
}

function billingWorld(on: On, ask: AskFixture, files: { files: { path: string }[]; title: string } | 'gh-down') {
  return world(on, {
    asks: [ask],
    files: { [POLICY]: BILLING_POLICY },
    model: billingModel,
    mcp: c => (c.tool === 'runs_prs' && c.args.run_id === ask.run_id ? text(prEvents('acme/app', 41)) : undefined),
    gh: argv => (argv.join(' ').startsWith('gh pr view 41 --repo acme/app --json files,title') ? (files === 'gh-down' ? { exitCode: 1, stderr: 'HTTP 502' } : { stdout: JSON.stringify(files) }) : undefined),
  })
}

test('US3: a rule said in plain words is read back before it is written', async ($, on) => {
  const w = world(on, { files: { [POLICY]: policyYaml({ mode: 'routine' }) } })
  await start($, w)
  const before = w.files.get(POLICY)!.text
  const comp = await tool($, 'autopilot_rules', { op: 'add_component', component: { name: 'billing', repo: 'acme/app', paths: ['services/billing/**'] }, confirm: false })
  expect(comp).toMatchObject({ saved: false, read_back: 'Component billing: acme/app services/billing/**' })
  expect(w.files.get(POLICY)!.text).toBe(before)
  await tool($, 'autopilot_rules', { op: 'add_component', component: { name: 'billing', repo: 'acme/app', paths: ['services/billing/**'] }, confirm: true })
  const rule = { id: 'billing-ask-me', action: 'protect', components: ['billing'], says: "every time something touches billing, notify me and don't auto-answer" }
  const preview = await tool($, 'autopilot_rules', { op: 'add', rule, confirm: false })
  expect(preview.saved).toBe(false)
  expect(preview.read_back).toBe("billing-ask-me: questions about any question when the run's work touches billing (acme/app: services/billing/**) always go to you; Autopilot never answers them.")
  expect(w.files.get(POLICY)!.text).not.toContain('billing-ask-me')
  expect((await tool($, 'autopilot_rules', { op: 'add', rule, confirm: true })).saved).toBe(true)
  expect(w.files.get(POLICY)!.text).toContain('id: billing-ask-me')
  expect(((await tool($, 'autopilot_rules', { op: 'list' })).rules as string[])[0]).toMatch(/^billing-ask-me: /)
  // An answer rule over a never-auto kind is refused, and says why.
  const bad = await tool($, 'autopilot_rules', { op: 'add', rule: { id: 'ship-it', action: 'answer', kinds: ['deploy'], guidance: 'yes' }, confirm: true })
  expect(String(bad.error)).toMatch(/never-auto/)
  // Removing reads back too.
  expect((await tool($, 'autopilot_rules', { op: 'remove', id: 'billing-ask-me', confirm: false })).read_back).toMatch(/^Remove: billing-ask-me/)
  expect(w.files.get(POLICY)!.text).toContain('id: billing-ask-me')
})

test('US3: a component protect rule stops an answer when the run changes that component', async ($, on) => {
  const w = billingWorld(on, BILLING_ASK, BILLING_FILES)
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(w.journal()[0]).toMatchObject({ outcome: 'notified', reason: 'protect rule billing-ask-me matches' })
  expect(w.prompts[0]!.prompt).toContain('services/billing/rounding.go')
  expect(w.notified).toHaveLength(1)
})

test('US3: the same rule lets an answer through when the run changes other files', async ($, on) => {
  const w = billingWorld(on, { ...BILLING_ASK, ask_id: 'docs', run_id: 'run-billing' }, DOCS_FILES)
  await start($, w)
  expect(w.answers().map(c => c.args.answer)).toEqual(['Proceed'])
})

test('US3: unreadable PR files count as protected', async ($, on) => {
  const w = billingWorld(on, BILLING_ASK, 'gh-down')
  await start($, w)
  expect(w.prompts).toHaveLength(0)
  expect(w.answers()).toHaveLength(0)
  expect(String(w.journal()[0]!.reason)).toMatch(/files could not be read, and protect rule billing-ask-me depends on them/)
})

test("US3: in a train the person's answers outrank presets and are read again before each answer", async ($, on) => {
  const first = { ...PROCEED, ask_id: 'p1', run_id: 'run-p1' }
  const second = { ...PROCEED, ask_id: 'p2', run_id: 'run-p2' }
  const third = { ...PROCEED, ask_id: 'p3', run_id: 'run-p3' }
  let phase = 0
  const w = world(on, {
    asksAt: () => [[first], [second], [third]][phase]!,
    files: { [POLICY]: policyYaml({ mode: 'routine' }) },
    // p1 goes to the person; after that the stub follows the person's
    // decision when the prompt carries it.
    model: (prompt, id) =>
      id === 'p1' ? decision({ gate: 'proceed', outcome: 'notify' }) : decision({ gate: 'proceed', rule_id: 'preset.proceed', choice_index: prompt.includes('"answer":"Stop"') ? 1 : 0 }),
  })
  await start($, w)
  const started = await tool($, 'autopilot_train', { op: 'start', train: 'week-48', confirm: true })
  expect(started.read_back).toEqual(['Train week-48.'])
  // The person answers p1 themselves, from the pane.
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  await ui.press({ key: 'ans:p1:1' })
  await ui.unmount()
  phase = 1
  await w.clock.advance(20_000)
  const decisions = w.files.get(`${DATA}/train-decisions.jsonl`)?.text ?? ''
  expect(JSON.parse(decisions.split('\n')[0]!)).toMatchObject({ train: 'week-48', answer: 'Stop', kind: 'proceed', deputy: 'shipper', source: 'person' })
  expect(w.answers().find(c => c.args.ask_id === 'p2')?.args.answer).toBe('Stop')
  // Read again before every answer: a decision added on disk is seen next.
  w.files.set(`${DATA}/train-decisions.jsonl`, { text: `${decisions}${JSON.stringify({ train: 'week-48', at: '', kind: 'proceed', repo: '', deputy: 'shipper', question: 'q', answer: 'Proceed later' })}\n`, mtime: NOW, mode: '0600' })
  phase = 2
  await w.clock.advance(20_000)
  expect(w.prompts.at(-1)!.prompt).toContain('Proceed later')
})

test('US3: an answer given on the web during a train is kept as a decision whose words are unknown', async ($, on) => {
  let gone = false
  const w = world(on, {
    asksAt: () => (gone ? [] : [{ ...PROCEED, kind: 'other' }]),
    files: { [POLICY]: policyYaml({ mode: 'routine' }), [`${DATA}/train.yaml`]: 'train: week-48\n' },
    model: () => decision({ gate: 'other' }),
    mcp: c => (c.tool === 'inbox_get' && gone ? text(inboxGet(PROCEED, { status: 'resolved', responded_by: 'Pat' })) : undefined),
  })
  await start($, w)
  gone = true
  await w.clock.advance(20_000)
  const line = JSON.parse((w.files.get(`${DATA}/train-decisions.jsonl`)?.text ?? '{}').split('\n')[0]!)
  expect(line).toMatchObject({ train: 'week-48', kind: 'other', answer: '' })
})

test('US3: ending the train removes the overlay and its decisions; the standing policy applies', async ($, on) => {
  const w = world(on, {
    asksAt: n => (n < 1 ? [] : [PROCEED]),
    files: {
      [POLICY]: policyYaml({ mode: 'routine' }),
      [`${DATA}/train.yaml`]: 'train: week-48\nrules:\n  - id: train-stop\n    action: protect\n    deputies: [shipper]\n',
      [`${DATA}/train-decisions.jsonl`]: `${JSON.stringify({ train: 'week-48', kind: 'proceed', answer: 'Stop' })}\n`,
    },
    model: prompt => (prompt.includes('train-stop') ? decision({ gate: 'proceed', rule_id: 'preset.proceed', matched: ['train-stop', 'preset.proceed'] }) : decision({ gate: 'proceed', rule_id: 'preset.proceed' })),
  })
  await start($, w)
  expect((await tool($, 'autopilot_train', { op: 'show' })).train).toBe('week-48')
  const end = await tool($, 'autopilot_train', { op: 'end', confirm: false })
  expect((end.read_back as string[])[0]).toMatch(/End train week-48/)
  expect(w.files.has(`${DATA}/train.yaml`)).toBe(true)
  await tool($, 'autopilot_train', { op: 'end', confirm: true })
  expect(w.files.has(`${DATA}/train.yaml`)).toBe(false)
  expect(w.files.has(`${DATA}/train-decisions.jsonl`)).toBe(false)
  await w.clock.advance(20_000)
  expect(w.prompts[0]!.prompt).not.toContain('train-stop')
  expect(w.prompts[0]!.prompt).toContain("THE PERSON'S DECISIONS DURING THIS TRAIN: (none)")
  expect(w.answers().map(c => c.args.answer)).toEqual(['Proceed'])
})

test('US3: an invalid policy keeps Autopilot off with the reason, and nothing is decided', async ($, on) => {
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: 'mode: turbo\nservers: [marshal-example]\n' }, model: byKind([PROCEED]) })
  await start($, w)
  expect(w.prompts).toHaveLength(0)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /the policy is invalid: mode must be one of shadow, routine, cruise/ })).toBeDefined()
  await ui.unmount()
})

test('US3: a server the policy does not name is never answered', async ($, on) => {
  const w = world(on, { asksAt: n => (n < 1 ? [] : [PROCEED]), files: { [POLICY]: policyYaml({ mode: 'routine', servers: ['marshal-other'] }) }, model: byKind([PROCEED]) })
  await start($, w)
  await w.clock.advance(20_000)
  expect(w.prompts).toHaveLength(0)
  expect(w.answers()).toHaveLength(0)
  expect(w.toasts.some(t => t.includes('shipper asks:'))).toBe(true)
})

test('US3: a policy edited while Autopilot runs applies on the next cycle', async ($, on) => {
  const w = world(on, { asksAt: n => (n < 1 ? [] : [PROCEED]), files: { [POLICY]: policyYaml({ mode: 'shadow' }) }, model: byKind([PROCEED]) })
  await start($, w)
  w.files.set(POLICY, { text: policyYaml({ mode: 'routine' }), mtime: NOW + 1, mode: '0600' })
  await w.clock.advance(20_000)
  expect(w.answers()).toHaveLength(1)
})

// ── US4 ──────────────────────────────────────────────────────────────────────

const CI_RUN = { id: 'run-ci', state: 'running', title: 'CI task', deputy: 'shipper', created_at: '2026-11-16T09:00:00Z' }

type Ci = { rollup: unknown; logs: Record<string, string>; down?: boolean }

function ciWorld(on: On, mode: string, ci: Ci, extraRuns: unknown[] = []) {
  return world(on, {
    asks: [],
    runs: [CI_RUN, ...extraRuns],
    files: { [POLICY]: policyYaml({ mode }) },
    mcp: c => (c.tool === 'runs_prs' ? text(prEvents('acme/app', c.args.run_id === 'run-ci' ? 12 : Number(String(c.args.run_id).replace(/\D/g, '')) + 100)) : undefined),
    gh: argv => {
      const a = argv.join(' ')
      if (ci.down) return { exitCode: 1, stderr: 'HTTP 502: Bad Gateway' }
      if (a.includes('--json headRefOid,statusCheckRollup')) return { stdout: JSON.stringify(ci.rollup) }
      const job = /--job (\d+) --log-failed/.exec(a)?.[1]
      if (job && ci.logs[job] !== undefined) return { stdout: ci.logs[job] }
      return undefined
    },
  })
}

function messages(w: World): Call[] {
  return w.calls.filter(c => c.tool === 'runs_message')
}

test('US4: the same check failing twice at the same step, across a push, sends the run one redacted message', async ($, on) => {
  const ci: Ci = { rollup: checkRollup('sha1', [{ name: 'test', conclusion: 'FAILURE', job: 101 }]), logs: { '101': failedLog('Run tests', '2026-11-16T10:00:01Z'), '102': failedLog('Run tests', '2026-11-16T10:05:09Z', 400) } }
  const w = ciWorld(on, 'routine', ci)
  await start($, w)
  expect(messages(w)).toHaveLength(0)
  // A new push fails the same check at the same step, with other timestamps.
  ci.rollup = checkRollup('sha2', [{ name: 'test', conclusion: 'FAILURE', job: 102 }])
  await w.clock.advance(80_000)
  const sent = messages(w)
  expect(sent).toHaveLength(1)
  const body = String(sent[0]!.args.text)
  expect(sent[0]!.args.run_id).toBe('run-ci')
  expect(body.startsWith('Autopilot: the check "test" failed again on acme/app#12, at the step "Run tests"')).toBe(true)
  expect(body).toContain('expected 200, got 500')
  for (const secret of [FAKE.ghp, FAKE.akia, 'hunter2', FAKE.pemBody]) expect(body.includes(secret)).toBe(false)
  expect(body).toContain('[REDACTED')
  const fence = body.split('```')[1]!.trim().split('\n')
  expect(fence.length).toBeLessThanOrEqual(200)
  expect(new TextEncoder().encode(fence.join('\n')).length).toBeLessThanOrEqual(16 * 1024)
  expect(w.journal().find(e => e.outcome === 'nudged')).toMatchObject({ check: 'test / Run tests', pr: 'acme/app#12', redacted: true })
  // Nothing more on later polls of the same failure.
  await w.clock.advance(120_000)
  expect(messages(w)).toHaveLength(1)
  neverActs(w)
})

test('US4: a pass resets the count', async ($, on) => {
  const ci: Ci = { rollup: checkRollup('sha1', [{ name: 'test', conclusion: 'FAILURE', job: 101 }]), logs: { '101': failedLog('Run tests', 'a'), '103': failedLog('Run tests', 'b') } }
  const w = ciWorld(on, 'routine', ci)
  await start($, w)
  ci.rollup = checkRollup('sha2', [{ name: 'test', conclusion: 'SUCCESS', job: 102 }])
  await w.clock.advance(80_000)
  ci.rollup = checkRollup('sha3', [{ name: 'test', conclusion: 'FAILURE', job: 103 }])
  await w.clock.advance(80_000)
  expect(messages(w)).toHaveLength(0)
})

test('US4: the third identical failure notifies the person, and the run gets no more messages', async ($, on) => {
  const ci: Ci = { rollup: checkRollup('sha1', [{ name: 'test', conclusion: 'FAILURE', job: 101 }]), logs: { '101': failedLog('Run tests', 'a'), '102': failedLog('Run tests', 'b'), '103': failedLog('Run tests', 'c'), '104': failedLog('Run tests', 'd') } }
  const w = ciWorld(on, 'routine', ci)
  await start($, w)
  for (const [sha, job] of [['sha2', 102], ['sha3', 103], ['sha4', 104]] as const) {
    ci.rollup = checkRollup(sha, [{ name: 'test', conclusion: 'FAILURE', job }])
    await w.clock.advance(80_000)
  }
  expect(messages(w)).toHaveLength(1)
  expect(w.notified.filter(n => n.includes('the check "test" failed 3 times'))).toHaveLength(1)
})

test('US4: a different failing step is a different failure', async ($, on) => {
  const ci: Ci = { rollup: checkRollup('sha1', [{ name: 'test', conclusion: 'FAILURE', job: 101 }]), logs: { '101': failedLog('Run tests', 'a'), '102': failedLog('Build', 'b') } }
  const w = ciWorld(on, 'routine', ci)
  await start($, w)
  ci.rollup = checkRollup('sha2', [{ name: 'test', conclusion: 'FAILURE', job: 102 }])
  await w.clock.advance(80_000)
  expect(messages(w)).toHaveLength(0)
})

test('US4: Shadow only notifies', async ($, on) => {
  const ci: Ci = { rollup: checkRollup('sha1', [{ name: 'test', conclusion: 'FAILURE', job: 101 }]), logs: { '101': failedLog('Run tests', 'a'), '102': failedLog('Run tests', 'b') } }
  const w = ciWorld(on, 'shadow', ci)
  await start($, w)
  ci.rollup = checkRollup('sha2', [{ name: 'test', conclusion: 'FAILURE', job: 102 }])
  await w.clock.advance(80_000)
  expect(messages(w)).toHaveLength(0)
  expect(w.notified.filter(n => n.includes('the check "test" failed twice'))).toHaveLength(1)
})

test('US4: a running run silent past the limit is reported once', async ($, on) => {
  const ci: Ci = { rollup: checkRollup('sha1', []), logs: {} }
  const w = ciWorld(on, 'routine', ci)
  await start($, w)
  await w.clock.advance(29 * 60_000)
  expect(w.notified.some(n => n.includes('running for'))).toBe(false)
  await w.clock.advance(2 * 60_000)
  expect(w.notified.filter(n => n.includes('CI task: running for 3'))).toHaveLength(1)
  await w.clock.advance(10 * 60_000)
  expect(w.notified.filter(n => n.includes('running for'))).toHaveLength(1)
})

test('US4: checks gh cannot read skip the run, with the reason journaled once', async ($, on) => {
  const ci: Ci = { rollup: {}, logs: {}, down: true }
  const w = ciWorld(on, 'routine', ci)
  await start($, w)
  await w.clock.advance(120_000)
  const skipped = w.journal().filter(e => String(e.reason).startsWith('skipped:'))
  expect(skipped).toHaveLength(1)
  expect(String(skipped[0]!.reason)).toMatch(/gh could not read acme\/app#12's checks$/)
  expect(w.notified).toHaveLength(0)
})

test('US4: at most 5 PRs are read a cycle, round robin, each at most once a minute', async ($, on) => {
  const many = Array.from({ length: 29 }, (_, i) => ({ id: `run-${i}`, state: 'running', title: `Run ${i}`, deputy: 'shipper', created_at: '2026-11-16T09:00:00Z' }))
  const ci: Ci = { rollup: checkRollup('sha1', []), logs: {} }
  const w = ciWorld(on, 'routine', ci, many)
  await start($, w)
  const views = () => w.runs.filter(r => r.argv[0] === 'gh' && r.argv.includes('headRefOid,statusCheckRollup'))
  expect(views()).toHaveLength(5)
  await w.clock.advance(20_000)
  expect(views()).toHaveLength(10)
  await w.clock.advance(40_000)
  expect(views()).toHaveLength(20)
  // Every PR got its turn; none was read twice in its first minute.
  const read = views().map(r => r.argv[3])
  expect(new Set(read).size).toBe(read.length)
  // No log was fetched: nothing failed.
  expect(w.runs.some(r => r.argv.includes('--log-failed'))).toBe(false)
})

// ── US6 ──────────────────────────────────────────────────────────────────────

test('US6: explain (e) shows the rule, the reasoning and the question as it was asked', async ($, on) => {
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: policyYaml() }, model: () => decision({ gate: 'proceed', rule_id: 'preset.proceed', reasoning: 'The run recommends the split and nothing contradicts it.' }) })
  await start($, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FLEET, surface })
    await ui.press({ key: 'ap:e:proceed' })
    await ui.press({ key: 'ap:explain-key' })
    expect(await ui.find({ type: 'Text', text: /^Why: Task proceed$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^preset\.proceed: Autopilot may answer questions about going ahead with the run's recommendation/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'The run recommends the split and nothing contradicts it.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^I plan to split the PR in two as recommended\. Proceed\?\nChoices: Proceed \| Stop$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^shadow$/ })).toBeDefined()
    await ui.press({ key: 'ap:explain-key' })
    expect(await ui.find({ type: 'Text', text: /^Why: / })).toBeUndefined()
    await ui.unmount()
  }
  // The same, from the skill.
  const j = await tool($, 'autopilot_journal', { ask_id: 'proceed' })
  expect((j.entries as Record<string, unknown>[])[0]).toMatchObject({ outcome: 'would_answer', rule_id: 'preset.proceed', reasoning: 'The run recommends the split and nothing contradicts it.', asked: { choices: ['Proceed', 'Stop'] } })
})

test('US6: open (o) opens the selected run in the browser, or copies its address', async ($, on) => {
  const w = world(on, {
    asks: [PROCEED],
    files: { [POLICY]: policyYaml(), [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { 'marshal-example': { type: 'http', url: 'https://marshal.example.com/mcp' } } }) },
    model: byKind([PROCEED]),
  })
  await start($, w)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  await ui.press({ key: 'ap:open' })
  await ui.unmount()
  const href = 'https://marshal.example.com/runs/run-proceed'
  expect(w.runs.filter(r => r.argv[1] === href).map(r => r.argv[0])).toEqual(['xdg-open', 'open'])
  expect(w.toasts.at(-1)).toBe(`Copied ${href}`)
})

test('US6: after every watched run has ended, status offers the review of their deputies', async ($, on) => {
  let ended = false
  const w = world(on, {
    asksAt: () => (ended ? [] : [PROCEED]),
    files: { [POLICY]: policyYaml() },
    model: byKind([PROCEED]),
    mcp: c =>
      c.tool === 'runs_list'
        ? text({ runs: [{ id: 'run-proceed', state: ended ? 'succeeded' : 'awaiting_human', title: 'Task proceed', deputy: 'shipper', created_at: '2026-11-16T09:00:00Z', ...(ended && { completed_at: '2026-11-16T10:01:00Z' }) }] })
        : undefined,
  })
  await start($, w)
  expect((await tool($, 'autopilot_status')).all_watched_runs_ended).toBe(false)
  ended = true
  await w.clock.advance(20_000)
  const s = await tool($, 'autopilot_status')
  expect(s.all_watched_runs_ended).toBe(true)
  expect(s.deputies_of_watched_runs).toEqual(['shipper'])
})

// ── Review fixes (PR 2973) ───────────────────────────────────────────────────

// A fleet notice (as without Autopilot), not one Autopilot sent.
function fleetNotice(w: World, q: string): boolean {
  return w.toasts.some(t => t.includes('shipper asks:') && t.includes(q) && !t.includes('(Autopilot'))
}

test('US2: with watch.repos set, only a run whose pull requests are in a watched repository is decided', async ($, on) => {
  const inApp = { ...PROCEED, ask_id: 'in-app', run_id: 'run-in-app', question: PROCEED.question.replace('Proceed?', 'Proceed with app?') }
  const inOther = { ...PROCEED, ask_id: 'in-other', run_id: 'run-in-other', question: PROCEED.question.replace('Proceed?', 'Proceed with other?') }
  const noPr = { ...PROCEED, ask_id: 'no-pr', run_id: 'run-no-pr', question: PROCEED.question.replace('Proceed?', 'Proceed without a PR?') }
  const all = [inApp, inOther, noPr]
  const w = world(on, {
    asksAt: n => (n === 0 ? [] : all),
    files: { [POLICY]: policyYaml({ mode: 'routine', extra: 'watch:\n  repos: [acme/app]' }) },
    model: () => decision({ gate: 'proceed', rule_id: 'preset.proceed' }),
    mcp: c => (c.tool === 'runs_prs' ? text(c.args.run_id === 'run-in-app' ? prEvents('acme/app', 1) : c.args.run_id === 'run-in-other' ? prEvents('acme/other', 2) : { events: [] }) : undefined),
  })
  await start($, w)
  await w.clock.advance(20_000)
  expect(w.prompts.map(p => /ASK (\S+)/.exec(p.prompt)?.[1])).toEqual(['in-app'])
  expect(w.answers().map(c => c.args.ask_id)).toEqual(['in-app'])
  // The unwatched ones reach the person as without Autopilot, and are not journaled.
  expect(fleetNotice(w, 'Proceed with other?')).toBe(true)
  expect(fleetNotice(w, 'Proceed without a PR?')).toBe(true)
  expect(w.journal().map(e => e.ask_id)).toEqual(['in-app'])
})

test('US2: Routine does not answer a plan approval the model files under the proceed preset', async ($, on) => {
  const plan = ROUTINE_ASKS[4]!
  const w = world(on, { asks: [plan], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: () => decision({ gate: 'approve_plan', rule_id: 'preset.proceed' }) })
  await start($, w)
  expect(w.answers()).toHaveLength(0)
  expect(w.journal()[0]).toMatchObject({ outcome: 'notified', reason: 'rule preset.proceed does not cover approve_plan questions', gate: 'approve_plan' })
  expect(w.notified).toHaveLength(1)
})

test('US3: a train rule cannot take the id of a policy rule', async ($, on) => {
  const w = world(on, { files: { [POLICY]: policyYaml({ mode: 'routine', extra: 'rules:\n  - id: docs-ok\n    action: answer\n    guidance: answer it' }) } })
  await start($, w)
  await tool($, 'autopilot_train', { op: 'start', train: 'week-48', confirm: true })
  const r = await tool($, 'autopilot_train', { op: 'add', rules: [{ id: 'docs-ok', action: 'protect' }], confirm: true })
  expect(r.saved).toBe(false)
  expect(String(r.error)).toMatch(/"docs-ok" is already a rule of the policy/)
  expect(w.files.get(`${DATA}/train.yaml`)?.text).not.toContain('docs-ok')
  expect((await tool($, 'autopilot_train', { op: 'add', rules: [{ id: 'train-hold', action: 'protect' }], confirm: true })).saved).toBe(true)
})

test('US3: an invalid train overlay answers nothing, the fleet tells the person, and the strip says why', async ($, on) => {
  const w = world(on, {
    asksAt: n => (n === 0 ? [] : [PROCEED]),
    files: {
      [POLICY]: policyYaml({ mode: 'routine', extra: 'rules:\n  - id: docs-ok\n    action: answer\n    guidance: answer it' }),
      // Collides with the policy's rule: invalid.
      [`${DATA}/train.yaml`]: 'train: week-48\nrules:\n  - id: docs-ok\n    action: protect\n',
    },
    model: byKind([PROCEED]),
  })
  await start($, w)
  await w.clock.advance(20_000)
  expect(w.prompts).toHaveLength(0)
  expect(w.answers()).toHaveLength(0)
  expect(w.journal()).toHaveLength(0)
  expect(fleetNotice(w, 'Proceed?')).toBe(true)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /answers nothing until the train overlay is fixed or the train is ended: the train overlay is invalid: rules\[0\]\.id: "docs-ok" is already a rule/ })).toBeDefined()
  await ui.unmount()
  // Fixed on disk: the next cycle decides.
  w.files.set(`${DATA}/train.yaml`, { text: 'train: week-48\n', mtime: NOW + 5, mode: '0600' })
  await w.clock.advance(20_000)
  expect(w.answers()).toHaveLength(1)
})

test('US2: a question the per-cycle limit defers is still announced by the fleet, then decided', async ($, on) => {
  const qs = [0, 1, 2].map(i => ({ ...PROCEED, ask_id: `q${i}`, run_id: `run-q${i}`, kind: 'other', question: PROCEED.question.replace('Proceed?', `Proceed with part ${i}?`) }))
  const w = world(on, {
    asksAt: n => (n === 0 ? [] : qs),
    files: { [POLICY]: policyYaml({ mode: 'routine', extra: 'limits:\n  answers_per_cycle: 1' }) },
    model: () => decision({ gate: 'other' }),
  })
  await start($, w)
  await w.clock.advance(20_000)
  expect(w.prompts).toHaveLength(1)
  // The deferred two get the fleet's own new-question notice now.
  expect(fleetNotice(w, 'part 1')).toBe(true)
  expect(fleetNotice(w, 'part 2')).toBe(true)
  await w.clock.advance(40_000)
  expect(w.prompts).toHaveLength(3)
})

test('US2: a policy write sh fails is an error, never a write with the default mode', async ($, on) => {
  const w = world(on, { files: { [POLICY]: policyYaml({ mode: 'routine' }) }, sh: op => (op === 'autopilot-write' ? 'fail' : undefined) })
  await start($, w)
  await expect(tool($, 'autopilot_control', { action: 'pause' })).rejects.toThrow(/could not write .*policy\.yaml: sh: 1: cannot create/)
  expect(w.files.get(POLICY)).toMatchObject({ mode: '0600' })
  expect(w.files.get(POLICY)!.text).toContain('paused: false')
})

test('US2: a journal append sh fails is not written again through $.fs', async ($, on) => {
  const w = world(on, { asks: [PROCEED], files: { [POLICY]: policyYaml({ mode: 'routine' }) }, model: byKind([PROCEED]), sh: op => (op === 'autopilot-append' ? 'fail' : undefined) })
  await start($, w)
  // The answer stands; the journal is best effort and holds no 0644 copy.
  expect(w.answers()).toHaveLength(1)
  expect([...w.files.entries()].filter(([k]) => k.startsWith(`${DATA}/journal/`))).toHaveLength(0)
})

test('US2: where sh cannot start, $.fs writes the file', async ($, on) => {
  const w = world(on, { files: { [POLICY]: policyYaml({ mode: 'routine' }) }, sh: () => 'nostart' })
  await start($, w)
  expect((await tool($, 'autopilot_control', { action: 'pause' })).state).toBe('paused')
  expect(w.files.get(POLICY)).toMatchObject({ mode: '0644' })
  expect(w.files.get(POLICY)!.text).toContain('paused: true')
})

for (const via of ['inbox_get', 'runs_attention'] as const) {
  test(`US2: the answer is the server's exact choice text, double spaces and all (${via})`, async ($, on) => {
    const spaced = { ...PROCEED, choices: ['Proceed  now', 'Stop'] }
    const w = world(on, {
      asks: [spaced],
      files: { [POLICY]: policyYaml({ mode: 'routine' }) },
      model: byKind([spaced]),
      ...(via === 'runs_attention' && { tools: toolsFor(SERVER).filter(t => !t.endsWith('__inbox_get')) }),
    })
    await start($, w)
    expect(w.answers().map(c => c.args.answer)).toEqual(['Proceed  now'])
    expect(w.journal()[0]).toMatchObject({ outcome: 'answered', answer: 'Proceed  now' })
  })
}
