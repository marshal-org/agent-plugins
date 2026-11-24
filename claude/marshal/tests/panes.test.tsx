import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { ATTENTION, LIST, text } from './fixtures'

const FLEET = {
  plugin: 'marshal',
  component: 'Pane',
  requestId: 'marshal-fleet',
  props: { title: 'Marshal fleet', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const SPACE = { ...FLEET, requestId: 'marshal-space', props: { ...FLEET.props, title: 'Marshal space' } } as const

const TOOLS = ['Bash', 'mcp__marshal-example__runs_attention', 'mcp__marshal-example__runs_get', 'mcp__marshal-example__inbox_answer']

type Call = { server: string; tool: string; args: Record<string, unknown> }

// The engine beneath the plugin: tools, MCP answers, the panes, the screen.
function world(on: On, opts: { inSpace: boolean; mcp: (c: Call) => unknown | Promise<unknown>; tools?: string[]; files?: Record<string, string>; home?: string; store?: Record<string, unknown>; env?: Record<string, string> }) {
  const calls: Call[] = []
  const opened: string[] = []
  const reads: string[] = []
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  on('tool.list', () => ({ value: (opts.tools ?? TOOLS).map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) }))
  on('mcp.call', async (_, e) => {
    calls.push(e)
    return { value: (await opts.mcp(e)) as never }
  })
  on('fs.stat', () => (opts.inSpace ? { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }))
  // A terminal Claude Code draws links in, unless a test says otherwise.
  const env: Record<string, string | undefined> = { HOME: opts.home, ...(opts.env ?? { TERM_PROGRAM: 'ghostty' }) }
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const body = opts.files?.[e.path]
    return body === undefined ? { deny: 'ENOENT' } : { value: body }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  return { calls, status, toasts, clock, opened, reads, store }
}

function fleetMcp(c: Call): unknown {
  if (c.tool === 'runs_attention') return text(ATTENTION)
  if (c.tool === 'runs_list') return text(LIST)
  if (c.tool === 'inbox_answer') return text({ ask_id: c.args.ask_id, status: 'answered', run_id: 'run-1', rung: 'question' })
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true }
}

test('the fleet pane shows what needs you and answers with a press', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)

  expect(w.status.at(-1)).toBe('◆ 1 need you · ● 1 running · ✕ 1 failed or parked')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FLEET, surface })
    expect(await ui.find({ type: 'Text', text: /NEEDS YOU/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /shipper asks/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Merge PR #12\?/ } as never)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#12 fix login/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  await ui.press({ key: 'ans:ask-1:0' })
  const answer = w.calls.find(c => c.tool === 'inbox_answer')
  expect(answer?.args).toEqual({ ask_id: 'ask-1', answer: 'yes' })
  expect(w.toasts.some(t => t.startsWith('Answered: yes'))).toBe(true)
  await ui.unmount()
})

const QUEUE_TOOLS = [...TOOLS, 'mcp__marshal-example__runs_cancel_queued']

const QUEUED = [
  { kind: 'queued_launch', id: 'q-1', status: 'queued', deputy: 'shipper', mission: 'triage', title: 'Triage #40', created_at: '2026-11-16T09:50:00Z', position: 1, reason: 'Waiting: deputy limit reached, 3 of 3 running, position 1' },
  { kind: 'queued_launch', id: 'q-old', status: 'expired', deputy: 'shipper', mission: 'triage', title: 'Old launch', created_at: '2026-11-16T08:00:00Z', reason: 'expired' },
]

test('queued launches show in their own section, and in the counts', async ($, on) => {
  const w = world(on, {
    inSpace: false,
    tools: QUEUE_TOOLS,
    mcp: c => (c.tool === 'runs_list' ? text({ ...LIST, queued: QUEUED }) : fleetMcp(c)),
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)

  expect(w.calls.find(c => c.tool === 'runs_list')?.args.include_queued).toBe(true)
  expect(w.status.at(-1)).toBe('◆ 1 need you · ● 1 running · ◌ 1 queued · ✕ 1 failed or parked')
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /QUEUED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Triage #40/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Waiting: deputy limit reached, 3 of 3 running, position 1$/ })).toBeDefined()
  // A row that already left the queue is not shown.
  expect(await ui.find({ type: 'Text', text: /Old launch/ })).toBeUndefined()
  await ui.unmount()
})

test('an older server is not sent include_queued', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  expect('include_queued' in (w.calls.find(c => c.tool === 'runs_list')?.args ?? {})).toBe(false)
})

test('an ask card names the run it comes from', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /from #12 fix login · run run-1/ })).toBeDefined()
  await ui.unmount()
  // Found in the runs list: no extra read.
  expect(w.calls.some(c => c.tool === 'runs_get')).toBe(false)
})

