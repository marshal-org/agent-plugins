import type { EngineInterface } from 'claude-code'

// The plugin's own version, and the newest one customers can install, so the
// panes and the status line say which plugin is running and when a newer one
// is out. The newest is the public main lane's plugin.json: what
// `/plugin` installs. A cell's dev or staging lane may run ahead of it; that
// is never an update.
export const LATEST_URL = 'https://raw.githubusercontent.com/marshal-org/agent-plugins/main/claude/marshal/.claude-plugin/plugin.json'
// How often the newest version is read again. One small public file.
export const LATEST_EVERY_MS = 6 * 60 * 60 * 1000

export type Versions = { current: string; latest: string }

export const versions: Versions = { current: '', latest: '' }

function versionOf(json: string): string {
  try {
    const v = (JSON.parse(json) as { version?: unknown }).version
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : ''
  } catch {
    return ''
  }
}

export async function readCurrent($: EngineInterface): Promise<string> {
  try {
    versions.current = versionOf(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
  } catch {
    // No version is shown rather than a wrong one.
  }
  return versions.current
}

// Offline, or a network policy that refuses GitHub: no notice, nothing else.
export async function readLatest($: EngineInterface): Promise<string> {
  try {
    const r = await $.http.fetch(LATEST_URL)
    if (r.ok) versions.latest = versionOf(r.text)
  } catch {
    // Kept from the last read, if any.
  }
  return versions.latest
}

function parts(v: string): number[] {
  return v.split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0)
}

// Whether `b` is a newer release than `a`.
export function isNewer(a: string, b: string): boolean {
  if (!a || !b) return false
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) if (y[i] !== x[i]) return (y[i] ?? 0) > (x[i] ?? 0)
  return false
}

// "v0.5.0", or "" when the version could not be read.
export function versionLabel(v: Versions = versions): string {
  return v.current ? `v${v.current}` : ''
}

// "0.5.1 available", or "" when this plugin is the newest (or unknown).
export function updateLabel(v: Versions = versions): string {
  return isNewer(v.current, v.latest) ? `${v.latest} available` : ''
}
