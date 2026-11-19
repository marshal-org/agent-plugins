import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { InspectorTab } from '../types'
import { EMPTY_INSPECTOR } from './atoms'
import { resultJson } from './fleet-model'
import { format, pendingCount, tabSpec, type TabId } from './space-model'

const inspectorAtom = atom({ plugin: 'marshal', key: 'inspector' } as const, EMPTY_INSPECTOR, { shape: 'inspector-1' })
const tabAtom = atom({ plugin: 'marshal', key: 'tab' } as const, 'overview')

export async function readTab($: EngineInterface, server: string, id: TabId, spaceReads = false): Promise<InspectorTab> {
  const spec = tabSpec(id, spaceReads)
  const now = await $.clock.now()
  try {
    const result = await $.mcp.call(server, spec.tool, spec.args)
    return { lines: format(id, resultJson(result), now), error: '', readAt: now }
  } catch (err) {
    return { lines: [], error: err instanceof Error ? err.message : String(err), readAt: now }
  }
}

// Read the overview, the requests (the status line counts pending ones), and
// the open tab. Other tabs are read when opened.
export async function pollInspector($: EngineInterface, server: string, spaceReads = false): Promise<void> {
  const open = tabSpec(await read($, tabAtom)).id
  const wanted = Array.from(new Set<TabId>(['overview', 'requests', open]))
  const fresh = await Promise.all(wanted.map(async id => [id, await readTab($, server, id, spaceReads)] as const))
  // Every tab refused: this server does not serve the space's own tools.
  const allFailed = fresh.every(([, t]) => t.error !== '')
  const firstError = fresh[0]?.[1].error ?? 'no answer'
  await update($, inspectorAtom, prev => {
    const tabs = { ...prev.tabs }
    for (const [id, tab] of fresh) tabs[id] = tab
    return {
      spaceId: prev.spaceId,
      problem: allFailed
        ? `This Marshal server does not serve this space's own data: ${firstError}. The space needs the marshal-orchestration package with the self scope.`
        : '',
      tabs,
    }
  })
  const state = await read($, inspectorAtom)
  if (state.problem) {
    $.ui.status(undefined)
    return
  }
  const pending = pendingCount(state.tabs.requests?.lines ?? [])
  const title = state.tabs.overview?.lines[0]?.text ?? 'space'
  $.ui.status(`${title}${pending > 0 ? ` · ◆ ${pending} request${pending > 1 ? 's' : ''} pending` : ''}`)
}
