// Intensity state for the plugin: resolution, live switching, atomic persistence.
//
// Resolution order (highest wins), mirroring upstream ponytail:
//   1. PONYTAIL_DEFAULT_MODE environment variable
//   2. `${DSH_HOME}/ponytail/config.json` -> { enabled, mode }
//   3. DEFAULT_MODE ('full')
//
// The environment variable owns the *default*: it is re-read on every start, so a
// runtime switch (command or UI) persists to the config file yet stays shadowed by
// an explicit environment variable on the next start. That is upstream's behavior.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Selectable intensity levels. */
export const MODES = Object.freeze(['off', 'lite', 'full', 'ultra'])

/** Level used when nothing else is configured. */
export const DEFAULT_MODE = 'full'

/** Environment variable that pins the default level. */
export const MODE_ENV = 'PONYTAIL_DEFAULT_MODE'

/**
 * Normalize a candidate mode string.
 * @param {unknown} value - candidate.
 * @returns {'off'|'lite'|'full'|'ultra'|undefined} the mode, or undefined when invalid.
 */
export function normalizeMode(value) {
  if (typeof value !== 'string') return undefined
  const mode = value.trim().toLowerCase()
  return MODES.includes(mode) ? /** @type {any} */ (mode) : undefined
}

/**
 * Resolve `$DSH_HOME`, defaulting to `~/.dsh`.
 * @param {Record<string, string|undefined>} env - environment.
 * @returns {string} absolute home path.
 */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(env.HOME || homedir(), '.dsh')
}

/**
 * Directory that holds this plugin's config file.
 * @param {Record<string, string|undefined>} env - environment.
 * @returns {string} absolute directory path.
 */
export function configDir(env = process.env) {
  return join(dshHome(env), 'ponytail')
}

/**
 * Read the persisted config, tolerating a missing or corrupt file.
 * @param {string} file - absolute config path.
 * @param {{ warn?: (message: string) => void }} [options] - diagnostics sink.
 * @returns {{ enabled?: boolean, mode?: string }} raw persisted values.
 */
export function readConfigFile(file, options = {}) {
  const warn = options.warn ?? (() => {})
  if (!existsSync(file)) return {}
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A half-written or hand-edited file must never take the host down.
    warn(`[dsh-ponytail] ignoring unreadable config at ${file}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const out = {}
  if (typeof parsed.enabled === 'boolean') out.enabled = parsed.enabled
  const mode = normalizeMode(parsed.mode)
  if (mode !== undefined) out.mode = mode
  return out
}

/**
 * Persist config atomically (temp file + rename inside the same directory).
 * @param {string} file - absolute config path.
 * @param {{ enabled: boolean, mode: string }} value - snapshot to write.
 * @param {{ warn?: (message: string) => void }} [options] - diagnostics sink.
 * @returns {boolean} whether the write landed.
 */
export function writeConfigFile(file, value, options = {}) {
  const warn = options.warn ?? (() => {})
  const dir = join(file, '..')
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch (error) {
    // Persistence is best effort: the in-memory switch already took effect.
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    warn(`[dsh-ponytail] could not persist config: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Create the live intensity state.
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   dir?: string,
 *   warn?: (message: string) => void,
 * }} [options] - injectable seams for tests.
 * @returns {{
 *   modes: readonly string[],
 *   snapshot: () => { enabled: boolean, mode: string, source: 'env'|'config'|'default' },
 *   setMode: (mode: unknown) => boolean,
 *   setEnabled: (enabled: unknown) => boolean,
 *   baselineText: () => string,
 * }} live state handle.
 */
export function createState(options = {}) {
  const env = options.env ?? process.env
  const warn = options.warn ?? (() => {})
  const dir = options.dir ?? configDir(env)
  const file = join(dir, 'config.json')

  const persisted = readConfigFile(file, { warn })
  const envMode = normalizeMode(env[MODE_ENV])

  const state = {
    enabled: persisted.enabled ?? true,
    mode: envMode ?? persisted.mode ?? DEFAULT_MODE,
    source: envMode !== undefined ? 'env' : persisted.mode !== undefined ? 'config' : 'default',
  }

  const persist = () => {
    writeConfigFile(file, { enabled: state.enabled, mode: state.mode }, { warn })
  }

  return {
    modes: MODES,
    snapshot() {
      return { enabled: state.enabled, mode: state.mode, source: state.source }
    },
    setMode(mode) {
      const next = normalizeMode(mode)
      if (next === undefined) return false
      state.mode = next
      persist()
      return true
    },
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') return false
      state.enabled = enabled
      persist()
      return true
    },
  }
}
