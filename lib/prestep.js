// Optional natural-language deactivation, wired into the `agent/pre-step` waterfall.
//
// READ THIS BEFORE TOUCHING THE LISTENER.
//
// `agent/pre-step` is a cooperative waterfall: every listener is called as
// `(payload, next)` and MUST call `next()` and return the decision it produced.
// A listener that returns `undefined` hands `undefined` to the next listener, and
// the host then evaluates `decision.kind` on it — which throws
//   TypeError: Cannot read properties of undefined (reading 'kind')
// on EVERY step, taking the whole agent down. That is exactly what v1.0.0-v1.1.0
// did, so two rules apply from now on:
//
//   1. `await next()` is unconditional and outside any try/catch that could swallow it.
//   2. The feature is OPT-IN (`PONYTAIL_PRE_STEP=1`). Its value is small (the
//      `/ponytail off` command already covers it) while its blast radius is total.
//
// See the host contract in packages/core/agent/src/runtime-types.ts and the emit
// site in packages/core/agent-loop/src/agent.ts.

import { isDeactivationCommand } from './command.js'

/** Environment variable that opts into the pre-step listener. */
export const PRE_STEP_ENV = 'PONYTAIL_PRE_STEP'

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Whether the pre-step listener is enabled for this environment.
 * @param {Record<string, string|undefined>} [env] - environment to read.
 * @returns {boolean} true only for an explicit opt-in.
 */
export function isPreStepEnabled(env = process.env) {
  const raw = env?.[PRE_STEP_ENV]
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase())
}

/**
 * Extract the last user message's text from a pre-step payload.
 * @param {unknown} payload - `{ messages?: unknown[] }` per the host contract.
 * @returns {string|undefined} message text, or undefined when none can be read.
 */
export function lastUserText(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const messages = /** @type {any} */ (payload).messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index])
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * Read one message's text, accepting a plain string or content blocks.
 * @param {unknown} message - message or block container.
 * @returns {string|undefined} text when readable.
 */
function messageText(message) {
  if (typeof message === 'string') return message
  if (message === null || typeof message !== 'object') return undefined
  const content = /** @type {any} */ (message).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Build the waterfall listener.
 *
 * Guarantees, in order of importance:
 *   * it calls `next()` exactly once and returns its decision unchanged;
 *   * a heuristic failure can never propagate (`try/catch` is inside, after `next`);
 *   * a host that passes no continuation gets a no-op instead of a broken chain.
 *
 * @param {{ snapshot: () => { enabled: boolean, mode: string }, setMode: (mode: unknown) => boolean }} state
 *   the live intensity state.
 * @param {{ match?: (text: string) => boolean }} [options] - test seam for the phrase matcher.
 * @returns {(payload: unknown, next?: unknown) => Promise<unknown>} the listener.
 */
export function createDeactivationListener(state, options = {}) {
  const match = options.match ?? isDeactivationCommand

  return async function ponytailPreStep(payload, next) {
    // No continuation means the host is not using the waterfall contract. Nothing
    // will read a return value, so stay inert rather than guessing.
    if (typeof next !== 'function') return undefined

    const decision = await next()

    try {
      const text = lastUserText(payload)
      if (text !== undefined && match(text)) {
        const snapshot = state.snapshot()
        if (snapshot.mode !== 'off') state.setMode('off')
      }
    } catch {
      // A convenience heuristic must never break the step it is observing.
    }

    return decision
  }
}
