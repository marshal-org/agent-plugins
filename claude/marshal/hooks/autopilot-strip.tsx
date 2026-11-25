import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AutopilotEntry, AutopilotUi, AutopilotView } from '../types'
import { EMPTY_FLEET, type Kit } from './atoms'
import { EMPTY_AUTOPILOT } from './autopilot-engine'
import { loadPolicy, savePolicy, type Policy } from './autopilot-policy'
import { age, cut, runUrl } from './fleet-model'

// The Autopilot strip at the top of the fleet pane: "Autopilot is on" with a
// moving indicator and its mode (Shadow, Routine, Cruise), the latest answers and would-answers
// with their rule, what waits on the person, and the keys p pause, s stop,
// e explain, o open run.

const autopilotAtom = atom({ plugin: 'marshal', key: 'autopilot' } as const, EMPTY_AUTOPILOT, { shape: 'autopilot-1' })
const uiAtom = atom({ plugin: 'marshal', key: 'autopilotUi' } as const, { selected: '', explaining: false } as AutopilotUi)
const fleetAtom = atom({ plugin: 'marshal', key: 'fleet' } as const, EMPTY_FLEET, { shape: 'fleet-1' })

export const ON_LABEL = 'Autopilot is on'

// The mode as the person reads it: "Cruise". Empty when there is no policy.
export function modeName(mode: string): string {
  return mode ? mode[0]!.toUpperCase() + mode.slice(1) : ''
}

// Saves the policy, or says why it could not.
async function saved($: EngineInterface, p: Policy): Promise<boolean> {
  try {
    await savePolicy($, p)
    return true
  } catch (err) {
    $.ui.toast(`Autopilot could not save the policy: ${err instanceof Error ? err.message : String(err)}`, { timeoutMs: 8000 })
    return false
  }
}

// p: pause or resume. Written to the policy, so every session of the person
// on this machine pauses, and the next cycle answers nothing.
export async function togglePause($: EngineInterface): Promise<void> {
  const loaded = await loadPolicy($)
  if ('error' in loaded) return
  const paused = !loaded.policy.paused
  if (!(await saved($, { ...loaded.policy, paused }))) return
  const state: AutopilotView['state'] = loaded.policy.enabled ? (paused ? 'paused' : 'on') : 'off'
  await update($, autopilotAtom, v => ({ ...v, state }))
  $.ui.toast(paused ? 'Autopilot paused: it answers nothing until you resume (p).' : 'Autopilot resumed.')
}

// s: stop (off until turned on again, the mode kept), or turn it back on.
export async function toggleStop($: EngineInterface): Promise<void> {
  const loaded = await loadPolicy($)
  if ('error' in loaded) return
  const enabled = !loaded.policy.enabled
  if (!(await saved($, { ...loaded.policy, enabled, paused: false }))) return
  const state: AutopilotView['state'] = enabled ? 'on' : 'off'
  await update($, autopilotAtom, v => ({ ...v, state, reason: enabled ? '' : 'stopped. Press s or ask Claude to turn Marshal Autopilot on.' }))
  $.ui.toast(enabled ? 'Autopilot is on.' : 'Autopilot is off. Press s to turn it on again.')
}

export async function selectEntry($: EngineInterface, askId: string): Promise<void> {
  await update($, uiAtom, u => ({ selected: askId, explaining: u.selected === askId ? u.explaining : false }))
}

function selectedOf(v: AutopilotView, u: AutopilotUi): AutopilotEntry | undefined {
  const all = [...v.recent, ...v.waiting]
  return all.find(e => e.askId === u.selected) ?? all[0]
}

// e: explain the selected entry (or the newest), again to close.
export async function toggleExplain($: EngineInterface): Promise<void> {
  const v = await read($, autopilotAtom)
  const u = await read($, uiAtom)
  const e = selectedOf(v, u)
  if (!e) return
  await update($, uiAtom, x => ({ selected: e.askId, explaining: !(x.explaining && x.selected === e.askId) }))
}

