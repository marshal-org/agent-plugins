import type { EngineInterface } from 'claude-code'

// Where Autopilot keeps its files, and how it writes them. Claude Code gives
// each plugin a data folder, <config>/plugins/data/<plugin id> (the folder
// command hooks see as CLAUDE_PLUGIN_DATA); a hooks module is not told its
// id, so it is read from where the plugin was installed from, and is
// marshal@marshal (this plugin's marketplace) otherwise.
//
// $.fs writes neither a file mode nor an append, so private writes go through
// sh with umask 077 (files 0600, folders 0700). Only where sh cannot start
// (no POSIX shell) does $.fs write the file as the OS creates it. A sh that
// started and failed is a failed write: it throws, and nothing is written
// with the default mode (nor appended a second time).

// sh -c SCRIPT NAME PATH: NAME is $0, so the path is $1.
export const SH_WRITE = 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1.tmp" && mv -f "$1.tmp" "$1" && chmod 600 "$1"'
export const SH_APPEND = 'umask 077 && mkdir -p "$(dirname "$1")" && cat >> "$1" && chmod 600 "$1"'
export const SH_REMOVE = 'rm -f "$1"'

export function pluginIdFromRoot(root: string): string {
  const m = /\/plugins\/cache\/([^/]+)\/([^/]+)\//.exec(root.replace(/\\/g, '/') + '/')
  const id = m ? `${m[2]}@${m[1]}` : 'marshal@marshal'
  return id.replace(/[^a-zA-Z0-9\-_]/g, '-')
}

let cachedDir = ''

export async function dataDir($: EngineInterface): Promise<string> {
  if (cachedDir) return cachedDir
  const given = await $.env.get('CLAUDE_PLUGIN_DATA')
  if (given) {
    cachedDir = `${given.replace(/\/$/, '')}/autopilot`
    return cachedDir
  }
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  cachedDir = `${config.replace(/\/$/, '')}/plugins/data/${pluginIdFromRoot($.plugin.root)}/autopilot`
  return cachedDir
}

// For tests: a new data folder per world.
export function resetDataDir(): void {
  cachedDir = ''
}

export class WriteError extends Error {}

// 'ok', 'nostart' (sh could not start: $.process.run rejected), or why sh
// failed.
async function sh($: EngineInterface, op: string, script: string, path: string, stdin?: string): Promise<'ok' | 'nostart' | { failed: string }> {
  let r
  try {
    r = await $.process.run(['sh', '-c', script, op, path], { stdin: stdin ?? '', timeoutMs: 10_000 })
  } catch {
    return 'nostart'
  }
  if (r.exitCode === 0) return 'ok'
  return { failed: (r.stderr.trim().split('\n')[0] ?? '') || `sh exited ${r.exitCode}` }
}

export async function writePrivate($: EngineInterface, path: string, text: string): Promise<void> {
  const r = await sh($, 'autopilot-write', SH_WRITE, path, text)
  if (r === 'ok') return
  if (r !== 'nostart') throw new WriteError(`could not write ${path}: ${r.failed}`)
  await $.fs.write(path, text)
}

export async function appendPrivate($: EngineInterface, path: string, line: string): Promise<void> {
  const text = line.endsWith('\n') ? line : `${line}\n`
  const r = await sh($, 'autopilot-append', SH_APPEND, path, text)
  if (r === 'ok') return
  if (r !== 'nostart') throw new WriteError(`could not append to ${path}: ${r.failed}`)
  const before = await $.fs.read(path).catch(() => '')
  await $.fs.write(path, before + text)
}

export async function removeFile($: EngineInterface, path: string): Promise<void> {
  const r = await sh($, 'autopilot-remove', SH_REMOVE, path)
  if (r === 'ok') return
  if (r !== 'nostart') throw new WriteError(`could not remove ${path}: ${r.failed}`)
  // Without a shell an emptied file stands in: readers skip empty files.
  if (await $.fs.exists(path).catch(() => false)) await $.fs.write(path, '')
}

export async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

export async function mtimeOf($: EngineInterface, path: string): Promise<number | undefined> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return undefined
  }
}
