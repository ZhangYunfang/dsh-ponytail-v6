#!/usr/bin/env node
// Browser-half probe: loads lib/client.js exactly the way DSH's module loader does,
// mounts it on a fake `ctx`, renders the panel with REAL React + react-dom/server,
// and drives the panel's real HTTP helpers against the host half's REAL WebServer.
//
//   node scripts/probe-client.mjs [--checkout=/path/to/dsh-checkout]
//
// No browser needed, and no installation: this is what makes the settings panel a
// verified claim rather than "it follows the same pattern as another plugin".

import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKOUT = process.argv.find(a => a.startsWith('--checkout='))?.split('=')[1]
  ?? process.env.DSH_CHECKOUT
  ?? join(homedir(), 'Project', 'deepseek-harness-dsh-v0.1.2-alpha.2')
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')

const requireFromCheckout = createRequire(join(CHECKOUT, 'package.json'))
// The checkout keeps react/react-dom in the pnpm store rather than hoisted at the root.
const PNPM = join(CHECKOUT, 'node_modules', '.pnpm')
const reactDomServerPath = join(PNPM, 'react-dom@18.3.1_react@18.3.1', 'node_modules', 'react-dom', 'server.js')
const requireFromReactDom = createRequire(reactDomServerPath)
const React = requireFromReactDom('react')
const { renderToStaticMarkup } = requireFromReactDom('react-dom/server')

let stateDir = ''
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
 * Load the client bundle through a stub of the host loader.
 * @returns {Record<string, any>} the module exports the loader would receive.
 */
function loadClientBundle() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  /** @type {any} */
  let captured
  const windowStub = {
    __ModuleLoader__: {
      load(options) {
        captured = options
      },
    },
  }
  // The bundle is plain script text with no import/export, so it can be evaluated
  // with the loader globals supplied as parameters.
  new Function('window', 'console', source)(windowStub, console)
  if (captured === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load')
  const requireStub = name => {
    if (name === 'react') return React
    throw new Error(`unexpected external require: ${name}`)
  }
  return { options: captured, exports: captured.factory(requireStub) }
}

/**
 * Mount the client half on a fake slots registry.
 * @param {Record<string, any>} clientExports - bundle exports.
 * @returns {Array<{ descriptor: Record<string, any>, component: any }>} registrations.
 */
function mountOnFakeCtx(clientExports) {
  const registrations = []
  const ctx = {
    slots: {
      inject(name, factory) {
        if (name !== 'settings.section') throw new Error(`unexpected slot: ${name}`)
        return factory()
      },
      register(descriptor, component) {
        registrations.push({ descriptor, component })
        return () => {}
      },
    },
  }
  clientExports.apply(ctx)
  return registrations
}

console.log(`checkout: ${CHECKOUT}\n`)

console.log('1. the bundle loads through the host loader envelope')
const loaded = loadClientBundle()
check('calls window.__ModuleLoader__.load once', loaded.options !== undefined)
check('registers under the package id', loaded.options.id === 'dsh-ponytail-v6', String(loaded.options.id))
check('exports apply', typeof loaded.exports.apply === 'function')
check('declares the slots dependency', Array.isArray(loaded.exports.inject) && loaded.exports.inject.includes('slots'))

console.log('\n2. mounting registers exactly one settings section')
const registrations = mountOnFakeCtx(loaded.exports)
check('one registration', registrations.length === 1, `got ${registrations.length}`)
const { descriptor, component } = registrations[0] ?? {}
check('slot name is settings.section', descriptor?.name === 'settings.section')
check('section id is ponytail-v6', descriptor?.id === 'ponytail-v6', String(descriptor?.id))
check('section order is a finite number', Number.isFinite(descriptor?.order))
check('label() returns "Ponytail"', descriptor?.label?.() === 'Ponytail', String(descriptor?.label?.()))

console.log('\n3. the panel renders with real React')
let markup = ''
let renderError
try {
  markup = renderToStaticMarkup(React.createElement(component))
} catch (error) {
  renderError = error
}
check('renderToStaticMarkup does not throw', renderError === undefined, renderError?.message)
check('shows the plugin name', markup.includes('Ponytail'))
for (const label of ['Off', 'Lite', 'Full', 'Ultra']) {
  check(`renders the ${label} button`, markup.includes(`>${label}<`), markup.slice(0, 200))
}
check('shows the level badge', /level (off|lite|full|ultra)|loading/.test(markup), markup.slice(0, 300))
check('shows the default-source line', markup.includes('PONYTAIL_DEFAULT_MODE'))

console.log('\n4. the panel\'s own HTTP helpers agree with the real host API')
{
  const requireFromProfile = createRequire(join(homedir(), '.dsh', 'profiles', 'web', 'package.json'))
  const { Context } = requireFromProfile('@deepseek-ai/cordis')
  const { WebServer } = requireFromProfile('@deepseek-ai/dsh-host-webserver')

  // Keep the probe out of the real ~/.dsh.
  stateDir = mkdtempSync(join(tmpdir(), 'pt-client-'))
  process.env.DSH_HOME = stateDir

  const ctx = new Context()
  ctx.provide('systemPrompt', { section: () => () => {} })
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  while (ctx.webServer === undefined || !(ctx.webServer.port > 0)) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const hostPlugin = await import('../lib/index.js')
  ctx.plugin({ name: hostPlugin.name, inject: hostPlugin.inject, apply: hostPlugin.apply })
  await new Promise(resolve => setTimeout(resolve, 200))

  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const realFetch = globalThis.fetch
  // The panel uses same-origin relative paths, exactly as it does in the browser.
  globalThis.fetch = (url, init) => realFetch(`${base}${url}`, init)

  try {
    const internals = loaded.exports.__internals
    check('bundle exposes the HTTP helpers for tests', internals !== undefined)

    const state = await internals.readState()
    check('readState() reads the real /ponytail/state', state.mode === 'full' && state.enabled === true, JSON.stringify(state))

    const switched = await internals.post('mode', { mode: 'ultra' })
    check('post("mode") switches on the real host', switched.mode === 'ultra', JSON.stringify(switched))

    let rejected = ''
    try {
      await internals.post('mode', { mode: 'turbo' })
    } catch (error) {
      rejected = error.message
    }
    check('post() surfaces the host 400 as an error', rejected.includes('mode must be one of'), rejected)

    const toggled = await internals.post('enabled', { enabled: false })
    check('post("enabled") toggles the master switch', toggled.enabled === false, JSON.stringify(toggled))
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('PROBE(CLIENT): FAIL')
  process.exitCode = 1
} else {
  console.log('PROBE(CLIENT): PASS')
}
// The real WebServer keeps the event loop alive.
if (stateDir !== '') {
  try {
    rmSync(stateDir, { recursive: true, force: true })
  } catch {}
}
process.exit(process.exitCode ?? 0)
