// dsh-ponytail-v6 — host half.
//
// Three seams, all public DSH APIs:
//   * systemPrompt.section  — the ruleset, re-evaluated per assembly so a level
//                             switch lands on the next step while an unchanged
//                             level keeps the prompt prefix byte-identical (cache hit).
//   * skills.registerProvider — the six upstream skills, packaged verbatim.
//   * commands.register     — `/ponytail [level]`, zero tokens (never reaches the model).
//
// Plus a tiny `/ponytail/*` HTTP API for the optional web client.

import { baselineFor } from './baseline.js'
import { COMMAND_HINT, COMMAND_NAME, createCommandHandler, isDeactivationCommand } from './command.js'
import { createDeactivationListener, isPreStepEnabled } from './prestep.js'
import { createProvider } from './provider.js'
import { createState, MODES } from './state.js'

/** Cordis plugin name. */
export const name = 'ponytail'

/** Hard dependency: the section cannot register without it. */
export const inject = ['systemPrompt']

/** Section name owned by this plugin. */
export const SECTION_NAME = 'plugin:dsh-ponytail'

/**
 * Placement: right after the deployment persona (`DEPLOYMENT_PERSONA = 0`) and
 * before plan policy (`PLAN_POLICY = 500`), so engineering rules read as part of
 * the persona rather than as tool documentation.
 */
export const SECTION_ORDER = 10

/** HTTP route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/ponytail'

/**
 * JSON reply helper.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed body (`{}` when empty).
 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Build the `/ponytail/*` request handler (Node native req/res, not Fetch API).
 * @param {{ snapshot: () => any, setMode: (mode: unknown) => boolean, setEnabled: (enabled: unknown) => boolean }} state
 *   live state.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createRouteHandler(state) {
  return async (req, res) => {
    let path
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request url' })
      return
    }

    if (path === `${ROUTE_PREFIX}/state`) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'use GET' })
        return
      }
      sendJson(res, 200, { ok: true, ...state.snapshot(), modes: MODES })
      return
    }

    if (path === `${ROUTE_PREFIX}/mode` || path === `${ROUTE_PREFIX}/enabled`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'use POST' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      if (path === `${ROUTE_PREFIX}/enabled`) {
        if (!state.setEnabled(body.enabled)) {
          sendJson(res, 400, { ok: false, error: 'enabled must be a boolean' })
          return
        }
        sendJson(res, 200, { ok: true, ...state.snapshot() })
        return
      }
      if (!state.setMode(body.mode)) {
        sendJson(res, 400, { ok: false, error: `mode must be one of ${MODES.join(', ')}` })
        return
      }
      sendJson(res, 200, { ok: true, ...state.snapshot() })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

/**
 * Plugin entry point.
 * @param {any} ctx - host context.
 * @returns {void}
 */
export function apply(ctx) {
  const warn = message => {
    try {
      if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
      else console.warn(message)
    } catch {
      // Logging must never be the thing that breaks startup.
    }
  }

  const state = createState({ warn })

  // 1. The ruleset. `text` is a function, evaluated at every assembly.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => {
        const snapshot = state.snapshot()
        return snapshot.enabled ? baselineFor(snapshot.mode) : ''
      },
    }),
  )

  // 2. The six skills, on the host plane so every agent preset sees them.
  const provider = createProvider()
  try {
    ctx.inject(['skills'], skillsCtx => {
      skillsCtx.effect(() => skillsCtx.skills.registerProvider(() => provider))
    })
  } catch (error) {
    warn(`[dsh-ponytail] skill provider not mounted: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 3. The slash command (zero tokens).
  try {
    const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
    if (commands !== undefined && typeof commands.register === 'function') {
      const handler = createCommandHandler({ state })
      ctx.effect(() =>
        commands.register({
          name: COMMAND_NAME,
          description: 'Switch the ponytail ruleset level (off/lite/full/ultra). Does not reach the model.',
          input: { hint: COMMAND_HINT },
          handler,
        }),
      )
    }
  } catch (error) {
    warn(`[dsh-ponytail] command not mounted: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 4. HTTP API for the optional web client.
  try {
    ctx.inject(['webServer'], webCtx => {
      const handler = createRouteHandler(state)
      webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
    })
  } catch (error) {
    warn(`[dsh-ponytail] web API not mounted: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 5. Optional text deactivation. Opt-in on purpose: see lib/prestep.js for the
  //    waterfall contract that a careless listener breaks for every step.
  if (!isPreStepEnabled()) return
  try {
    ctx.on('agent/pre-step', createDeactivationListener(state))
  } catch (error) {
    warn(`[dsh-ponytail] pre-step listener not mounted: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export { baselineFor, createProvider, createState, isDeactivationCommand }
export { MODES } from './state.js'
