import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Answering, FleetAsk, FleetCell, FleetPr, FleetRun } from '../types'
import { EMPTY_FLEET, type Kit } from './atoms'
import { age, cut, prLabel, runUrl, totals } from './fleet-model'
import { answerAsk } from './fleet-poll'
import { mod, poll } from './state'

const fleetAtom = atom({ plugin: 'marshal', key: 'fleet' } as const, EMPTY_FLEET, { shape: 'fleet-1' })
const answeringAtom = atom({ plugin: 'marshal', key: 'answering' } as const, null as Answering)

export async function sendAnswer($: EngineInterface, server: string, askId: string, answer: string): Promise<void> {
  if (await answerAsk($, server, askId, answer)) await poll($)
}

export async function startAnswer($: EngineInterface, server: string, askId: string): Promise<void> {
  await update($, answeringAtom, () => ({ server, askId }))
}

// Markdown marks dropped, for one-line places (the band).
export function flat(md: string): string {
  return md
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// The ask's kind, when it adds something: a plain ask or question says nothing.
function rungLabel(rung: string): string {
  return rung === '' || rung === 'ask' || rung === 'question' ? '' : rung.replace('_', ' ')
}

// The cell's short name: "marshal-dev" reads "dev".
export function cellName(server: string): string {
  return server.replace(/^marshal[-_]?/, '') || server
}

type Look = { glyph: string; color: string | undefined; isDim: boolean }

// One glyph and color per run state, so a list reads at a glance.
export function look(state: string): Look {
  switch (state) {
    case 'running':
    case 'engaged':
      return { glyph: '●', color: 'success', isDim: false }
    case 'pending':
      return { glyph: '○', color: undefined, isDim: true }
    case 'awaiting_human':
      return { glyph: '◆', color: 'warning', isDim: false }
    case 'parked':
      return { glyph: '‖', color: 'warning', isDim: false }
    case 'succeeded':
      return { glyph: '✓', color: 'success', isDim: true }
    case 'canceled':
      return { glyph: '–', color: undefined, isDim: true }
    default:
      return { glyph: '✕', color: 'error', isDim: false }
  }
}

function section(kit: Kit, width: number, label: string, count: number, color?: string) {
  const { Box, Text } = kit
  const rule = Math.max(0, width - label.length - String(count).length - 6)
  return (
    <Box key={`sec:${label}`} flexDirection="row" gap={1} marginTop={1} paddingX={1}>
      <Text bold color={color}>
        {label.toUpperCase()}
      </Text>
      <Text dimColor>{count}</Text>
      <Text dimColor>{'─'.repeat(rule)}</Text>
    </Box>
  )
}

function stat(kit: Kit, key: string, glyph: string, n: number, label: string, color: string) {
  const { Text } = kit
  return (
    <Text key={key} color={n > 0 ? color : undefined} dimColor={n === 0} bold={n > 0}>
      {glyph} {n} {label}
    </Text>
  )
}

function header($: EngineInterface, kit: Kit, cell: FleetCell | undefined, t: ReturnType<typeof totals>, updated: string) {
  const { Box, Text, Button } = kit
  return (
    <Box key="head" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold color="suggestion">
            ◆ Marshal
          </Text>
          {cell && <Text dimColor>·</Text>}
          {cell && <Text bold>{cellName(cell.server)}</Text>}
          {cell?.isProd && (
            <Text bold color="inverseText" backgroundColor="error">
              {' PROD '}
            </Text>
          )}
        </Box>
        <Button key="refresh" label="↻ Refresh" plain hotkey="r" dimColor onPress={() => poll($)} />
      </Box>
      <Box flexDirection="row" gap={3} flexWrap="wrap">
        {stat(kit, 'st:asks', '◆', t.asks, 'need you', 'warning')}
        {stat(kit, 'st:active', '●', t.active, 'running', 'success')}
        {stat(kit, 'st:attention', '✕', t.attention, 'failed or parked', 'error')}
      </Box>
      <Text dimColor>updated {updated} ago</Text>
    </Box>
  )
}

const PR_LOOK: Record<string, { glyph: string; color?: string; isDim: boolean }> = {
  open: { glyph: '⎇', color: 'success', isDim: false },
  merged: { glyph: '⎇', color: 'merged', isDim: false },
  closed: { glyph: '⎇', isDim: true },
}

// A run's PRs, one chip each: the repo and number as a link, then its state.
function prChips(kit: Kit, runId: string, prs: readonly FleetPr[]) {
  const { Box, Text, Link } = kit
  return (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap" paddingLeft={2}>
      {prs.slice(0, 6).map(p => {
        const l = PR_LOOK[p.state] ?? PR_LOOK.open!
        const label = prLabel(p)
        return (
          <Box key={`pr:${runId}:${p.repo}#${p.number}`} flexDirection="row" gap={1}>
            <Text color={l.color} dimColor={l.isDim}>
              {l.glyph} {p.url && Link ? <Link href={p.url}>{label}</Link> : label}
            </Text>
            <Text dimColor>{p.state}</Text>
          </Box>
        )
      })}
      {prs.length > 6 && <Text dimColor>+{prs.length - 6} more</Text>}
    </Box>
  )
}

// A run: glyph, title (a link to the run page), age; the deputy and why it
// stopped under it; the full task, id and times revealed on hover.
function runRow(kit: Kit, now: number, cell: FleetCell, r: FleetRun) {
  const { Box, Text, Link } = kit
  const l = look(r.state)
  const href = runUrl(cell, r.id)
  // The glyph already says running or succeeded; other states are spelled out.
  const plain = r.state === 'running' || r.state === 'succeeded'
  const meta = [plain ? '' : r.state.replace('_', ' '), r.stopReason].filter(Boolean).join(' · ')
  const isActive = l.glyph === '●'
  return (
    <Box key={`run:${r.id}`} flexDirection="column" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={l.color} dimColor={l.isDim}>
          {l.glyph}
        </Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" bold={isActive} dimColor={l.isDim}>
            {href && Link ? <Link href={href}>{r.title}</Link> : r.title}
          </Text>
        </Box>
        {r.deputy !== '' && (
          <Box flexShrink={0}>
            <Text color="suggestion" dimColor wrap="truncate-end">
              {cut(r.deputy, 16)}
            </Text>
          </Box>
        )}
        <Box flexShrink={0}>
          <Text dimColor>{age(r.completedAt || r.createdAt, now).padStart(3)}</Text>
        </Box>
      </Box>
      {r.prs !== undefined && r.prs.length > 0 && prChips(kit, r.id, r.prs)}
      {meta !== '' && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {meta}
          </Text>
        </Box>
      )}
      <Box display="none" hover={{ display: 'flex' }} flexDirection="column" paddingLeft={2}>
        <Text dimColor wrap="wrap">
          {cut(r.title, 400)}
        </Text>
        <Text dimColor>
          run {r.id.slice(0, 8)} · started {age(r.createdAt, now)} ago{r.completedAt ? ` · ended ${age(r.completedAt, now)} ago` : ''}
        </Text>
      </Box>
    </Box>
  )
}

