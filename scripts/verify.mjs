#!/usr/bin/env node
// Executable acceptance for this port. Eleven assertions, no test framework.
//
//   npm run verify      # exits 0 and prints VERIFY: PASS only when all pass

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WORKSPACE_PRECEDENCE, baselineFor, clearBaselineCache } from '../lib/baseline.js'
import { createCommandHandler, isDeactivationCommand, parseCommandInput } from '../lib/command.js'
import { parseFrontmatter } from '../lib/frontmatter.js'
import { createDeactivationListener, isPreStepEnabled } from '../lib/prestep.js'
import { createProvider } from '../lib/provider.js'
import { DEFAULT_MODE, MODES, createState } from '../lib/state.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CATALOG_DESCRIPTION_MAX = 500

let passed = 0
let failed = 0

/**
 * Record one assertion result.
 * @param {string} label - assertion id and description.
 * @param {boolean} ok - outcome.
 * @param {string} [detail] - failure detail.
 * @returns {void}
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * sha256 of a file.
 * @param {string} path - file path.
 * @returns {string} hex digest.
 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const lock = JSON.parse(readFileSync(join(ROOT, 'upstream.lock.json'), 'utf8'))
const provider = createProvider()

console.log('\n1. skill bodies match upstream.lock.json')
{
  const entries = Object.entries(lock.files)
  check('lock records 6 skill files', entries.length === 6, `got ${entries.length}`)
  for (const [path, digest] of entries) {
    const actual = sha256(join(ROOT, path))
    check(`${path} sha256`, actual === digest, `expected ${digest.slice(0, 12)}, got ${actual.slice(0, 12)}`)
  }
}

console.log('\n2. skill names are valid kebab-case and match their directory')
{
  for (const [path] of Object.entries(lock.files)) {
    const dir = path.split('/')[1]
    const { data } = parseFrontmatter(readFileSync(join(ROOT, path), 'utf8'))
    check(`${dir}: name "${data.name}"`, NAME_PATTERN.test(data.name) && data.name === dir)
  }
}

console.log('\n3. descriptions fit the DSH catalog budget (500 chars)')
{
  for (const [path] of Object.entries(lock.files)) {
    const { data } = parseFrontmatter(readFileSync(join(ROOT, path), 'utf8'))
    const flat = String(data.description ?? '').replace(/\s+/g, ' ').trim()
    check(`${data.name}: ${flat.length} chars`, flat.length > 0 && flat.length <= CATALOG_DESCRIPTION_MAX)
  }
}

console.log('\n4. provider lists six skills and loads every body')
{
  const candidates = await provider.list()
  check('list() returns 6', candidates.length === 6, `got ${candidates.length}`)
  check('every candidate carries name/description/invocation/source/provider/rank/locator',
    candidates.every(c => typeof c.name === 'string' && typeof c.description === 'string' &&
      c.invocation?.modelInvocable === true && c.source === provider.name && c.provider === provider.name &&
      Number.isFinite(c.rank) && c.locator !== undefined))
  for (const candidate of candidates) {
    const loaded = await provider.get(candidate)
    check(`${candidate.name} get() returns a body`, loaded !== undefined && loaded.content.trim().length > 0)
  }
}

console.log('\n5. baselines: off is empty, the three levels differ')
{
  clearBaselineCache()
  check("baselineFor('off') is empty", baselineFor('off') === '')
  const lite = baselineFor('lite')
  const full = baselineFor('full')
  const ultra = baselineFor('ultra')
  check('lite != full', lite !== full)
  check('full != ultra', full !== ultra)
  check('lite != ultra', lite !== ultra)
}

console.log('\n6. full baseline keeps the four load-bearing clauses')
{
  const full = baselineFor('full')
  check('has "Before you write"', full.includes('Before you write'))
  check('has the shortcut marker convention', full.includes('shortcut:'))
  check('has the "Never cut" guard', full.includes('Never cut'))
  check('has the ladder', full.includes('The smallest complete change'))
}

console.log('\n7. ultra pushes back instead of refusing to ask (HB regression guard)')
{
  const ultra = baselineFor('ultra').toLowerCase()
  check('ultra questions the request', ultra.includes('question the request') || ultra.includes('push back'))
  check('ultra does NOT contain the inverted HB rule',
    !ultra.includes('never ask whether the requirement is needed'))
}

console.log('\n8. level resolution: env > config > default')
{
  const dir = join(ROOT, '.verify-state')
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const bare = createState({ env: {}, dir })
  check(`no env and no file -> ${DEFAULT_MODE}`, bare.snapshot().mode === DEFAULT_MODE && bare.snapshot().source === 'default')

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true, mode: 'ultra' }))
  const fromFile = createState({ env: {}, dir })
  check('config file wins over default', fromFile.snapshot().mode === 'ultra' && fromFile.snapshot().source === 'config')

  const fromEnv = createState({ env: { PONYTAIL_DEFAULT_MODE: 'lite' }, dir })
  check('env wins over config file', fromEnv.snapshot().mode === 'lite' && fromEnv.snapshot().source === 'env')

  const corrupt = join(dir, 'config.json')
  writeFileSync(corrupt, '{ not json')
  const salvaged = createState({ env: {}, dir })
  check('corrupt config falls back instead of throwing', salvaged.snapshot().mode === DEFAULT_MODE)

  const live = createState({ env: {}, dir })
  live.setMode('lite')
  check('setMode persists across processes', createState({ env: {}, dir }).snapshot().mode === 'lite')
  check('setMode rejects an unknown level', live.setMode('turbo') === false)
  check('setEnabled rejects a non-boolean', live.setEnabled('yes') === false)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n9. deactivation requires the whole message (upstream bug fix)')
{
  check('"stop ponytail" deactivates', isDeactivationCommand('stop ponytail'))
  check('"normal mode." deactivates', isDeactivationCommand('normal mode.'))
  check('"  Stop Ponytail  " deactivates', isDeactivationCommand('  Stop Ponytail  '))
  check('"add a normal mode toggle" does NOT', isDeactivationCommand('add a normal mode toggle') === false)
  check('"stop ponytail and also fix the bug" does NOT', isDeactivationCommand('stop ponytail and also fix the bug') === false)
}

console.log('\n10. command parsing')
{
  check('empty argument means status', parseCommandInput('').kind === 'status')
  check('"status" means status', parseCommandInput(' status ').kind === 'status')
  for (const mode of MODES) {
    const parsed = parseCommandInput(` ${mode} `)
    check(`"${mode}" sets that level`, parsed.kind === 'set' && parsed.mode === mode)
  }
  const bad = parseCommandInput(' turbo')
  check('unknown level is an error', bad.kind === 'error' && bad.text.includes('turbo'))

  const state = createState({ env: {}, dir: join(ROOT, '.verify-state-cmd') })
  const handler = createCommandHandler({ state })
  const switched = await handler({ rawInput: ' ultra' })
  check('handler switches level', switched.kind === 'success' && state.snapshot().mode === 'ultra')
  const status = await handler({ rawInput: '' })
  check('handler reports status', status.kind === 'success' && status.text.includes('ultra'))
  const rejected = await handler({ rawInput: ' nope' })
  check('handler rejects a bad level without changing state',
    rejected.kind === 'error' && state.snapshot().mode === 'ultra')
  const { rmSync } = await import('node:fs')
  rmSync(join(ROOT, '.verify-state-cmd'), { recursive: true, force: true })
}

console.log('\n11. workspace-precedence clause survives level filtering')
{
  for (const mode of ['lite', 'full', 'ultra']) {
    check(`${mode} baseline carries the clause`, baselineFor(mode).includes(WORKSPACE_PRECEDENCE))
  }
  check('off baseline carries no clause', baselineFor('off').includes('Workspace precedence') === false)
}

console.log('\n12. version strings agree across every manifest and the changelog')
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const pluginManifest = JSON.parse(readFileSync(join(ROOT, 'dsh.plugin.json'), 'utf8'))
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const semver = /^\d+\.\d+\.\d+$/
  check(`package.json version "${pkg.version}" is semver`, semver.test(pkg.version))
  check('dsh.plugin.json matches package.json', pluginManifest.version === pkg.version,
    `plugin manifest says ${pluginManifest.version}`)
  check('CHANGELOG has a heading for this version', changelog.includes(`## [${pkg.version}]`),
    `no "## [${pkg.version}]" heading`)
  check('dsh engines hint matches the manifest', pluginManifest.engines?.dsh === pkg.engines?.dsh,
    `${pluginManifest.engines?.dsh} vs ${pkg.engines?.dsh}`)
  check('compatibility matrix is declared', Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {}).length > 0)
}

console.log('\n13. the pre-step listener honours the waterfall contract')
{
  // Regression gate for v1.0.0-v1.1.0: a listener that did not call next() and
  // returned undefined made the host throw
  // "Cannot read properties of undefined (reading 'kind')" on every step.
  const dir = join(ROOT, '.verify-state-pre')
  const { mkdirSync, rmSync } = await import('node:fs')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const state = createState({ env: {}, dir })
  const listener = createDeactivationListener(state)

  let calls = 0
  const decision = { kind: 'enter', messages: [{ content: 'do the thing' }] }
  const returned = await listener({ messages: [{ content: 'do the thing' }] }, async () => {
    calls += 1
    return decision
  })
  check('listener calls next() exactly once', calls === 1, `called ${calls} times`)
  check('listener returns the decision object itself', returned === decision,
    returned === undefined ? 'returned undefined — this is the v1.0.0 bug' : 'returned a different object')
  check('a non-triggering message leaves the level alone', state.snapshot().mode === 'full')

  const deactivating = await listener({ messages: [{ content: 'stop ponytail' }] }, async () => decision)
  check('a deactivation phrase still returns the decision', deactivating === decision)
  check('a deactivation phrase switches to off', state.snapshot().mode === 'off')

  const inert = await listener({ messages: [] })
  check('without a continuation the listener stays inert', inert === undefined)

  check('the listener is opt-in, off by default', isPreStepEnabled({}) === false)
  check('an explicit env opt-in enables it', isPreStepEnabled({ PONYTAIL_PRE_STEP: '1' }) === true)

  const indexSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('index.js gates the registration behind isPreStepEnabled', indexSource.includes('isPreStepEnabled()'))
  check('index.js no longer registers an unguarded pre-step handler',
    !/ctx\.on\('agent\/pre-step',\s*payload\s*=>/.test(indexSource))

  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('VERIFY: FAIL')
  process.exit(1)
}
console.log('VERIFY: PASS')