test('an ask from a run beyond the newest runs reads its title once', async ($, on) => {
  const w = world(on, {
    inSpace: false,
    mcp: c => {
      if (c.tool === 'runs_list') return text({ runs: [] })
      if (c.tool === 'runs_get') return text({ id: 'run-1', state: 'awaiting_human', title: 'Old long task' })
      return fleetMcp(c)
    },
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  await w.clock.advance(20000)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /from Old long task · run run-1/ })).toBeDefined()
  await ui.unmount()
  expect(w.calls.filter(c => c.tool === 'runs_get').length).toBe(1)
})

test('a failed run can be cleared, and stays cleared', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Broken task/ })).toBeDefined()
  expect(await ui.find({ key: 'clear:run-failed' } as never)).toBeDefined()
  await ui.press({ key: 'clear:run-failed' })
  expect(await ui.find({ type: 'Text', text: /Broken task/ })).toBeUndefined()
  expect(w.status.at(-1)).toBe('◆ 1 need you · ● 1 running')
  expect(w.store.get('cleared:marshal-example')).toEqual(['run-failed'])
  // The next poll still has it failed on the server: the pane keeps it hidden.
  await w.clock.advance(20000)
  expect(await ui.find({ type: 'Text', text: /Broken task/ })).toBeUndefined()
  await ui.unmount()
})

test('a cleared run stays hidden in a new session', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp, store: { 'cleared:marshal-example': ['run-failed'] } })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  expect(w.status.at(-1)).toBe('◆ 1 need you · ● 1 running')
})

test('a parked run has no Clear button', async ($, on) => {
  const w = world(on, {
    inSpace: false,
    mcp: c => (c.tool === 'runs_attention' ? text({ ...ATTENTION, runs: [{ id: 'run-parked', state: 'parked', title: 'Waits for CI' }] }) : fleetMcp(c)),
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Waits for CI/ })).toBeDefined()
  expect(await ui.find({ key: 'clear:run-parked' } as never)).toBeUndefined()
  await ui.unmount()
})

test('a refused answer says where to answer instead', async ($, on) => {
  const w = world(on, {
    inSpace: false,
    mcp: c =>
      c.tool === 'inbox_answer'
        ? { content: [{ type: 'text', text: 'approval gates are answered in the web UI on this org' }], isError: true }
        : fleetMcp(c),
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  await ui.press({ key: 'ans:ask-1:1' })
  expect(w.toasts.some(t => t.includes('Not answered') && t.includes('web app'))).toBe(true)
  await ui.unmount()
})

test('a new ask between polls raises a toast', async ($, on) => {
  let asks: unknown[] = []
  const w = world(on, {
    inSpace: false,
    mcp: c => (c.tool === 'runs_attention' ? text({ ...ATTENTION, asks }) : fleetMcp(c)),
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  expect(w.toasts.length).toBe(0)
  asks = ATTENTION.asks
  await w.clock.advance(20000)
  expect(w.toasts.some(t => t.includes('shipper asks: Merge PR #12?'))).toBe(true)
})

test('not connected yet: the pane points to the install command', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp, tools: ['Bash'] })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  // The url is still the placeholder default, so it counts as not set.
  expect(await ui.find({ type: 'Text', text: /install command from Connect an agent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /marshal\.invalid/ })).toBeUndefined()
  await ui.unmount()
})

function spaceMcp(c: Call): unknown {
  if (c.args.space !== 'self' && c.args.space_id !== 'self' && c.args.run_id !== 'self') return { content: [{ type: 'text', text: 'expected self' }], isError: true }
  switch (c.tool) {
    case 'spaces_get':
      return text({ id: 'sp-1', name: 'checkout-fix', state: 'running' })
    case 'spaces_requests_list':
      return text({ items: [{ type: 'question', status: 'pending', payload: { question: 'May I use pypi.org?' }, created_at: '2026-11-16T09:00:00Z' }] })
    case 'spaces_audit':
      return text([{ action: 'network.request', status: 'denied', resource_type: 'host', resource_id: 'evil.example', created_at: '2026-11-16T09:00:00Z' }])
  }
  return { content: [{ type: 'text', text: 'not in scope' }], isError: true }
}

test('inside a space the inspector reads its own space, read only', async ($, on) => {
  const w = world(on, { inSpace: true, mcp: spaceMcp })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  expect(w.status.at(-1)).toBe('checkout-fix · running · ◆ 1 request pending')

  const ui = await $.ui.mount({ ...SPACE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /checkout-fix/ })).toBeDefined()
  await ui.press({ key: 'tab:audit' })
  expect(await ui.find({ type: 'Text', text: /evil\.example.*DENIED/ })).toBeDefined()
  await ui.unmount()

  // Every call the inspector made was a read of its own space.
  const reads = new Set(['spaces_get', 'spaces_audit', 'spaces_requests_list', 'spaces_reviews_list', 'spaces_ports', 'runs_changes', 'runs_usage'])
  expect(w.calls.every(c => reads.has(c.tool))).toBe(true)
})

