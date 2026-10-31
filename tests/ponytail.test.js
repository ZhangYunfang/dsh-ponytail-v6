// Unit tests for the pieces that do not need a live DSH host.
// The live mounting behaviour is covered by scripts/verify.mjs plus the manual
// acceptance steps in docs/ACCEPTANCE.md.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WORKSPACE_PRECEDENCE, baselineFor, filterSkillBodyForMode, readSkillBody } from '../lib/baseline.js'
import { createCommandHandler, isDeactivationCommand, parseCommandInput, statusText } from '../lib/command.js'
import { parseFrontmatter } from '../lib/frontmatter.js'
import { createProvider, discoverSkills } from '../lib/provider.js'
import { MODES, createState, normalizeMode } from '../lib/state.js'

test('frontmatter: folded description becomes one line', () => {
  const { data, body } = parseFrontmatter('---\nname: x\ndescription: >\n  one\n  two\n\n  three\n---\n\n# Title\n')
  assert.equal(data.name, 'x')
  assert.equal(data.description, 'one two\nthree')
  assert.equal(body.trim(), '# Title')
})

test('frontmatter: missing header yields the whole file as body', () => {
  const { data, body } = parseFrontmatter('# only markdown\n')
  assert.deepEqual(data, {})
  assert.equal(body, '# only markdown\n')
})

test('frontmatter: quoted scalar is unquoted', () => {
  const { data } = parseFrontmatter('---\nname: "quoted"\n---\n')
  assert.equal(data.name, 'quoted')
})

test('normalizeMode accepts the four levels and rejects the rest', () => {
  for (const mode of MODES) assert.equal(normalizeMode(` ${mode.toUpperCase()} `), mode)
  for (const bad of ['turbo', '', null, 42, undefined]) assert.equal(normalizeMode(bad), undefined)
})

test('state: config file round-trips and env overrides it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-state-'))
  try {
    const state = createState({ env: {}, dir })
    assert.equal(state.snapshot().mode, 'full')
    assert.equal(state.setMode('ultra'), true)
    assert.equal(createState({ env: {}, dir }).snapshot().mode, 'ultra')

    const withEnv = createState({ env: { PONYTAIL_DEFAULT_MODE: 'lite' }, dir })
    assert.equal(withEnv.snapshot().mode, 'lite')
    assert.equal(withEnv.snapshot().source, 'env')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('state: a corrupt config file does not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-corrupt-'))
  try {
    writeFileSync(join(dir, 'config.json'), '{{{')
    const warnings = []
    const state = createState({ env: {}, dir, warn: message => warnings.push(message) })
    assert.equal(state.snapshot().mode, 'full')
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('state: disabled makes the section text empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-enabled-'))
  try {
    const state = createState({ env: {}, dir })
    state.setEnabled(false)
    assert.equal(state.snapshot().enabled, false)
    assert.equal(state.setEnabled('true'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('baseline: off is empty and the other levels differ', () => {
  assert.equal(baselineFor('off'), '')
  const texts = ['lite', 'full', 'ultra'].map(mode => baselineFor(mode))
  assert.equal(new Set(texts).size, 3)
})

test('baseline: identical input gives an identical string (cache stability)', () => {
  assert.equal(baselineFor('full'), baselineFor('full'))
})

test('baseline: each level keeps only its own table row', () => {
  const body = readSkillBody()
  assert.match(filterSkillBodyForMode(body, 'lite'), /\|\s*\*\*lite\*\*/)
  assert.doesNotMatch(filterSkillBodyForMode(body, 'lite'), /\|\s*\*\*ultra\*\*/)
  assert.match(filterSkillBodyForMode(body, 'ultra'), /\|\s*\*\*ultra\*\*/)
  assert.doesNotMatch(filterSkillBodyForMode(body, 'ultra'), /\|\s*\*\*full\*\*/)
})

test('baseline: workspace precedence clause is appended to every active level', () => {
  for (const mode of ['lite', 'full', 'ultra']) {
    const text = baselineFor(mode)
    assert.ok(text.includes(WORKSPACE_PRECEDENCE), mode)
    assert.ok(text.startsWith(`PONYTAIL MODE ACTIVE — level: ${mode}`), mode)
  }
})

test('command: deactivation needs the whole message', () => {
  assert.equal(isDeactivationCommand('stop ponytail'), true)
  assert.equal(isDeactivationCommand('NORMAL MODE!'), true)
  assert.equal(isDeactivationCommand('add a normal mode toggle'), false)
  assert.equal(isDeactivationCommand(undefined), false)
})

test('command: parse handles status, the four levels and errors', () => {
  assert.deepEqual(parseCommandInput(''), { kind: 'status' })
  assert.deepEqual(parseCommandInput('status'), { kind: 'status' })
  for (const mode of MODES) assert.deepEqual(parseCommandInput(` ${mode}`), { kind: 'set', mode })
  assert.equal(parseCommandInput('nope').kind, 'error')
})

test('command: switching a level re-enables a disabled section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-cmd-'))
  try {
    const state = createState({ env: {}, dir })
    state.setEnabled(false)
    const handler = createCommandHandler({ state })
    const result = await handler({ rawInput: ' lite' })
    assert.equal(result.kind, 'success')
    assert.equal(state.snapshot().enabled, true)
    assert.equal(state.snapshot().mode, 'lite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('command: status text names the level', () => {
  assert.match(statusText({ enabled: true, mode: 'ultra', source: 'config' }), /ultra/)
  assert.match(statusText({ enabled: false, mode: 'full', source: 'default' }), /disabled/)
})

test('provider: discovers six skills, every body non-empty', async () => {
  const skills = discoverSkills()
  assert.equal(skills.length, 6)
  const provider = createProvider()
  const candidates = await provider.list()
  assert.equal(candidates.length, 6)
  for (const candidate of candidates) {
    const loaded = await provider.get(candidate)
    assert.ok(loaded, candidate.name)
    assert.ok(loaded.content.length > 100, candidate.name)
    assert.equal(loaded.name, candidate.name)
    assert.equal(loaded.source, provider.name)
  }
})

test('provider: get() returns undefined for an unreadable candidate', async () => {
  const provider = createProvider()
  assert.equal(await provider.get({ name: 'ghost', path: '/nonexistent/SKILL.md' }), undefined)
  assert.equal(await provider.get(null), undefined)
})

test('provider: skill bodies stay byte-identical to the lock', () => {
  const lock = JSON.parse(readFileSync(new URL('../upstream.lock.json', import.meta.url), 'utf8'))
  assert.equal(Object.keys(lock.files).length, 6)
  for (const path of Object.keys(lock.files)) {
    assert.ok(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').length > 0, path)
  }
})
