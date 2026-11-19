import { describe, expect, test } from 'claude-code/testing'

import { marshalServers, pickServer, readConfig } from '../hooks/config'
import { buildCell, changes, plainText, prLabel, prsFrom, resultJson, serverUrl, statusLine, webBase } from '../hooks/fleet-model'
import { formatAudit, formatCost, formatPorts, formatRequests, pendingCount, tabSpec } from '../hooks/space-model'
import { ATTENTION, LIST } from './fixtures'

describe('config', () => {
  test('finds Marshal servers by their tools and picks one', async () => {
    const tools = ['Bash', 'mcp__marshal-example__runs_attention', 'mcp__marshal-example__runs_get', 'mcp__claude_ai_Gmail__x', 'mcp__marshal-prod__runs_get']
    const found = marshalServers(tools)
    expect(found).toEqual(['marshal-example', 'marshal-prod'])
    expect(pickServer(readConfig({}), found)).toBe('marshal-example')
    expect(pickServer(readConfig({ server: 'marshal-prod' }), found)).toBe('marshal-prod')
    expect(pickServer(readConfig({ server: 'nope' }), found)).toBe('')
  })

  test('with an address set, the plugin\'s own server wins', async () => {
    const found = marshalServers(['mcp__marshal-example__runs_get', 'mcp__plugin_marshal_marshal__runs_get'])
    expect(pickServer(readConfig({ url: 'https://marshal.acme.internal/mcp' }), found)).toBe('plugin_marshal_marshal')
    expect(pickServer(readConfig({}), found)).toBe('marshal-example')
    expect(webBase(readConfig({ url: 'https://marshal.acme.internal/mcp' }).url)).toBe('https://marshal.acme.internal')
  })

  test('poll interval has a floor', async () => {
    expect(readConfig({ pollSeconds: 1 }).pollMs).toBe(5000)
    expect(readConfig({}).pollMs).toBe(20000)
  })
})

describe('fleet model', () => {
  test('reads a JSON text result, and throws on a tool error', async () => {
    expect(resultJson({ content: [{ type: 'text', text: '{"a":1}' }], isError: false })).toEqual({ a: 1 })
    expect(() => resultJson({ content: [{ type: 'text', text: 'not allowed' }], isError: true })).toThrow('not allowed')
    // A list cut at the size cap keeps its complete items, even with "}," inside a string.
    const cut = '[{"a":"x},{y"},{"a":2},{"a":3,"b":"tr\n[truncated: 9000 bytes omitted]'
    expect(resultJson({ content: [{ type: 'text', text: cut }], isError: false })).toEqual([{ a: 'x},{y' }, { a: 2 }])
    expect(() => resultJson({ content: [{ type: 'text', text: '{"a":\n[truncated: 5 bytes omitted]' }], isError: false })).toThrow('did not answer JSON')
  })

  test('strips the untrusted markers', async () => {
    expect(plainText('<untrusted-content source="ask 1">Merge  it?</untrusted-content>')).toBe('Merge it?')
  })

  test('groups a cell', async () => {
    const cell = buildCell('marshal-example', false, '', ATTENTION, LIST)
    expect(cell.asks.map(a => a.askId)).toEqual(['ask-1'])
    expect(cell.asks[0]?.question).toBe('Merge PR #12?')
    expect(cell.asks[0]?.choices).toEqual(['yes', 'no'])
    expect(cell.attention.map(r => r.id)).toEqual(['run-failed'])
    expect(cell.active.map(r => r.id)).toEqual(['run-1'])
    expect(cell.recent.map(r => r.id)).toEqual(['run-done'])
    expect(statusLine({ cells: [cell], polledAt: 1 })).toBe('◆ 1 need you · ● 1 running · ✕ 1 failed or parked')
  })

  test('tells what changed, and nothing on the first poll', async () => {
    const empty = { cells: [], polledAt: 0 }
    const before = { cells: [buildCell('d', false, '', { asks: [], runs: [] }, { runs: [{ id: 'run-done', state: 'running', title: 'Done task' }] })], polledAt: 1 }
    const after = { cells: [buildCell('d', false, '', ATTENTION, LIST)], polledAt: 2 }
    expect(changes(empty, after)).toEqual([])
    const kinds = changes(before, after).map(c => c.kind).sort()
    expect(kinds).toEqual(['ask', 'attention', 'ended'])
  })

  test('web links come from the MCP URL', async () => {
    expect(webBase('https://marshal.example.com/mcp')).toBe('https://marshal.example.com')
    expect(webBase('javascript:alert(1)')).toBe('')
    const cfg = { projects: { '/w': { mcpServers: { 'marshal-example': { url: 'https://marshal.example.com/mcp' } } } } }
    expect(serverUrl(cfg, 'marshal-example', '/w')).toBe('https://marshal.example.com/mcp')
    expect(serverUrl(cfg, 'marshal-example', '/other')).toBe('https://marshal.example.com/mcp')
    expect(serverUrl(cfg, 'nope', '/w')).toBe('')
  })
})

