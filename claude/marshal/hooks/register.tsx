import type { Register } from 'claude-code'

import { FLEET_PANE, INSPECT_PANE, SPACE_SOCKET, type Kit } from './atoms'
import { readConfig } from './config'
import { renderAskBand, renderFleet } from './fleet'
import { renderInspector, renderSpaceBand } from './space'
import { mod, poll } from './state'

function kitOf(t: Kit): Kit {
  return {
    Box: t.Box,
    Text: t.Text,
    Button: t.Button,
    ...(t.Input && { Input: t.Input }),
    ...(t.Link && { Link: t.Link }),
    ...(t.Progress && { Progress: t.Progress }),
    ...(t.Markdown && { Markdown: t.Markdown }),
  }
}

export const NOT_IN_SPACE =
  'The space inspector works only inside a Marshal space: it shows the space it runs in. Open it from Claude Code in a space. On this machine, /marshal-fleet shows your runs.'

export const register: Register = (on, options) => {
  mod.config = readConfig(options)

  on('session.start', async ($, e, next) => {
    mod.cwd = e.cwd
    mod.inSpace = await $.fs
      .stat(SPACE_SOCKET)
      .then(() => true)
      .catch(() => false)
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

  on('ui.render', { component: 'Pane', requestId: 'marshal-fleet' }, async ($, e) =>
    renderFleet($, kitOf($.ui.resolve(e) as Kit), e.props.bodyColumns, mod.problem),
  )

  on('ui.render', { component: 'Pane', requestId: 'marshal-space' }, async ($, e) =>
    renderInspector($, kitOf($.ui.resolve(e) as Kit), e.props.bodyColumns, mod.problem),
  )

  // Above the prompt: an open ask (laptop) or pending requests (in a space),
  // so neither waits for a pane to be opened.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mode = mod.inSpace ? mod.config.space : mod.config.fleet
    if (mode === 'off' || e.props.hasSurvey) return next(e)
    const kit = kitOf($.ui.resolve(e) as Kit)
    const tree = mod.inSpace ? await renderSpaceBand($, kit) : await renderAskBand($, kit, e.props.bodyColumns)
    return tree === undefined ? next(e) : (tree as never)
  })
}
