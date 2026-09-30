import { h } from './dom'

/**
 * Colours the code in a ``` block: keywords, strings, numbers, comments, names of functions
 * and types. Builds spans with text, never HTML, so code somebody sends cannot become markup.
 * The language comes from the fence (```ts); with none, it is guessed from the code.
 */

type Family = 'c' | 'hash' | 'sql' | 'json' | 'markup' | 'css'

/** Past this much code, the block stays plain: colour is not worth the time on a paste that big. */
const MOST_CHARS = 40_000

const FAMILIES: Record<string, Family> = {}
for (const [family, names] of [
  ['c', 'js javascript jsx mjs cjs ts typescript tsx java c h cpp c++ cc hpp cs csharp go golang rust rs swift kotlin kt kts php dart scala groovy zig solidity sol glsl hlsl'],
  ['hash', 'py python rb ruby sh bash zsh fish shell console shellscript yaml yml toml ini conf dockerfile docker makefile make r perl pl elixir ex exs nim coffee powershell ps1 nix'],
  ['sql', 'sql mysql postgres postgresql psql sqlite plsql tsql lua hs haskell'],
  ['json', 'json jsonc json5 geojson'],
  ['markup', 'html htm xml svg xhtml vue svelte astro plist'],
  ['css', 'css scss sass less postcss'],
] as const) {
  for (const name of names.split(' ')) FAMILIES[name] = family
}

const words = (list: string): Set<string> => new Set(list.split(/\s+/))

const KEYWORDS: Record<Family, Set<string>> = {
  c: words(`abstract as async await break case catch class const continue debugger default defer delete do else
    enum export extends final finally fn for func from function get go goto if impl implements import in
    instanceof interface internal let loop match mod module move mut namespace new of override package private
    protected pub public readonly ref return satisfies sealed select set static struct super switch this throw
    throws trait try type typeof unsafe use using var virtual void where while with yield chan map range
    fun val when object data companion lateinit guard extension protocol init deinit self Self crate dyn
    int char float double long short unsigned signed bool boolean byte string str u8 u16 u32 u64 i8 i16 i32 i64
    number any unknown never symbol bigint usize isize f32 f64 auto template typename include define ifdef ifndef endif pragma declare keyof infer is`),
  hash: words(`and as assert async await break case class continue def del do done elif else end ensure esac except
    exec fi finally for from function global if import in is lambda local module nonlocal not or pass raise
    rescue retry return self then unless until when while with yield begin echo export alias source readonly
    let declare set unset shift trap cd sudo`),
  sql: words(`add all alter and any as asc between by case cascade check column constraint create cross database
    default delete desc distinct drop else end exists foreign from full group having if in index inner insert
    into is join key left like limit not null offset on or order outer primary references returning right
    select set table then to truncate union unique update using values view when where with begin commit
    rollback transaction function returns language local elseif repeat until`),
  json: words(''),
  markup: words(''),
  css: words(`important media import supports keyframes font-face layer container from to and not only screen`),
}

const LITERALS = words(`true false null undefined nil None True False NaN Infinity nullptr NULL TRUE FALSE yes no on off`)

/** One kind of piece, and the class that colours it. */
type Kind = 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'lit' | 'tag' | 'attr' | 'prop' | 'meta'

interface Rule {
  re: RegExp
  kind: Kind
}

const sticky = (source: string, flags = ''): RegExp => new RegExp(source, `y${flags}`)

const NUMBER: Rule = {
  re: sticky(String.raw`(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)[a-zA-Z%]*`),
  kind: 'num',
}
const DOUBLE: Rule = { re: sticky(String.raw`"(?:\\.|[^"\\\n])*"`), kind: 'str' }
const SINGLE: Rule = { re: sticky(String.raw`'(?:\\.|[^'\\\n])*'`), kind: 'str' }
const BLOCK_COMMENT: Rule = { re: sticky(String.raw`\/\*[\s\S]*?(?:\*\/|$)`), kind: 'com' }