test('inside a space without the self scope the inspector says why', async ($, on) => {
  const w = world(on, { inSpace: true, mcp: () => ({ content: [{ type: 'text', text: 'tool not allowed for orchestration' }], isError: true }) })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...SPACE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /self scope/ })).toBeDefined()
  await ui.unmount()
})

test('a tab pressed while a read runs is read right after it', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  let held = false
  const w = world(on, {
    inSpace: true,
    mcp: async c => {
      if (c.tool === 'spaces_get' && !held) {
        held = true
        await gate
      }
      return spaceMcp(c)
    },
  })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  const first = w.clock.advance(3500)
  const ui = await $.ui.mount({ ...SPACE, surface: 'terminal' })
  await ui.press({ key: 'tab:audit' })
  release()
  await first
  expect(await ui.find({ type: 'Text', text: /evil\.example.*DENIED/ })).toBeDefined()
  expect(w.calls.some(c => c.tool === 'spaces_audit')).toBe(true)
  await ui.unmount()
})

test('the band above the prompt shows the open ask and answers it', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const band = await $.ui.mount({
    plugin: 'marshal',
    component: 'AbovePrompt',
    props: { bodyColumns: 100, hasSurvey: false },
    surface: 'terminal',
  } as never)
  expect(await band.find({ type: 'Text', text: /Merge PR #12\?/ })).toBeDefined()
  await band.press({ key: 'band:ask-1:0' })
  expect(w.calls.find(c => c.tool === 'inbox_answer')?.args).toEqual({ ask_id: 'ask-1', answer: 'yes' })
  await band.unmount()
})

test('the cost tab draws a bar per source', async ($, on) => {
  const w = world(on, {
    inSpace: true,
    mcp: c =>
      c.tool === 'runs_usage'
        ? text({ total_est_cost_usd: 3, by_source: [{ source: 'claude', est_cost_usd: 2 }, { source: 'compute', est_cost_usd: 1 }] })
        : spaceMcp(c),
  })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...SPACE, surface: 'terminal' })
  await ui.press({ key: 'tab:cost' })
  expect(await ui.find({ type: 'Text', text: /\$3\.00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /█/ })).toBeDefined()
  await ui.unmount()
})

test('a space with no run reads its cost through spaces_usage', async ($, on) => {
  const w = world(on, {
    inSpace: true,
    tools: [...TOOLS, 'mcp__marshal-example__spaces_usage', 'mcp__marshal-example__spaces_changes'],
    mcp: c =>
      c.tool === 'spaces_usage'
        ? text({ combined_est_cost_usd: 0.1475, llm_cost: { available: true, total_est_cost_usd: 0.1475, by_source: [], conversations: [] } })
        : c.tool === 'runs_usage'
          ? { content: [{ type: 'text', text: 'this space has no run' }], isError: true }
          : spaceMcp(c),
  })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...SPACE, surface: 'terminal' })
  await ui.press({ key: 'tab:cost' })
  expect(await ui.find({ type: 'Text', text: /\$0\.15/ })).toBeDefined()
  expect(w.calls.find(c => c.tool === 'spaces_usage')?.args).toEqual({ space: 'self' })
  expect(w.calls.some(c => c.tool === 'runs_usage')).toBe(false)
  await ui.unmount()
})

