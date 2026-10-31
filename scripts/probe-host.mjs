#!/usr/bin/env node
// Host-contract probe: mounts this plugin into a REAL cordis context together with
// the REAL SystemPrompt and WebServer services, then exercises the public surface
// (prompt section, skill provider, host command, HTTP API) end to end.
//
//   node scripts/probe-host.mjs [--dsh-home=/path/to/dsh-checkout]
//
// It does not boot dsh-web and does not touch ~/.dsh: the plugin's state directory
// is redirected into a temp dir. Use it before installing to prove the four seams
// still match the host you have.

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_CHECKOUT = process.env.DSH_CHECKOUT
  ?? join(homedir(), 'Project', 'deepseek-harness-dsh-v0.1.2-alpha.2')
const CHECKOUT = process.argv.find(a => a.startsWith('--dsh-home='))?.split('=')[1]
  ?? process.argv.find(a => a.startsWith('--checkout='))?.split('=')[1]
  ?? DEFAULT_CHECKOUT

const requireFromCheckout = createRequire(join(CHECKOUT, 'package.json'))
const requireFromProfile = createRequire(join(homedir(), '.dsh', 'profiles', 'web', 'package.json'))

let passed = 0
let failed = 0

/**
 * Record one assertion.
 * @param {string} label - assertion label.
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
 * Poll until a predicate holds.
 * @param {() => boolean} predicate - condition.
 * @param {number} [timeoutMs] - budget.
 * @returns {Promise<boolean>} whether it became true.
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

const { Context } = requireFromProfile('@deepseek-ai/cordis')
const { SystemPrompt } = requireFromCheckout(join(CHECKOUT, 'packages', 'core', 'system-prompt', 'lib', 'index.js'))
const { WebServer } = requireFromProfile('@deepseek-ai/dsh-host-webserver')

// Redirect the plugin's state directory into a temp dir BEFORE the plugin loads,
// so a probe run can never write into the real ~/.dsh.
const stateDir = mkdtempSync(join(tmpdir(), 'pt-probe-'))
process.env.DSH_HOME = stateDir
const ctx = new Context()

/** @type {Array<Record<string, unknown>>} */
const skillRegistrations = []
/** @type {Array<Record<string, unknown>>} */
const commandRegistrations = []

