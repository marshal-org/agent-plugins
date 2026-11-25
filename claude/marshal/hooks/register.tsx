import type { EngineInterface, Register } from 'claude-code'

import { FLEET_PANE, INSPECT_PANE, SPACE_SOCKET, type Kit } from './atoms'
import { ap } from './autopilot-engine'
import { runTool, TOOL_SPECS } from './autopilot-tools'
import { readConfig } from './config'
import { terminalLinks } from './links'
import { renderAskBand, renderFleet } from './fleet'
import { fleetRuns } from './fleet-poll'
import { renderInspector, renderSpaceBand } from './space'
import { mod, poll } from './state'

// A terminal Claude Code draws no links in gets no Link: see links.ts.
function kitOf(t: Kit, surface: string): Kit {
  return {
    Box: t.Box,
    Text: t.Text,
    Button: t.Button,
    ...(t.Input && { Input: t.Input }),
    ...(t.Link && (surface !== 'terminal' || mod.links) && { Link: t.Link }),
    ...(t.Progress && { Progress: t.Progress }),
    ...(t.Markdown && { Markdown: t.Markdown }),
    ...(t.Client && { Client: t.Client }),
  }
}

// The Autopilot skill's tools: read and write the policy, the overlay and
// the journal through the plugin's own policy module.
async function autopilotTool($: EngineInterface, name: string, e: Record<string, unknown>) {
  const { tool: _tool, tool_use_id: _id, ...args } = e
  try {
    const result = await runTool($, name, args, { server: mod.cell?.server ?? '', activeRunIds: () => fleetRuns($) })
    // A registered tool's result is what an MCP tool returns: text or
    // content blocks, never an object (core refuses one). JSON text it is.
    return { result: JSON.stringify(result, null, 2) as never }
  } catch (err) {
    return { deny: `${TOOL_FAILED} ${err instanceof Error ? err.message : String(err)}` }
  }
}

const TOOL_FAILED = 'Marshal Autopilot could not run this tool. Nothing was changed.'

export const NOT_IN_SPACE =
  'The space inspector works only inside a Marshal space: it shows the space it runs in. Open it from Claude Code in a space. On this machine, /marshal-fleet shows your runs.'

export const register: Register = (on, options) => {
  mod.config = readConfig(options)

  on('session.start', async ($, e, next) => {
    mod.cwd = e.cwd
    mod.links = await terminalLinks($)
    mod.inSpace = await $.fs
      .stat(SPACE_SOCKET)
      .then(() => true)
      .catch(() => false)
    ap.spaceHosted = mod.inSpace
    ap.pollMs = mod.config.pollMs
    // Autopilot's tools exist wherever the hooks run; the skill calls them.
    for (const spec of TOOL_SPECS) {
      await $.tool.register({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema as Record<string, unknown> }).catch(() => undefined)
    }
    const mode = mod.inSpace ? mod.config.space : mod.config.fleet
    if (mod.config.space === 'off' && mod.config.fleet === 'off') return next(e)

    // Both commands exist everywhere, so neither is ever "unknown": the
    // inspector explains itself on a laptop, and the fleet pane works inside
    // a space too (through the space's own Marshal server).
    if (mod.config.space !== 'off') {
      await $.command.register({ name: 'marshal-space', description: 'Show this Marshal space: audit, requests, ports, changes, cost (inside a space)' })
    }
    if (mod.config.fleet !== 'off') {
      await $.command.register({ name: 'marshal-fleet', description: 'Show your Marshal runs and what needs you, in a pane' })
    }
    // Polling runs only where a pane can show data: on a laptop the fleet; in
    // a space the inspector, or the fleet once /marshal-fleet opened it.
    const reads = mod.inSpace ? mode !== 'off' || mod.config.fleet !== 'off' : mode !== 'off'
    if (!reads) return next(e)
    $.clock.every(mod.config.pollMs, () => void poll($))
    // MCP servers connect after the session starts: the first poll waits a little.
    $.clock.after(3000, () => void poll($))
    if (mode === 'auto') {
      void $.ui.open(mod.inSpace ? { id: INSPECT_PANE, title: 'Marshal space' } : { id: FLEET_PANE, title: 'Marshal fleet' })
    }
    return next(e)
  })

  on('command.run', { command: 'marshal-fleet' }, async $ => {
    mod.fleetOpened = true
    const opened = await $.ui.open({ id: FLEET_PANE, title: mod.inSpace ? 'Runs this space launched' : 'Marshal fleet' })
    void poll($)
    return { text: opened.isPlaced ? 'Marshal fleet pane opened.' : `The Marshal fleet pane is waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'marshal-space' }, async $ => {
    if (!mod.inSpace) return { text: NOT_IN_SPACE }
    const opened = await $.ui.open({ id: INSPECT_PANE, title: 'Marshal space' })
    void poll($)
    return { text: opened.isPlaced ? 'Marshal space inspector opened.' : `The inspector is waiting: ${opened.reason}` }
  })

  // One hook per Autopilot tool. Some tsc runs give up on the engine's
  // tool.call overloads here (TS2589, "excessively deep") and some do not, so
  // this is @ts-ignore, not @ts-expect-error (which fails where tsc copes).
  for (const spec of TOOL_SPECS) {
    // @ts-ignore TS2589: the tool.call overloads can be too deep for tsc.
    on('tool.call', { tool: `mcp__marshal__${spec.name}` }, async ($: EngineInterface, e: unknown) => autopilotTool($, spec.name, e as never)).catch(() => ({ deny: TOOL_FAILED }))
  }

  on('ui.render', { component: 'Pane', requestId: 'marshal-fleet' }, async ($, e) =>
    renderFleet($, kitOf($.ui.resolve(e) as Kit, e.surface), e.props.bodyColumns, mod.problem),
  )

  on('ui.render', { component: 'Pane', requestId: 'marshal-space' }, async ($, e) =>
    renderInspector($, kitOf($.ui.resolve(e) as Kit, e.surface), e.props.bodyColumns, mod.problem),
  )

  // Above the prompt: an open ask (laptop) or pending requests (in a space),
  // so neither waits for a pane to be opened.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mode = mod.inSpace ? mod.config.space : mod.config.fleet
    if (mode === 'off' || e.props.hasSurvey) return next(e)
    const kit = kitOf($.ui.resolve(e) as Kit, e.surface)
    const tree = mod.inSpace ? await renderSpaceBand($, kit) : await renderAskBand($, kit, e.props.bodyColumns)
    return tree === undefined ? next(e) : (tree as never)
  })
}