describe('space model', () => {
  test('audit rows flag denied events', async () => {
    const now = Date.parse('2026-11-16T10:00:00Z')
    const lines = formatAudit(
      { events: [{ action: 'network.request', status: 'denied', metadata: { host: 'evil.example' }, created_at: '2026-11-16T09:59:00Z' }] },
      now,
    )
    expect(lines[0]?.tone).toBe('error')
    expect(lines[0]?.text).toContain('evil.example')
    expect(lines[0]?.text).toContain('DENIED')
  })

  test('pending requests count for the status line', async () => {
    const lines = formatRequests([{ type: 'network', status: 'pending', payload: { host: 'pypi.org' } }, { type: 'network', status: 'approved' }], 0)
    expect(pendingCount(lines)).toBe(1)
  })

  test('ports keep their preview link', async () => {
    const lines = formatPorts({ ports: [{ port: 3000, scheme: 'http', process: 'node', preview_url: 'https://p.example/x' }] })
    expect(lines[0]?.text).toBe(':3000  http  node')
    expect(lines[0]?.href).toBe('https://p.example/x')
  })

  test('an unknown tab falls back to the overview', async () => {
    expect(tabSpec('nope').id).toBe('overview')
    expect(tabSpec('audit').tool).toBe('spaces_audit')
    // A space with no run reads its changes and cost through the space tools.
    expect(tabSpec('cost').tool).toBe('runs_usage')
    expect(tabSpec('cost', true)).toMatchObject({ tool: 'spaces_usage', args: { space: 'self' } })
    expect(tabSpec('changes', true).tool).toBe('spaces_changes')
    expect(tabSpec('audit', true).tool).toBe('spaces_audit')
  })

  test('cost reads the space answer like the web Costs tab', () => {
    const lines = formatCost({
      combined_est_cost_usd: 0.1475,
      llm_cost: {
        available: true,
        total_est_cost_usd: 0.1475,
        by_source: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', est_cost_usd: 0.1475 }],
        conversations: [{ label: 'Conversation 1', model: 'claude-sonnet-5-5', turns: 2, context_tokens: 85700, context_window: 1000000, est_cost_usd: 0.1475 }],
      },
      compute_cost: { available: true, total_est_cost_usd: 0, estimated: true },
    })
    expect(lines.map(l => `${l.key}=${l.text}`)).toEqual([
      'total=$0.15',
      'model=$0.15',
      'claude-sonnet-5-5=$0.15',
      'compute=$0.00 (estimated)',
      'Conversation 1=$0.15 · claude-sonnet-5-5 · 2 turns · context 9%',
    ])
  })
})

describe('pull requests', () => {
  test('one per repo and number, GitHub state first, else the run\'s last act', async () => {
    const prs = prsFrom({
      events: [
        { action: 'opened', repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', outcome: { state: 'open' } },
        { action: 'pushed', repo: 'acme/app', number: 12 },
        { action: 'merged', repo: 'acme/web', number: 7, url: 'https://github.com/acme/web/pull/7' },
        { action: 'pushed', repo: '', number: 0 },
      ],
    })
    expect(prs.map(p => [prLabel(p), p.state])).toEqual([
      ['app#12', 'open'],
      ['web#7', 'merged'],
    ])
    expect(prs[0]?.url).toBe('https://github.com/acme/app/pull/12')
    expect(prsFrom(null)).toEqual([])
  })
})