try {
  // Fake registries with the documented shapes: enough to prove what the plugin calls.
  ctx.provide('skills', {
    registerProvider(create) {
      skillRegistrations.push(create({ signal: undefined, invalidate: () => {} }))
      return () => {}
    },
  })
  const commands = {
    register(definition) {
      commandRegistrations.push(definition)
      return () => {}
    },
  }
  ctx.provide('commands', commands)

  console.log(`checkout: ${CHECKOUT}`)
  console.log(`state dir: ${stateDir}\n`)

  console.log('1. real services load')
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  check('SystemPrompt service is available', await waitFor(() => ctx.systemPrompt !== undefined))
  check('WebServer service is available', await waitFor(() => ctx.webServer !== undefined))
  check('WebServer is listening on an OS-assigned port', await waitFor(() => typeof ctx.webServer.port === 'number' && ctx.webServer.port > 0),
    `port=${ctx.webServer?.port}`)

  console.log('\n2. plugin mounts without throwing')
  const plugin = await import('../lib/index.js')
  check('exports apply/inject/name', typeof plugin.apply === 'function' && Array.isArray(plugin.inject) && plugin.name === 'ponytail')
  check('inject declares systemPrompt', plugin.inject.includes('systemPrompt'))
  let mountError
  try {
    ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
    await new Promise(resolve => setTimeout(resolve, 250))
  } catch (error) {
    mountError = error
  }
  check('apply() ran without throwing', mountError === undefined, mountError?.message)
  check('skill provider registered once', skillRegistrations.length === 1, `got ${skillRegistrations.length}`)
  check('host command registered once', commandRegistrations.length === 1, `got ${commandRegistrations.length}`)

  console.log('\n3. skill provider satisfies the real registry')
  const provider = skillRegistrations[0]
  check('provider name is set', typeof provider.name === 'string' && provider.name.length > 0)
  const candidates = await provider.list({})
  check('provider.list() returns 6 candidates', candidates.length === 6, `got ${candidates.length}`)
  const firstCandidate = candidates[0]
  check('candidate carries rank/locator/invocation',
    Number.isFinite(firstCandidate?.rank) && firstCandidate?.locator !== undefined && firstCandidate?.invocation?.modelInvocable === true)
  const loaded = await provider.get(firstCandidate, {})
  check('provider.get() returns content', typeof loaded?.content === 'string' && loaded.content.length > 100)

  console.log('\n4. host command behaviour')
  const definition = commandRegistrations[0]
  check('command name is "ponytail"', definition.name === 'ponytail')
  check('command advertises an input hint', definition.input?.hint !== undefined)
  const statusResult = await definition.handler({ rawInput: '', agent: undefined, attachments: [], signal: undefined, commandId: undefined })
  check('bare command returns success', statusResult.kind === 'success', JSON.stringify(statusResult))
  check('bare command reports the level', String(statusResult.text).includes('full'), statusResult.text)
  const switchResult = await definition.handler({ rawInput: ' ultra', agent: undefined, attachments: [], signal: undefined, commandId: undefined })
  check('switching returns success', switchResult.kind === 'success', JSON.stringify(switchResult))
  const badResult = await definition.handler({ rawInput: ' turbo', agent: undefined, attachments: [], signal: undefined, commandId: undefined })
  check('unknown level returns an error result', badResult.kind === 'error')

  console.log('\n5. prompt section reaches the real assembler')
  const assembly = await ctx.systemPrompt.assemble({})
  const rendered = JSON.stringify(assembly)
  check('section text is part of the assembled prompt', rendered.includes('PONYTAIL MODE ACTIVE'), `keys=${Object.keys(assembly).join(',')}`)
  check('ultra text is active after the switch', rendered.includes('level: ultra'), 'the level switch did not reach assembly')
  check('workspace-precedence clause is present', rendered.includes('Workspace precedence'))

  console.log('\n6. HTTP API over the real WebServer')
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const getState = await fetch(`${base}/ponytail/state`)
  const stateBody = await getState.json()
  check('GET /ponytail/state -> 200', getState.status === 200, `status=${getState.status}`)
  check('state reports the live level', stateBody.mode === 'ultra', JSON.stringify(stateBody))
  check('state lists the four modes', Array.isArray(stateBody.modes) && stateBody.modes.length === 4)

  const postMode = await fetch(`${base}/ponytail/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'lite' }),
  })
  check('POST /ponytail/mode -> 200', postMode.status === 200, `status=${postMode.status}`)
  check('mode switched to lite', (await postMode.json()).mode === 'lite')

  const badMode = await fetch(`${base}/ponytail/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'turbo' }),
  })
  check('POST /ponytail/mode with a bad level -> 400', badMode.status === 400, `status=${badMode.status}`)

  const badBody = await fetch(`${base}/ponytail/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  })
  check('POST /ponytail/mode with broken JSON -> 400', badBody.status === 400, `status=${badBody.status}`)

  const wrongMethod = await fetch(`${base}/ponytail/mode`)
  check('GET /ponytail/mode -> 405', wrongMethod.status === 405, `status=${wrongMethod.status}`)

  const notFound = await fetch(`${base}/ponytail/nope`)
  check('GET /ponytail/nope -> 404', notFound.status === 404, `status=${notFound.status}`)

  const disable = await fetch(`${base}/ponytail/enabled`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
  check('POST /ponytail/enabled -> 200', disable.status === 200, `status=${disable.status}`)
  const disabledAssembly = await ctx.systemPrompt.assemble({})
  check('disabling removes the section from the prompt', JSON.stringify(disabledAssembly).includes('PONYTAIL MODE ACTIVE') === false)

  // Re-enable: section 6 turned the master switch off on purpose.
  await fetch(`${base}/ponytail/enabled`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })

  console.log('\n7. the section is scope-independent, so subagents inherit it')
  // SystemPrompt merges per-scope layers ON TOP of the global layer, and this plugin
  // registers on the profile-root (global) context, so every agent scope sees it.
  // Verified empirically across several scope shapes rather than argued from source.
  const scopeShapes = [
    ['no scope', undefined],
    ['empty object', {}],
    ['string key', 'agent:child'],
    ['symbol token', Symbol('agent')],
    ['nested object', { id: 'child', parent: 'root' }],
  ]
  for (const [label, scope] of scopeShapes) {
    let rendered = ''
    let scopeError
    try {
      rendered = JSON.stringify(await ctx.systemPrompt.assemble({ scope }))
    } catch (error) {
      scopeError = error
    }
    check(`${label} receives the ruleset`, scopeError === undefined && rendered.includes('PONYTAIL MODE ACTIVE'),
      scopeError?.message ?? 'section missing from the assembly')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('PROBE: FAIL')
    process.exitCode = 1
  } else {
    console.log('PROBE: PASS')
  }
} catch (error) {
  console.error('\nprobe crashed:', error)
  process.exitCode = 1
} finally {
  // The real WebServer keeps the event loop alive.
  rmSync(stateDir, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
