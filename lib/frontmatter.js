// Minimal YAML frontmatter reader, sized to what ponytail's SKILL.md files use:
// scalar values plus the folded (`>`) and literal (`|`) block forms. It exists so
// the plugin stays dependency-free; it is not a general YAML parser.

/**
 * Split a SKILL.md into frontmatter data and the markdown body.
 * @param {string} raw - full file contents.
 * @returns {{ data: Record<string, string>, body: string }} parsed parts.
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }

  const data = {}
  const lines = match[1].split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const rest = kv[2].trim()

    if (rest === '>' || rest === '|') {
      // Collect the indented block that follows, dropping the common 2-space indent.
      const block = []
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (next.trim() !== '' && !/^[ \t]{2}/.test(next)) break
        block.push(next.replace(/^[ \t]{2}/, ''))
        i += 1
      }
      data[key] = rest === '>' ? fold(block) : trimBlankEdges(block.join('\n'))
      continue
    }

    if (rest === '') {
      data[key] = ''
      continue
    }

    data[key] = rest.replace(/^["']/, '').replace(/["']$/, '')
  }

  return { data, body: text.slice(match[0].length) }
}

/**
 * Fold block lines the way YAML's `>` scalar does: newlines inside a paragraph
 * become spaces, blank lines separate paragraphs.
 * @param {string[]} block - raw block lines.
 * @returns {string} folded scalar.
 */
function fold(block) {
  const paragraphs = []
  let current = []
  for (const line of block) {
    if (line.trim() === '') {
      if (current.length > 0) paragraphs.push(current.join(' '))
      current = []
      continue
    }
    current.push(line.trim())
  }
  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs.join('\n')
}

/**
 * Remove leading and trailing blank lines.
 * @param {string} text - input.
 * @returns {string} trimmed text.
 */
function trimBlankEdges(text) {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
}
