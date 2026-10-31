// The `/ponytail` host command: zero-token intensity switching.
//
// `CommandDefinition` handlers run against the receiving agent WITHOUT sending the
// command to the model, so a level switch costs nothing and takes effect on the
// next model step.

import { MODES, normalizeMode } from './state.js'

/** Command name without the leading slash. */
export const COMMAND_NAME = 'ponytail'

/** Input hint advertised to capable clients. */
export const COMMAND_HINT = '[status|off|lite|full|ultra]'

const MODE_HELP = MODES.filter(mode => mode !== 'off').join('|')

/**
 * Match upstream's deactivation rule: the WHOLE message must be the command.
 * Substring matching turned ordinary requests such as "add a normal mode toggle"
 * into a shutdown, which is the bug upstream documents in its own source.
 * @param {unknown} text - candidate message.
 * @returns {boolean} true when the message is exactly a deactivation phrase.
 */
export function isDeactivationCommand(text) {
  if (typeof text !== 'string') return false
  const normalized = text.trim().toLowerCase().replace(/[.!?\s]+$/, '')
  return normalized === 'stop ponytail' || normalized === 'normal mode'
}

/**
 * Parse the text following the command name.
 * @param {unknown} rawInput - `CommandInvocation.rawInput` (leading space included).
 * @returns {{ kind: 'status' } | { kind: 'set', mode: 'off'|'lite'|'full'|'ultra' } | { kind: 'error', text: string }}
 *   parsed intent.
 */
export function parseCommandInput(rawInput) {
  const arg = String(rawInput ?? '').trim().toLowerCase()
  if (arg === '' || arg === 'status') return { kind: 'status' }
  const mode = normalizeMode(arg)
  if (mode !== undefined) return { kind: 'set', mode }
  return {
    kind: 'error',
    text: `${COMMAND_NAME}: unknown argument "${arg}". Use ${COMMAND_HINT.replace(/[[\]]/g, '')}.`,
  }
}

/**
 * Render the current state as one short line.
 * @param {{ enabled: boolean, mode: string, source: string }} snapshot - live state.
 * @returns {string} human-readable status.
 */
export function statusText(snapshot) {
  if (snapshot.enabled === false) {
    return `ponytail: disabled (master switch off). Re-enable in Settings, or \`/${COMMAND_NAME} ${MODE_HELP}\`.`;
  }
  return `ponytail: level ${snapshot.mode} (default source: ${snapshot.source}). Switch with \`/${COMMAND_NAME} ${MODE_HELP}|off\`.`
}

/**
 * Build the command handler.
 * @param {{ state: { snapshot: () => any, setMode: (mode: unknown) => boolean, setEnabled: (enabled: unknown) => boolean } }} deps
 *   the live state.
 * @returns {(invocation: { rawInput?: string }) => Promise<{ kind: 'success'|'error', text: string }>} handler.
 */
export function createCommandHandler({ state }) {
  return async invocation => {
    const parsed = parseCommandInput(invocation?.rawInput)
    if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }

    if (parsed.kind === 'status') {
      return { kind: 'success', text: statusText(state.snapshot()) }
    }

    if (!state.setMode(parsed.mode)) {
      return { kind: 'error', text: `${COMMAND_NAME}: could not switch to "${parsed.mode}".` }
    }
    // Switching a level also clears a master-switch shutdown: asking for a level
    // is an explicit request to have the ruleset active again.
    if (parsed.mode !== 'off' && state.snapshot().enabled === false) state.setEnabled(true)

    return {
      kind: 'success',
      text: parsed.mode === 'off'
        ? 'ponytail: off. No ruleset is injected until you switch back.'
        : `ponytail: level ${parsed.mode}. Takes effect on the next step.`,
    }
  }
}
