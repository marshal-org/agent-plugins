import type { EngineInterface } from 'claude-code'

import { marshalServers, pickServer, readConfig, toolsOf, type Config } from './config'
import { serverUrl, webBase } from './fleet-model'
import { pollFleet, type Cell } from './fleet-poll'
import { pollInspector } from './space-poll'

// Module state: rebuilt on every load, which is right (a reload drops the
// timers too). What the panes draw lives in $.state.
export const mod = {
  config: readConfig({}) as Config,
  cell: undefined as Cell | undefined,
  problem: '',
  inSpace: false,
  isPolling: false,
  // A poll asked for while one runs (a tab change, an answer): run once more
  // after it, so the new tab is read instead of staying on "Reading...".
  pollAgain: false,
  cwd: '',
}

export async function findCell($: EngineInterface): Promise<Cell | undefined> {
  const names = (await $.tool.list()).map(t => t.name)
  const server = pickServer(mod.config, marshalServers(names))
  if (!server) {
    mod.problem = mod.config.server
      ? `The Marshal server "${mod.config.server}" is not connected. Check /mcp.`
      : mod.config.url
        ? 'Marshal is not signed in yet. Run /mcp, pick plugin:marshal:marshal and sign in.'
        : 'Marshal is not connected. Set your Marshal MCP address with /plugin configure marshal (Connect an agent in the Marshal web app shows it), or run: claude mcp add --transport http marshal https://<your-marshal>/mcp'
    return undefined
  }
  mod.problem = ''
  // The address the person set is the web app's too; else the MCP config's.
  let webUrl = webBase(mod.config.url)
  if (!webUrl) {
    try {
      const home = await $.env.get('HOME')
      if (home) webUrl = webBase(serverUrl(JSON.parse(await $.fs.read(`${home}/.claude.json`)), server, mod.cwd))
    } catch {
      // Links are a convenience; the board works without them.
    }
  }
  const tools = toolsOf(server, names)
  return { server, webUrl, hasPrs: tools.has('runs_prs'), hasSpaceReads: tools.has('spaces_usage') && tools.has('spaces_changes') }
}

export async function poll($: EngineInterface): Promise<void> {
  if (mod.isPolling) {
    mod.pollAgain = true
    return
  }
  mod.isPolling = true
  try {
    do {
      mod.pollAgain = false
      try {
        mod.cell = mod.cell ?? (await findCell($))
        if (!mod.cell) {
          $.ui.status(undefined)
          return
        }
        if (mod.inSpace) await pollInspector($, mod.cell.server, mod.cell.hasSpaceReads === true)
        else await pollFleet($, [mod.cell], mod.config.notify)
        mod.problem = ''
      } catch (err) {
        mod.problem = err instanceof Error ? err.message : String(err)
        $.ui.status(undefined)
      }
    } while (mod.pollAgain)
  } finally {
    mod.isPolling = false
  }
}
