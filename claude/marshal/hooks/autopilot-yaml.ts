// The small part of YAML the Autopilot files use: block mappings, block
// sequences (of scalars and of mappings), quoted and plain scalars, empty
// flow collections and flow lists of scalars, comments. A hooks module has no
// npm packages, so this is the plugin's own. stringify writes only what parse
// reads back to the same value.

export type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml }

export class YamlError extends Error {}

type Line = { indent: number; text: string; no: number }

function stripComment(raw: string): string {
  let quote = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) return raw.slice(0, i)
  }
  return raw
}

function lines(text: string): Line[] {
  const out: Line[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.includes('\t') && /^\s*\t/.test(raw)) throw new YamlError(`line ${i + 1}: use spaces, not tabs, to indent`)
    const body = stripComment(raw).replace(/\s+$/, '')
    if (body.trim() === '' || body.trim() === '---') return
    out.push({ indent: body.length - body.trimStart().length, text: body.trim(), no: i + 1 })
  })
  return out
}

function splitFlow(inner: string, no: number): string[] {
  const parts: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"') cur += inner[++i] ?? ''
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === ',') {
      parts.push(cur.trim())
      cur = ''
    } else if (c === '[' || c === '{') throw new YamlError(`line ${no}: nested flow collections are not supported`)
    else cur += c
  }
  if (cur.trim() !== '') parts.push(cur.trim())
  return parts
}

function scalar(s: string, no: number): Yaml {
  const t = s.trim()
  if (t === '' || t === '~' || t === 'null') return null
  if (t === '[]') return []
  if (t === '{}') return {}
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new YamlError(`line ${no}: a list that opens with [ must close with ]`)
    return splitFlow(t.slice(1, -1), no).map(p => scalar(p, no))
  }
  if (t.startsWith('{')) throw new YamlError(`line ${no}: write a mapping as indented lines, not {...}`)
  if (t.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(t)
      if (typeof v === 'string') return v
    } catch {
      // fall through
    }
    throw new YamlError(`line ${no}: a double-quoted string is not closed`)
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new YamlError(`line ${no}: a single-quoted string is not closed`)
    return t.slice(1, -1).replace(/''/g, "'")
  }
  if (t === 'true' || t === 'yes') return true
  if (t === 'false' || t === 'no') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t.startsWith('|') || t.startsWith('>')) throw new YamlError(`line ${no}: block strings (| or >) are not supported; use a quoted string`)
  return t
}

// "key: value" → [key, value]; the key may be quoted.
function keyValue(text: string, no: number): [string, string] | undefined {
  let key: string
  let rest: string
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = text[0]!
    let i = 1
    while (i < text.length && text[i] !== q) i += text[i] === '\\' && q === '"' ? 2 : 1
    if (i >= text.length) throw new YamlError(`line ${no}: a quoted key is not closed`)
    key = String(scalar(text.slice(0, i + 1), no))
    rest = text.slice(i + 1).trimStart()
    if (!rest.startsWith(':')) return undefined
    rest = rest.slice(1)
  } else {
    const m = /^([^:]+?):(\s+|$)(.*)$/.exec(text)
    if (!m) return undefined
    key = m[1]!.trim()
    rest = m[3] ?? ''
  }
  return [key, rest.trim()]
}

function parseBlock(ls: Line[], start: number, indent: number): [Yaml, number] {
  const first = ls[start]
  if (!first) return [null, start]
  if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(ls, start, indent)
  return parseMap(ls, start, indent)
}