// An ask: an amber card with the question and one button per answer. No
// hotkeys on purpose: an answer can merge a PR, so it takes a deliberate press.
function askCard($: EngineInterface, kit: Kit, answering: Answering, cell: FleetCell, a: FleetAsk) {
  const { Box, Text, Button, Input, Link, Markdown } = kit
  const isAnswering = answering?.askId === a.askId && answering.server === cell.server
  const question = cut(a.question || '(no question text)', 1200)
  const rung = rungLabel(a.rung)
  const href = runUrl(cell, a.runId)
  return (
    <Box key={`ask:${a.askId}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold color="warning">
            ◆ {a.deputy || 'A run'} asks
          </Text>
          {rung !== '' && <Text dimColor>{rung}</Text>}
        </Box>
        {href !== '' && Link && <Link href={href}>↗ run</Link>}
      </Box>
      {Markdown ? <Markdown key={`q:${a.askId}`} text={question} /> : <Text wrap="wrap">{flat(question)}</Text>}
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
        {a.choices.map((c, i) => (
          <Button
            key={`ans:${a.askId}:${i}`}
            label={cut(c, 40)}
            variant={i === 0 ? 'primary' : 'secondary'}
            onPress={() => sendAnswer($, cell.server, a.askId, c)}
          />
        ))}
        {Input && !isAnswering && (
          <Button
            key={`write:${a.askId}`}
            label={a.choices.length > 0 ? 'Other…' : 'Answer…'}
            variant={a.choices.length > 0 ? 'secondary' : 'primary'}
            onPress={() => startAnswer($, cell.server, a.askId)}
          />
        )}
      </Box>
      {Input && isAnswering && (
        <Input
          key={`in:${a.askId}`}
          label="Your answer"
          placeholder="Type, then Enter"
          submitLabel="Send"
          autoFocus
          onSubmit={value => sendAnswer($, cell.server, a.askId, value)}
        />
      )}
    </Box>
  )
}

function notice(kit: Kit, text: string, color: string) {
  const { Box, Text } = kit
  return (
    <Box key="notice" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} wrap="wrap">
        {text}
      </Text>
    </Box>
  )
}

export async function renderFleet($: EngineInterface, kit: Kit, width: number, problem: string) {
  const { Box, Text, Progress } = kit
  if (problem) return notice(kit, `⚠ ${problem}`, 'warning')
  const fleet = await read($, fleetAtom)
  if (fleet.polledAt === 0) {
    return Progress ? <Progress label="Reading Marshal" /> : <Text dimColor>Reading Marshal…</Text>
  }
  const answering = await read($, answeringAtom)
  const now = await $.clock.now()
  const t = totals(fleet)
  const updated = age(new Date(fleet.polledAt).toISOString(), now)
  const inner = Math.max(20, width - 2)

  return (
    <Box flexDirection="column">
      {header($, kit, fleet.cells[0], t, updated)}
      {fleet.cells.map(cell => (
        <Box key={`cell:${cell.server}`} flexDirection="column">
          {fleet.cells.length > 1 && section(kit, inner, cellName(cell.server), cell.active.length)}
          {cell.error !== '' && notice(kit, `Cannot read ${cell.server}: ${cut(cell.error, 300)}`, 'error')}
          {cell.launchedOnly && cell.error === '' && (
            <Box marginTop={1} paddingX={1}>
              <Text dimColor wrap="wrap">Runs this space launched. Your other runs and what needs you are in /marshal-fleet on your laptop or in the web app.</Text>
            </Box>
          )}
          {!cell.launchedOnly && cell.asks.length === 0 && cell.attention.length === 0 && cell.error === '' && (
            <Box marginTop={1} paddingX={1}>
              <Text color="success">✓ Nothing needs you.</Text>
            </Box>
          )}
          {cell.asks.length > 0 && section(kit, inner, 'Needs you', cell.asks.length, 'warning')}
          {cell.asks.map(a => askCard($, kit, answering, cell, a))}
          {cell.attention.length > 0 && section(kit, inner, 'Failed or parked', cell.attention.length, 'error')}
          {cell.attention.map(r => runRow(kit, now, cell, r))}
          {section(kit, inner, 'Running', cell.active.length)}
          {cell.active.length === 0 && (
            <Box paddingX={1}>
              <Text dimColor>No runs right now.</Text>
            </Box>
          )}
          {cell.active.map(r => runRow(kit, now, cell, r))}
          {cell.recent.length > 0 && section(kit, inner, 'Recently ended', cell.recent.length)}
          {cell.recent.map(r => runRow(kit, now, cell, r))}
        </Box>
      ))}
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>
          r refresh · hover a run for details · every {Math.round(mod.config.pollMs / 1000)}s
        </Text>
      </Box>
    </Box>
  )
}

// The band above the prompt: the first open ask, answerable in place, so a
// question never waits for the pane to be opened. Click only, no digit
// hotkeys: a bare digit in an empty prompt would answer it.
export async function renderAskBand($: EngineInterface, kit: Kit, width: number): Promise<unknown> {
  const { Box, Text, Button } = kit
  const fleet = await read($, fleetAtom)
  const cell = fleet.cells.find(c => c.asks.length > 0)
  const a = cell?.asks[0]
  if (!cell || !a) return undefined
  const more = fleet.cells.reduce((n, c) => n + c.asks.length, 0) - 1
  const lead = `◆ ${a.deputy || 'A run'} asks`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text bold color="warning">
            {lead}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{cut(flat(a.question || '(no question text)'), Math.max(20, width))}</Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap={1} paddingLeft={2}>
        {a.choices.slice(0, 3).map((c, i) => (
          <Button
            key={`band:${a.askId}:${i}`}
            label={cut(c, 24)}
            variant={i === 0 ? 'primary' : 'secondary'}
            onPress={() => sendAnswer($, cell.server, a.askId, c)}
          />
        ))}
        <Text dimColor>{more > 0 ? `+${more} more · ` : ''}details in /marshal-fleet</Text>
      </Box>
    </Box>
  )
}
