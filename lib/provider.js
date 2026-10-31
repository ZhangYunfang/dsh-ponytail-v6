// Skill provider: publishes the six packaged ponytail skills to `ctx.skills`.
//
// Registration is on the host plane, so every agent preset's scope chain merges
// these skills. Bodies are the upstream files verbatim — no rewriting, no
// per-host edits.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrontmatter } from './frontmatter.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Default directory holding one sub-directory per skill. */
export const SKILLS_ROOT = join(HERE, '..', 'skills')

/** Registry key for this provider. */
export const PROVIDER_NAME = 'dsh-ponytail-v6'

/** Prompt-visible source bucket. */
export const SOURCE = 'dsh-ponytail-v6'

/** Duplicate-name priority; low numbers win. Bundled skills sit at 600. */
export const RANK = 100

const DEFAULT_INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Discover packaged skills.
 * @param {string} skillsRoot - directory of skill sub-directories.
 * @returns {Array<{ name: string, description: string, dir: string, path: string, metadata: Record<string, string> }>}
 *   usable skills in directory order.
 */
export function discoverSkills(skillsRoot = SKILLS_ROOT) {
  const found = []
  for (const entry of readdirSync(skillsRoot).sort()) {
    const dir = join(skillsRoot, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const path = join(dir, 'SKILL.md')
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const { data } = parseFrontmatter(raw)
    const name = typeof data.name === 'string' ? data.name.trim() : ''
    const description = typeof data.description === 'string' ? data.description.trim() : ''
    // Skip anything the host registry would reject anyway.
    if (!NAME_PATTERN.test(name) || description === '') continue
    found.push({ name, description, dir, path, metadata: data })
  }
  return found
}

/**
 * Build a provider object for `ctx.skills.registerProvider`.
 * @param {{ skillsRoot?: string }} [options] - test seam.
 * @returns {{
 *   name: string,
 *   list: (options?: unknown) => Promise<Array<Record<string, unknown>>>,
 *   get: (candidate: { name: string, dir: string, path: string }, options?: unknown) => Promise<Record<string, unknown> | undefined>,
 * }} provider.
 */
export function createProvider(options = {}) {
  const skillsRoot = options.skillsRoot ?? SKILLS_ROOT

  return {
    name: PROVIDER_NAME,

    async list() {
      return discoverSkills(skillsRoot).map(skill => ({
        name: skill.name,
        description: skill.description,
        invocation: { ...DEFAULT_INVOCATION },
        source: SOURCE,
        provider: PROVIDER_NAME,
        rank: RANK,
        locator: skill.dir,
        path: skill.path,
      }))
    },

    async get(candidate) {
      if (candidate === null || typeof candidate !== 'object') return undefined
      const path = typeof candidate.path === 'string' ? candidate.path : undefined
      const dir = typeof candidate.dir === 'string' ? candidate.dir : undefined
      if (path === undefined) return undefined

      let raw
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
      const { data, body } = parseFrontmatter(raw)
      const name = typeof data.name === 'string' ? data.name.trim() : ''
      const description = typeof data.description === 'string' ? data.description.trim() : ''
      if (!NAME_PATTERN.test(name) || description === '') return undefined

      const result = {
        name,
        description,
        invocation: { ...DEFAULT_INVOCATION },
        source: SOURCE,
        provider: PROVIDER_NAME,
        content: body,
        path,
      }
      if (dir !== undefined) result.resourceBase = { kind: 'directory', path: dir }
      if (typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '') {
        result.whenToUse = data.whenToUse.trim()
      }
      if (Object.keys(data).length > 0) result.metadata = data
      return result
    },
  }
}
