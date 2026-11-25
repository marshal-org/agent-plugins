import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { InspectorLine } from '../types'
import { EMPTY_INSPECTOR, type Kit } from './atoms'
import { age, cut } from './fleet-model'
import { pendingCount, TABS, tabSpec, type TabId } from './space-model'
import { poll } from './state'
import { pluginVersion } from './version-view'

const inspectorAtom = atom({ plugin: 'marshal', key: 'inspector' } as const, EMPTY_INSPECTOR, { shape: 'inspector-1' })
const tabAtom = atom({ plugin: 'marshal', key: 'tab' } as const, 'overview')

export async function chooseTab($: EngineInterface, id: TabId): Promise<void> {
  await update($, tabAtom, () => id)
  await poll($)
}

const TONE: Record<InspectorLine['tone'], { glyph: string; color: string | undefined; isDim: boolean }> = {
  '': { glyph: '·', color: undefined, isDim: false },
  dim: { glyph: '·', color: undefined, isDim: true },
  error: { glyph: '✕', color: 'error', isDim: false },
  warning: { glyph: '◆', color: 'warning', isDim: false },
  success: { glyph: '✓', color: 'success', isDim: false },
}

function stateColor(state: string): string | undefined {
  if (state === 'running' || state === 'ready') return 'success'
  if (state === 'error' || state === 'failed') return 'error'
  if (state === 'stopped' || state === 'archived') return undefined
  return 'warning'
}

// A bar of Boxes: the filled part in the accent color, the rest dim.
function bar(kit: Kit, key: string, share: number, width: number) {
  const { Box, Text } = kit
  const full = Math.max(share > 0 ? 1 : 0, Math.round(Math.min(1, Math.max(0, share)) * width))
  return (
    <Box key={key} flexDirection="row">
      <Text color="suggestion">{'█'.repeat(full)}</Text>
      <Text dimColor>{'░'.repeat(width - full)}</Text>
    </Box>
  )
}

function row(kit: Kit, width: number, l: InspectorLine, i: number) {
  const { Box, Text, Link } = kit
  const t = TONE[l.tone] ?? TONE['']
  if (l.key !== undefined) {
    const keyWidth = 16
    return (
      <Box key={`row:${i}`} flexDirection="row" gap={1} paddingX={1}>
        <Box width={keyWidth} flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {l.key}
          </Text>
        </Box>
        {l.bar !== undefined && bar(kit, `bar:${i}`, l.bar, Math.max(6, Math.min(24, width - keyWidth - 14)))}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end" bold={l.key === 'total'}>
            {l.text}
          </Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box key={`row:${i}`} flexDirection="row" gap={1} paddingX={1}>
      <Text color={t.color} dimColor={t.isDim}>
        {t.glyph}
      </Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={t.color} dimColor={t.isDim} wrap="truncate-end">
          {l.href !== '' && Link ? <Link href={l.href}>{l.text}</Link> : l.text}
        </Text>
      </Box>
    </Box>
  )
}

export async function renderInspector($: EngineInterface, kit: Kit, width: number, problem: string) {
  const { Box, Text, Button, Progress } = kit
  const state = await read($, inspectorAtom)
  const open = tabSpec(await read($, tabAtom)).id
  const why = problem || state.problem
  if (why) {
    return (
      <Box borderStyle="round" borderColor="warning" paddingX={1}>
        <Text color="warning" wrap="wrap">
          ⚠ {why}
        </Text>
      </Box>
    )
  }
  const tab = state.tabs[open]
  const now = await $.clock.now()
  // The overview's first line is "<name> · <state>".
  const first = state.tabs.overview?.lines[0]
  const title = first && first.key === undefined ? first.text : ''
  const [name = 'this space', spaceState = ''] = (title || 'this space').split(' · ')
  const pending = pendingCount(state.tabs.requests?.lines ?? [])
  const lines = open === 'overview' && title ? (tab?.lines ?? []).slice(1) : (tab?.lines ?? [])

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Text bold color="suggestion">
              ◆ Marshal
            </Text>
            <Text bold>{cut(name, Math.max(10, width - 30))}</Text>
            {spaceState !== '' && <Text color={stateColor(spaceState)}>● {spaceState}</Text>}
            {pluginVersion(kit)}
          </Box>
          <Button key="refresh" label="↻ Refresh" plain hotkey="r" dimColor onPress={() => poll($)} />
        </Box>
        <Box flexDirection="row" gap={3}>
          <Text color={pending > 0 ? 'warning' : undefined} dimColor={pending === 0} bold={pending > 0}>
            ◆ {pending} request{pending === 1 ? '' : 's'} pending
          </Text>
          {tab && tab.readAt > 0 && <Text dimColor>updated {age(new Date(tab.readAt).toISOString(), now)} ago</Text>}
        </Box>
      </Box>

      <Box flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1} paddingX={1}>
        {TABS.map((t, i) =>
          t.id === open ? (
            <Button key={`tab:${t.id}`} label={t.label} variant="primary" hotkey={String(i + 1)} onPress={() => chooseTab($, t.id)} />
          ) : (
            <Button key={`tab:${t.id}`} label={t.label} plain dimColor hotkey={String(i + 1)} onPress={() => chooseTab($, t.id)} />
          ),
        )}
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(10, width - 1))}</Text>

      {!tab && (Progress ? <Progress label={`Reading ${tabSpec(open).label.toLowerCase()}`} /> : <Text dimColor>Reading…</Text>)}
      {tab && tab.error !== '' && /has no run/.test(tab.error) && (
        <Box paddingX={1}>
          <Text dimColor>This space has no run, so there is nothing to show here.</Text>
        </Box>
      )}
      {tab && tab.error !== '' && !/has no run/.test(tab.error) && (
        <Box paddingX={1}>
          <Text color="error" wrap="wrap">
            ✕ Cannot read this tab: {tab.error}
          </Text>
        </Box>
      )}
      {tab && tab.error === '' && lines.map((l, i) => row(kit, width, l, i))}

      <Box marginTop={1} paddingX={1}>
        <Text dimColor wrap="wrap">
          1-7 tabs · r refresh · read only: approvals stay in the Marshal web app
        </Text>
      </Box>
    </Box>
  )
}

// The band above the prompt inside a space: requests waiting on a person.
// It only tells; approving stays in the web app.
export async function renderSpaceBand($: EngineInterface, kit: Kit): Promise<unknown> {
  const { Box, Text } = kit
  const state = await read($, inspectorAtom)
  const pending = pendingCount(state.tabs.requests?.lines ?? [])
  if (pending === 0) return undefined
  return (
    <Box flexDirection="row" gap={1}>
      <Text bold color="warning">
        ◆ {pending} request{pending === 1 ? '' : 's'} waiting for approval in the Marshal web app
      </Text>
      <Text dimColor>/marshal-space</Text>
    </Box>
  )
}