// o: open the selected entry's run in the browser, where this machine has an
// opener; else copy its address.
export async function openSelected($: EngineInterface, surface: 'terminal' | 'desktop' | 'mobile' | 'vscode'): Promise<void> {
  const v = await read($, autopilotAtom)
  const e = selectedOf(v, await read($, uiAtom))
  if (!e) return
  const fleet = await read($, fleetAtom)
  const cell = fleet.cells.find(c => c.server === e.server) ?? fleet.cells[0]
  const href = cell ? runUrl(cell, e.runId) : ''
  if (!href) {
    $.ui.toast(`Run ${e.runId}: no web address is known for this Marshal.`)
    return
  }
  for (const opener of [['xdg-open', href], ['open', href]]) {
    try {
      if ((await $.process.run(opener, { timeoutMs: 5000 })).exitCode === 0) {
        $.ui.toast(`Opened ${href}`)
        return
      }
    } catch {
      // No such opener here: try the next.
    }
  }
  const copied = await $.ui.copy({ text: href, surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? `Copied ${href}` : href, { timeoutMs: 10000 })
}

const LOOK: Record<string, { glyph: string; color?: string; words: string }> = {
  answered: { glyph: '✓', color: 'success', words: 'answered' },
  would_answer: { glyph: '◇', color: 'suggestion', words: 'would answer' },
  notified: { glyph: '◆', color: 'warning', words: 'for you' },
  escalated: { glyph: '◆', color: 'error', words: 'expiring' },
  refused: { glyph: '✕', color: 'error', words: 'refused' },
  answered_elsewhere: { glyph: '–', words: 'answered by you' },
  nudged: { glyph: '↪', color: 'suggestion', words: 'told the run' },
}

function row(kit: Kit, $: EngineInterface, e: AutopilotEntry, isSelected: boolean) {
  const { Button, Text } = kit
  const l = LOOK[e.outcome] ?? LOOK.notified!
  const what =
    e.outcome === 'answered' || e.outcome === 'would_answer'
      ? `"${cut(e.answer, 40)}"${e.ruleId ? ` · ${e.ruleId}` : ''}`
      : e.outcome === 'nudged'
        ? cut(e.question, 70)
        : cut(e.reason || e.question, 70)
  return (
    <Button key={`ap:e:${e.askId}`} plain onPress={() => selectEntry($, e.askId)}>
      {isSelected ? '›' : ' '}
      <Text color={l.color}>{` ${l.glyph} ${l.words}`}</Text>
      {` ${cut(e.runLabel, 30)}: `}
      <Text dimColor>{what}</Text>
    </Button>
  )
}

function explainBox(kit: Kit, e: AutopilotEntry, href: string) {
  const { Box, Text, Link } = kit
  const l = LOOK[e.outcome] ?? LOOK.notified!
  const lines: [string, string][] = [
    ['Outcome', `${l.words}${e.answer ? `: "${e.answer}"` : ''}`],
    ['Rule', e.rule || e.ruleId || '(no rule)'],
    ['Reasoning', e.reasoning || '(none given)'],
    ['Why you', e.reason],
    ['Kind', e.gate],
    ['Mode', e.mode],
    ['Asked', e.asked],
  ]
  return (
    <Box key="ap:explain" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} marginTop={1}>
      <Text bold>Why: {cut(e.runLabel, 60)}</Text>
      {lines
        .filter(([, v]) => v !== '')
        .map(([k, v]) => (
          <Box key={`ap:x:${k}`} flexDirection="row" gap={1}>
            <Box width={10} flexShrink={0}>
              <Text dimColor>{k}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text wrap="wrap">{cut(v, 1500)}</Text>
            </Box>
          </Box>
        ))}
      {href !== '' && (Link ? <Link href={href}>↗ open run</Link> : <Text dimColor>{href}</Text>)}
    </Box>
  )
}

export async function renderStrip($: EngineInterface, kit: Kit, now: number) {
  const { Box, Text, Button, Client } = kit
  const v = await read($, autopilotAtom)
  const u = await read($, uiAtom)
  if (v.state === 'off' && v.reason.startsWith('no policy')) {
    return (
      <Box key="ap" paddingX={1} marginTop={1}>
        <Text dimColor wrap="wrap">
          Autopilot is off: {v.reason}
        </Text>
      </Box>
    )
  }
  const fleet = await read($, fleetAtom)
  const selected = selectedOf(v, u)
  const cell = selected ? (fleet.cells.find(c => c.server === selected.server) ?? fleet.cells[0]) : undefined
  const href = selected && cell ? runUrl(cell, selected.runId) : ''
  const lead =
    v.state === 'on' ? (
      Client ? (
        <Client key="ap:indicator" module="./autopilot-indicator.tsx" props={{ label: ON_LABEL }} />
      ) : (
        <Text bold>
          <Text color="success">◆</Text> {ON_LABEL}
        </Text>
      )
    ) : v.state === 'paused' ? (
      <Text bold color="warning">
        ‖ Autopilot is paused
      </Text>
    ) : (
      <Text bold dimColor>
        ○ Autopilot is off
      </Text>
    )
  const hasPolicy = !(v.state === 'off' && v.reason.startsWith('the policy'))
  const mode = modeName(v.mode)
  return (
    <Box key="ap" flexDirection="column" borderStyle="round" borderColor={v.state === 'on' ? 'success' : v.state === 'paused' ? 'warning' : 'inactive'} paddingX={1} marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          {lead}
          {mode !== '' && (
            <Text key="ap:mode" bold={v.state === 'on'} dimColor={v.state !== 'on'}>
              · {mode}
            </Text>
          )}
        </Box>
        {hasPolicy && (
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {v.state !== 'off' && <Button key="ap:pause" label={v.state === 'paused' ? 'Resume' : 'Pause'} hotkey="p" plain onPress={() => togglePause($)} />}
            <Button key="ap:stop" label={v.state === 'off' ? 'Turn on' : 'Stop'} hotkey="s" plain onPress={() => toggleStop($)} />
          </Box>
        )}
      </Box>
      {v.state === 'off' && v.reason !== '' && (
        <Text dimColor wrap="wrap">
          {v.reason}
        </Text>
      )}
      {v.state !== 'off' && v.reason !== '' && (
        <Text color="warning" wrap="wrap">
          {v.reason}
        </Text>
      )}
      {v.recent.length > 0 && <Text dimColor>LATEST</Text>}
      {v.recent.map(e => row(kit, $, e, e.askId === selected?.askId))}
      {v.waiting.length > 0 && (
        <Text color="warning" bold>
          WAITING ON YOU {v.waiting.length}
        </Text>
      )}
      {v.waiting.map(e => row(kit, $, e, e.askId === selected?.askId))}
      {u.explaining && selected && explainBox(kit, selected, href)}
      {(v.recent.length > 0 || v.waiting.length > 0) && (
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Button key="ap:explain-key" label={u.explaining ? 'Close' : 'Explain'} hotkey="e" plain dimColor onPress={() => toggleExplain($)} />
          <Button key="ap:open" label="Open run" hotkey="o" plain dimColor onPress={() => openSelected($, 'terminal')} />
          {v.policyChangedAt > 0 && <Text dimColor>policy changed {age(new Date(v.policyChangedAt).toISOString(), now)} ago</Text>}
        </Box>
      )}
    </Box>
  )
}