const RULES: Record<Family, Rule[]> = {
  c: [
    { re: sticky(String.raw`\/\/[^\n]*`), kind: 'com' },
    BLOCK_COMMENT,
    { re: sticky(String.raw`^[ \t]*#[ \t]*[a-z]+`, 'm'), kind: 'meta' },
    { re: sticky(String.raw`@[A-Za-z_][\w.]*`), kind: 'meta' },
    { re: sticky(String.raw`\`(?:\\[\s\S]|[^\`\\])*\``), kind: 'str' },
    DOUBLE,
    SINGLE,
    NUMBER,
  ],
  hash: [
    { re: sticky(String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)`), kind: 'str' },
    { re: sticky(String.raw`#[^\n]*`), kind: 'com' },
    { re: sticky(String.raw`@[A-Za-z_][\w.]*`), kind: 'meta' },
    { re: sticky(String.raw`\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9#?@*$!-]`), kind: 'lit' },
    DOUBLE,
    SINGLE,
    NUMBER,
  ],
  sql: [{ re: sticky(String.raw`--[^\n]*`), kind: 'com' }, BLOCK_COMMENT, DOUBLE, SINGLE, NUMBER],
  json: [
    { re: sticky(String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`), kind: 'prop' },
    DOUBLE,
    { re: sticky(String.raw`\/\/[^\n]*`), kind: 'com' },
    BLOCK_COMMENT,
    { re: sticky(String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`), kind: 'num' },
  ],
  markup: [
    { re: sticky(String.raw`<!--[\s\S]*?(?:-->|$)`), kind: 'com' },
    { re: sticky(String.raw`<!\w+|<\/?[A-Za-z][\w:.-]*|\/?>`), kind: 'tag' },
    { re: sticky(String.raw`[A-Za-z_:@][\w:.-]*(?==)`), kind: 'attr' },
    { re: sticky(String.raw`&[#\w]+;`), kind: 'lit' },
    DOUBLE,
    SINGLE,
  ],
  css: [
    BLOCK_COMMENT,
    { re: sticky(String.raw`\/\/[^\n]*`), kind: 'com' },
    { re: sticky(String.raw`@[\w-]+`), kind: 'kw' },
    { re: sticky(String.raw`--[\w-]+|[a-z-]+(?=\s*:[^:{]*[;}\n])`), kind: 'prop' },
    { re: sticky(String.raw`#[\da-fA-F]{3,8}\b`), kind: 'num' },
    { re: sticky(String.raw`[.#][A-Za-z_-][\w-]*`), kind: 'type' },
    { re: sticky(String.raw`::?[\w-]+`), kind: 'meta' },
    DOUBLE,
    SINGLE,
    NUMBER,
  ],
}

const IDENT = sticky(String.raw`[A-Za-z_$][\w$]*`)
const CSS_IDENT = sticky(String.raw`[A-Za-z_-][\w-]*`)
const CALLED = /^\s*\(/

/** The family for a fence's language, or a guess from the code when the fence names none. */
export function familyOf(lang: string, code: string): Family | null {
  const named = lang.trim().toLowerCase()
  if (named) return FAMILIES[named] ?? (named === 'text' || named === 'plain' || named === 'txt' ? null : 'c')
  return guess(code)
}

function guess(code: string): Family | null {
  const text = code.trim()
  if (!text) return null
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text)
      return 'json'
    } catch {
      /* not JSON: something else that starts with a brace */
    }
  }
  if (/^<(!doctype|!--|[a-z][\w:-]*)[\s>/]/i.test(text)) return 'markup'
  if (/^(select|insert|update|delete|create|alter|drop|with)\s/i.test(text) && /\b(from|into|set|table|where|values|as)\b/i.test(text)) return 'sql'
  const first = text.split('\n')[0]
  if (/^(#!|\$ |> )/.test(first) || /^(sudo|npm|npx|pnpm|yarn|bun|git|cd|ls|brew|apt|apt-get|pip|pip3|curl|wget|docker|kubectl|export|mkdir|rm|cp|mv|chmod|ssh)\b/.test(first)) return 'hash'
  const braces = /[{};]\s*$/m.test(text)
  if (!braces && /^\s*(def |class \w+.*:|import \w|from [\w.]+ import|elif |print\(|if __name__)/m.test(text)) return 'hash'
  if (/^\s*[\w.#:\-\s,>*[\]="]+\{\s*$/m.test(text) && /^\s*[a-z-]+\s*:\s*[^;{}]+;\s*$/m.test(text) && !/\b(function|const|let|return)\b/.test(text)) return 'css'
  // Code of the C family is most of what people paste; anything else still gets its strings and numbers.
  return /[{}();=]/.test(text) ? 'c' : null
}

/** The code as text nodes and coloured spans. Plain text when the family is null or the code is too big. */
export function highlight(code: string, family: Family | null): Node[] {
  if (!family || code.length > MOST_CHARS) return [document.createTextNode(code)]
  const rules = RULES[family]
  const keywords = KEYWORDS[family]
  const ident = family === 'css' ? CSS_IDENT : IDENT
  const caseless = family === 'sql'
  const out: Node[] = []
  let plain = ''
  const push = (kind: Kind, text: string): void => {
    if (plain) out.push(document.createTextNode(plain))
    plain = ''
    out.push(h('span', { class: `tk-${kind}`, text }))
  }

  let at = 0
  while (at < code.length) {
    let matched = false
    for (const rule of rules) {
      rule.re.lastIndex = at
      const found = rule.re.exec(code)
      if (found && found[0]) {
        push(rule.kind, found[0])
        at += found[0].length
        matched = true
        break
      }
    }
    if (matched) continue

    ident.lastIndex = at
    const word = family === 'json' || family === 'markup' ? null : ident.exec(code)?.[0]
    if (word) {
      at += word.length
      const kind = kindOfWord(word, keywords, caseless, family, code.slice(at, at + 40))
      if (kind) push(kind, word)
      else plain += word
      continue
    }
    if (family === 'json') {
      const lit = /^(true|false|null)\b/.exec(code.slice(at, at + 6))
      if (lit) {
        push('lit', lit[0])
        at += lit[0].length
        continue
      }
    }
    plain += code[at]
    at += 1
  }
  if (plain) out.push(document.createTextNode(plain))
  return out
}

function kindOfWord(word: string, keywords: Set<string>, caseless: boolean, family: Family, after: string): Kind | null {
  if (LITERALS.has(word)) return 'lit'
  if (keywords.has(caseless ? word.toLowerCase() : word)) return 'kw'
  if (family === 'css') return null
  if (CALLED.test(after)) return 'fn'
  if (family === 'c' && /^[A-Z][a-z0-9]\w*$/.test(word)) return 'type'
  return null
}