test('a run shows its pull requests when the server has runs_prs', async ($, on) => {
  const w = world(on, {
    inSpace: false,
    tools: [...TOOLS, 'mcp__marshal-example__runs_prs'],
    mcp: c =>
      c.tool === 'runs_prs'
        ? text({ events: [{ action: 'opened', repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', outcome: { state: 'merged' } }] })
        : fleetMcp(c),
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /app#12/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^merged$/ })).toBeDefined()
  await ui.unmount()
  // Ended runs are read once; a second poll reads no PRs for them again.
  const first = w.calls.filter(c => c.tool === 'runs_prs').length
  await w.clock.advance(20000)
  const ended = w.calls.filter(c => c.tool === 'runs_prs').length - first
  expect(ended).toBeLessThan(first)
})

test('inside a space the inspector stays closed until /marshal-space', async ($, on) => {
  const w = world(on, { inSpace: true, mcp: spaceMcp })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  expect(w.opened).toEqual([])
  await $.command.run({ command: 'marshal-space', args: '' } as Parameters<typeof $.command.run>[0])
  expect(w.opened).toEqual(['marshal-space'])
})

test('an audit answer over the Claude Code token limit is read from the file it was saved to', async ($, on) => {
  const saved = '/home/agent/.claude/projects/-workspace/abc/tool-results/mcp-marshal-orchestration-spaces_audit-1.txt'
  const note = `Error: result (61,820 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: Plain text\n`
  const w = world(on, {
    inSpace: true,
    mcp: c => (c.tool === 'spaces_audit' ? { content: [{ type: 'text', text: note }], isError: false } : spaceMcp(c)),
    files: { [saved]: JSON.stringify([{ action: 'network.request', status: 'denied', resource_type: 'host', resource_id: 'big.example', created_at: '2026-11-16T09:00:00Z' }]) },
  })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...SPACE, surface: 'terminal' })
  await ui.press({ key: 'tab:audit' })
  expect(await ui.find({ type: 'Text', text: /big\.example.*DENIED/ })).toBeDefined()
  expect(w.reads).toEqual([saved])
  await ui.unmount()
})

test('on a laptop /marshal-space says it works only inside a space', async ($, on) => {
  const w = world(on, { inSpace: false, mcp: fleetMcp })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'marshal-space', args: '' } as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(out)).toContain('works only inside a Marshal space')
  expect(w.opened).toEqual([])
})

test('inside a space /marshal-fleet lists the runs this space launched', async ($, on) => {
  // A space's marshal-orchestration: run tools, but no runs_attention or inbox_answer.
  const tools = ['Bash', 'mcp__marshal-orchestration__runs_get', 'mcp__marshal-orchestration__runs_list', 'mcp__marshal-orchestration__spaces_get']
  const w = world(on, { inSpace: true, tools, mcp: c => (c.tool === 'runs_list' ? fleetMcp(c) : spaceMcp(c)) })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  // Not read until opened: the inspector's reads only.
  expect(w.calls.some(c => c.tool === 'runs_list')).toBe(false)

  await $.command.run({ command: 'marshal-fleet', args: '' } as Parameters<typeof $.command.run>[0])
  await w.clock.advance(100)
  expect(w.opened).toEqual(['marshal-fleet'])
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Runs this space launched/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /NEEDS YOU/ })).toBeUndefined()
  await ui.unmount()
  expect(w.calls.some(c => c.tool === 'runs_attention' || c.tool === 'inbox_answer')).toBe(false)
  // The status line stays the space's own.
  expect(w.status.at(-1)).toBe('checkout-fix · running · ◆ 1 request pending')
})

test('inside a space the plugin never reads its own server, only the space one', async ($, on) => {
  // The plugin's own server listed first (signed in through the default url).
  const tools = ['mcp__plugin_marshal_marshal__runs_get', 'mcp__plugin_marshal_marshal__runs_attention', 'mcp__marshal-orchestration__runs_get', 'mcp__marshal-orchestration__spaces_get']
  const w = world(on, { inSpace: true, tools, mcp: spaceMcp })
  await $.session.start({ cwd: '/home/agent', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  expect(w.calls.length).toBeGreaterThan(0)
  expect(w.calls.every(c => c.server === 'marshal-orchestration')).toBe(true)
})

test('run links go to the web app of the server the panes read, not the default url', async ($, on) => {
  const w = world(on, {
    inSpace: false,
    mcp: fleetMcp,
    home: '/h',
    files: { '/h/.claude.json': JSON.stringify({ mcpServers: { 'marshal-example': { type: 'http', url: 'https://marshal.example.com/mcp' } } }) },
  })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'desktop' })
  const hrefs = (await ui.findAll({ type: 'Link' })).map(l => String(l.props.href))
  expect(hrefs.some(h => h.startsWith('https://marshal.example.com/runs/'))).toBe(true)
  expect(hrefs.every(h => h.startsWith('https://marshal.example.com'))).toBe(true)
  await ui.unmount()
})