function parseSeq(ls: Line[], start: number, indent: number): [Yaml[], number] {
  const out: Yaml[] = []
  let i = start
  while (i < ls.length) {
    const l = ls[i]!
    if (l.indent < indent) break
    if (l.indent > indent) throw new YamlError(`line ${l.no}: unexpected indent`)
    if (!(l.text === '-' || l.text.startsWith('- '))) break
    const item = l.text === '-' ? '' : l.text.slice(2).trim()
    if (item === '') {
      const next = ls[i + 1]
      if (next && next.indent > indent) {
        const [v, j] = parseBlock(ls, i + 1, next.indent)
        out.push(v)
        i = j
      } else {
        out.push(null)
        i++
      }
      continue
    }
    const kv = item.startsWith('[') ? undefined : keyValue(item, l.no)
    if (kv) {
      // A mapping that starts on the dash line: its keys sit two columns in.
      const inner = indent + 2
      const synthetic: Line[] = [{ indent: inner, text: item, no: l.no }]
      let j = i + 1
      while (j < ls.length && ls[j]!.indent >= inner) synthetic.push(ls[j++]!)
      const [v] = parseMap(synthetic, 0, inner)
      out.push(v)
      i = j
      continue
    }
    out.push(scalar(item, l.no))
    i++
  }
  return [out, i]
}

function parseMap(ls: Line[], start: number, indent: number): [{ [k: string]: Yaml }, number] {
  const out: { [k: string]: Yaml } = {}
  let i = start
  while (i < ls.length) {
    const l = ls[i]!
    if (l.indent < indent) break
    if (l.indent > indent) throw new YamlError(`line ${l.no}: unexpected indent`)
    if (l.text.startsWith('- ')) throw new YamlError(`line ${l.no}: a list item where a key was expected`)
    const kv = keyValue(l.text, l.no)
    if (!kv) throw new YamlError(`line ${l.no}: expected "key: value"`)
    const [key, rest] = kv
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`line ${l.no}: "${key}" appears twice`)
    if (rest !== '') {
      out[key] = scalar(rest, l.no)
      i++
      continue
    }
    const next = ls[i + 1]
    // A list may sit at the same indent as its key (a common YAML style).
    if (next && (next.indent > indent || (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))))) {
      const [v, j] = parseBlock(ls, i + 1, next.indent)
      out[key] = v
      i = j
    } else {
      out[key] = null
      i++
    }
  }
  return [out, i]
}

export function parseYaml(text: string): Yaml {
  const ls = lines(text)
  if (ls.length === 0) return null
  const [v, end] = parseBlock(ls, 0, ls[0]!.indent)
  if (end < ls.length) throw new YamlError(`line ${ls[end]!.no}: unexpected content`)
  return v
}

const PLAIN = /^[A-Za-z0-9_./@*-][A-Za-z0-9 _./@*()+-]*$/
const RESERVED = new Set(['true', 'false', 'yes', 'no', 'null', '~'])

function scalarText(v: Yaml): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  if (PLAIN.test(s) && !RESERVED.has(s) && !/^-?\d+(\.\d+)?$/.test(s) && !s.endsWith(' ') && !s.startsWith('- ')) return s
  return JSON.stringify(s)
}

function keyText(k: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(k) ? k : JSON.stringify(k)
}

function isScalar(v: Yaml): boolean {
  return v === null || typeof v !== 'object'
}

function emit(v: Yaml, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent)
  if (Array.isArray(v)) {
    for (const item of v) {
      if (isScalar(item)) out.push(`${pad}- ${scalarText(item)}`)
      else if (Array.isArray(item)) {
        out.push(`${pad}-`)
        emit(item, indent + 2, out)
      } else {
        const sub: string[] = []
        emit(item, indent + 2, sub)
        if (sub.length === 0) out.push(`${pad}- {}`)
        else out.push(`${pad}- ${sub[0]!.slice(indent + 2)}`, ...sub.slice(1))
      }
    }
    return
  }
  if (v !== null && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue
      if (isScalar(val)) out.push(`${pad}${keyText(k)}: ${scalarText(val)}`)
      else if (Array.isArray(val) && val.length === 0) out.push(`${pad}${keyText(k)}: []`)
      else if (!Array.isArray(val) && Object.keys(val as object).length === 0) out.push(`${pad}${keyText(k)}: {}`)
      else {
        out.push(`${pad}${keyText(k)}:`)
        emit(val, indent + 2, out)
      }
    }
  }
}

export function stringifyYaml(v: Yaml, header = ''): string {
  const out: string[] = header ? header.split('\n').map(l => (l ? `# ${l}` : '#')) : []
  emit(v, 0, out)
  return out.join('\n') + '\n'
}
