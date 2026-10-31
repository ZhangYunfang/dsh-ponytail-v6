#!/usr/bin/env node
// Record the upstream identity and the sha256 of every packaged skill body.
//
// The lock is what makes "verbatim" checkable: `npm run verify` recomputes these
// digests and fails when a skill file has drifted from what was recorded.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_PATH = join(ROOT, 'upstream.lock.json')
const SKILLS_ROOT = join(ROOT, 'skills')

/**
 * sha256 of a file.
 * @param {string} path - file path.
 * @returns {string} lowercase hex digest.
 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Collect every skills/<name>/SKILL.md with its digest.
 * @returns {Record<string, string>} relative path -> digest, sorted by path.
 */
function collect() {
  const files = {}
  for (const name of readdirSync(SKILLS_ROOT).sort()) {
    const path = join(SKILLS_ROOT, name, 'SKILL.md')
    if (!existsSync(path)) continue
    files[relative(ROOT, path).split('\\').join('/')] = sha256(path)
  }
  return files
}

const previous = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, 'utf8')) : {}
const argVersion = process.argv.find(a => a.startsWith('--upstream-version='))?.split('=')[1]
const argCommit = process.argv.find(a => a.startsWith('--upstream-commit='))?.split('=')[1]

const lock = {
  upstream: {
    repo: 'https://github.com/DietrichGebert/ponytail',
    license: 'MIT',
    version: argVersion ?? previous?.upstream?.version ?? 'unknown',
    commit: argCommit ?? previous?.upstream?.commit ?? 'unknown',
  },
  algorithm: 'sha256',
  files: collect(),
}

writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
console.log(`lock: ${Object.keys(lock.files).length} skill files recorded`)
for (const [path, digest] of Object.entries(lock.files)) console.log(`  ${digest.slice(0, 16)}  ${path}`)
console.log(`  upstream ${lock.upstream.version} @ ${String(lock.upstream.commit).slice(0, 12)}`)
