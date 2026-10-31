// The ruleset text injected into the system prompt, derived from the packaged
// upstream skill body. Single source of truth: skills/ponytail/SKILL.md.
//
// Upstream's Claude/Codex hooks filter the Levels table so only the active row
// survives (`filterSkillBodyForMode`). This module does the same, then adds the
// two additions this port owns: a level banner and the workspace-precedence
// clause. The skill files themselves stay byte-identical to upstream.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrontmatter } from './frontmatter.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the skill body the baseline is derived from. */
export const SKILL_PATH = join(HERE, '..', 'skills', 'ponytail', 'SKILL.md')

/**
 * Workspace instructions outrank this block. Added by this port (upstream has no
 * equivalent because its hosts do not carry hard gates). Without it, "laziest
 * change" can be read as licence to skip a workspace-mandated verification step.
 */
export const WORKSPACE_PRECEDENCE = [
  '## Workspace precedence',
  '',
  'Workspace instructions (AGENTS.md, project rules, and any gate they name) override this',
  'block wherever the two disagree. This block never justifies skipping a gate, a check, or',
  'a verification command a workspace requires.',
].join('\n')

/** @type {Map<string, string>} */
const bodyCache = new Map()

/**
 * Read the packaged skill body without its frontmatter.
 * @param {string} [skillPath] - override for tests.
 * @returns {string} markdown body.
 */
export function readSkillBody(skillPath = SKILL_PATH) {
  const cached = bodyCache.get(skillPath)
  if (cached !== undefined) return cached
  const body = parseFrontmatter(readFileSync(skillPath, 'utf8')).body
  bodyCache.set(skillPath, body)
  return body
}

/**
 * Keep only the active level's row (and worked example) of a level-keyed block.
 * @param {string} body - skill body.
 * @param {string} mode - active level.
 * @returns {string} filtered body.
 */
export function filterSkillBodyForMode(body, mode) {
  return String(body)
    .split(/\r?\n/)
    .filter(line => {
      const tableLabel = /^\|\s*\*\*(.+?)\*\*\s*\|/.exec(line)
      if (tableLabel !== null) {
        const label = tableLabel[1].trim().toLowerCase()
        if (isLevelWord(label)) return label === mode
      }
      // Worked examples are written as `- lite: "..."`; require the quote so an
      // ordinary rule bullet that merely starts with a level word survives.
      const exampleLabel = /^-\s*([^:]+):\s*"/.exec(line)
      if (exampleLabel !== null) {
        const label = exampleLabel[1].trim().toLowerCase()
        if (isLevelWord(label)) return label === mode
      }
      return true
    })
    .join('\n')
}

/**
 * Whether a word names a selectable level.
 * @param {string} value - candidate label.
 * @returns {boolean} true when it is a level name.
 */
function isLevelWord(value) {
  return value === 'lite' || value === 'full' || value === 'ultra'
}

/**
 * Compose the text for one level.
 * @param {string} mode - `off` | `lite` | `full` | `ultra`.
 * @param {{ skillPath?: string }} [options] - test seam.
 * @returns {string} prompt-section text; empty string for `off`.
 */
export function baselineFor(mode, options = {}) {
  if (mode === 'off') return ''
  const body = filterSkillBodyForMode(readSkillBody(options.skillPath), mode)
  return `PONYTAIL MODE ACTIVE — level: ${mode}\n\n${body.trim()}\n\n${WORKSPACE_PRECEDENCE}`
}

/**
 * Clear the body cache (tests that swap skill files).
 * @returns {void}
 */
export function clearBaselineCache() {
  bodyCache.clear()
}