// The desktop app names its Marshal connector by a UUID, which no config file
// holds: links fall back to the url setting, and the header shows its host.
const UUID_SERVER = '95ac8332-eba4-42c9-b98f-c20c87d09469'
const UUID_TOOLS = ['runs_attention', 'runs_get', 'inbox_answer'].map(t => `mcp__${UUID_SERVER}__${t}`)

test('a desktop connector named by a UUID links every message to its run', { options: { url: 'https://marshal.example.com/mcp' } }, async ($, on) => {
  const w = world(on, { inSpace: false, tools: UUID_TOOLS, mcp: fleetMcp, home: '/h', files: { '/h/.claude.json': '{}' } })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await w.clock.advance(3500)
  expect(w.calls.every(c => c.server === UUID_SERVER)).toBe(true)
  const run1 = 'https://marshal.example.com/runs/run-1'
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FLEET, surface })
    // The header names the host, never the UUID.
    expect(await ui.find({ type: 'Text', text: new RegExp(UUID_SERVER) })).toBeUndefined()
    const links = await ui.findAll({ type: 'Link' })
    const to = (href: string) => links.filter(l => String(l.props.href) === href)
    expect(to('https://marshal.example.com')).toHaveLength(1)
    // The ask card: its title, the run it comes from, and "open run"; and the run row's title.
    expect(to(run1).length).toBeGreaterThanOrEqual(4)
    expect(to('https://marshal.example.com/runs/run-done')).toHaveLength(1)
    await ui.unmount()

    const band = await $.ui.mount({ plugin: 'marshal', surface, component: 'AbovePrompt', props: { bodyColumns: 80, hasSurvey: false } } as never)
    expect((await band.findAll({ type: 'Link' })).map(l => String(l.props.href))).toEqual([run1])
    await band.unmount()
  }
})

test('without a url setting a UUID connector draws no links and no UUID', async ($, on) => {
  const w = world(on, { inSpace: false, tools: UUID_TOOLS, mcp: fleetMcp, home: '/h', files: { '/h/.claude.json': '{}' } })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: new RegExp(UUID_SERVER) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /shipper asks/ })).toBeDefined()
  await ui.unmount()
})

// A terminal Claude Code draws no links in (herdr) would get "text URL" for
// each Link: the pane draws none, shows the run URL once in full, and says how
// to turn links on.
test('in a terminal without links the pane draws plain text and the full run URL', { options: { url: 'https://marshal.example.com/mcp' } }, async ($, on) => {
  const w = world(on, { inSpace: false, tools: UUID_TOOLS, mcp: fleetMcp, home: '/h', files: { '/h/.claude.json': '{}' }, env: { TERM_PROGRAM: 'herdr', TERM: 'xterm-256color' } })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /^https:\/\/marshal\.example\.com\/runs\/run-1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /FORCE_HYPERLINK=1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /shipper asks/ })).toBeDefined()
  await ui.unmount()
  // The desktop app always draws links.
  const desk = await $.ui.mount({ ...FLEET, surface: 'desktop' })
  expect((await desk.findAll({ type: 'Link' })).length).toBeGreaterThan(0)
  expect(await desk.find({ type: 'Text', text: /FORCE_HYPERLINK/ })).toBeUndefined()
  await desk.unmount()
})

test('FORCE_HYPERLINK=1 turns links on in herdr', { options: { url: 'https://marshal.example.com/mcp' } }, async ($, on) => {
  const w = world(on, { inSpace: false, tools: UUID_TOOLS, mcp: fleetMcp, home: '/h', files: { '/h/.claude.json': '{}' }, env: { TERM_PROGRAM: 'herdr', FORCE_HYPERLINK: '1' } })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.advance(3500)
  const ui = await $.ui.mount({ ...FLEET, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Link' })).length).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: /FORCE_HYPERLINK/ })).toBeUndefined()
  await ui.unmount()
})
