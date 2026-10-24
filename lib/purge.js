/**
 * Filesystem half of permanent Session deletion.
 *
 * A DSH Session leaves four kinds of artifacts on this machine:
 *
 *   1. its append-only log directory   $DSH_HOME/sessions/<project>/<session-id>/
 *   2. its projection-cache record     $DSH_HOME/storages/session_projcache/sessions/<session-id>.json
 *   3. its session-scoped spill dir    <tmp>/dsh-spill-<gen>/session-<sha256(id)[0..12]>
 *   4. its Workspace accounting        $DSH_HOME/storages/workspace.json (membership/archive/pin ids)
 *
 * This module owns 1–3. It never imports a Host package, so it can be unit-tested
 * against a synthetic DSH home without a running application. (4) belongs to the
 * live registry and is handled by the service through public registry APIs.
 *
 * Path encoding mirrors the shipped JSONL persistence backend: a Project directory
 * is `--<readable-cwd>--`, and a Session id is escaped to one safe path segment.
 * The fallback directory scan keeps the purge working even if that layout changes,
 * because the id is looked up under every Project directory instead of being
 * rebuilt from a stored cwd.
 *
 * @module dsh-session-delete/purge
 */

import { createHash } from 'node:crypto'
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** One file-system-safe code unit: kept literal by {@link encodeSegment}. */
const SAFE_UNIT = /^[A-Za-z0-9._-]$/

/**
 * Encode an arbitrary string as a single safe path segment.
 *
 * This is the shipped Session-id escape: safe code units stay literal and every
 * other UTF-16 code unit becomes `~XXXX`, so `..`, `/`, `\`, `:` and NUL can never
 * escape the session root. The Service validates ids before they get here; the
 * encoder is the second line of defence.
 *
 * @param {string} raw - non-empty segment source.
 * @returns {string} the escaped segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && SAFE_UNIT.test(character)) out += character
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the readable Project directory key for one working directory.
 *
 * Separator runs collapse to one `-`; a leading run is stripped; unsafe code units
 * use the same escape as session ids; the component is bounded for file-system
 * limits. `C:\\AI\\demo` therefore becomes `--C-AI-demo--`.
 *
 * @param {string} cwd - the Session's project directory.
 * @returns {string} a single safe directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && SAFE_UNIT.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Resolve the directory owned by one Session under a sessions root.
 *
 * @param {string} root - sessions root (`$DSH_HOME/sessions`).
 * @param {string | undefined} cwd - the Session's project directory; unknown selects `_no-cwd`.
 * @param {string} id - Session id.
 * @returns {string} absolute session directory.
 */
export function sessionDirectory(root, cwd, id) {
  const project = cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
  return join(project, encodeSegment(id))
}

/** @param {string} target @returns {Promise<boolean>} */
async function directoryExists(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Locate every on-disk directory for one Session.
 *
 * The id is looked up under each Project directory instead of re-deriving the
 * Project key from a stored cwd, so a header whose `cwd` was recorded with a
 * different spelling (or none) still yields the directory the backend uses.
 *
 * @param {string} root - sessions root.
 * @param {string} id - Session id.
 * @returns {Promise<string[]>} existing session directories.
 */
export async function findSessionDirectories(root, id) {
  const encoded = encodeSegment(id)
  /** @type {string[]} */
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, encoded)
    if (await directoryExists(candidate)) found.push(candidate)
  }
  return found
}

/** @param {string} target @returns {Promise<boolean>} */
async function fileExists(target) {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}

/**
 * Locate the projection-cache record for one Session.
 *
 * @param {string} dshHome - `$DSH_HOME`.
 * @param {string} id - Session id.
 * @returns {Promise<string[]>} existing cache files.
 */
export async function findProjectionCacheFiles(dshHome, id) {
  const directory = join(dshHome, 'storages', 'session_projcache', 'sessions')
  /** @type {string[]} */
  const found = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }
  // `<id>.json` is the live checkpoint. `<id>.json.bak.<stamp>` is the domain
  // layer's quarantine copy of a document it considered unreadable; it carries the
  // same session's projection, so it belongs to the same deletion.
  const candidates = new Set([`${id}.json`, `${encodeSegment(id)}.json`])
  const backupPrefixes = [`${id}.json.bak.`, `${encodeSegment(id)}.json.bak.`]
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const isBackup = backupPrefixes.some((prefix) => entry.name.startsWith(prefix))
    if (!candidates.has(entry.name) && !isBackup) continue
    const target = join(directory, entry.name)
    if (await fileExists(target)) found.push(target)
  }
  return found
}

/**
 * The directory name `dsh-spill-local` derives for one Session.
 *
 * @param {string} id - Session id.
 * @returns {string} `session-<12 hex>`.
 */
export function spillDirectoryName(id) {
  return `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

/**
 * Discover the spill roots this machine uses.
 *
 * `dsh-spill-local` creates one `dsh-spill-*` directory under the OS temp root per
 * process generation and keeps earlier generations discoverable, so the scan is
 * deliberately shape-based: only exact `dsh-spill-*` names count, never a prefix
 * match that could touch an unrelated fixture.
 *
 * @param {string[]} [extra] - additional roots from configuration.
 * @returns {Promise<string[]>} existing candidate roots.
 */
export async function discoverSpillRoots(extra = []) {
  /** @type {string[]} */
  const roots = []
  try {
    const entries = await readdir(tmpdir(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/^dsh-spill-[A-Za-z0-9_-]+$/.test(entry.name)) continue
      roots.push(join(tmpdir(), entry.name))
    }
  } catch {
    /* a missing temp root simply contributes no candidates */
  }
  for (const root of extra) {
    if (typeof root === 'string' && root.length > 0) roots.push(root)
  }
  return roots
}

/**
 * Locate every session-scoped spill directory for one Session.
 *
 * @param {string[]} roots - candidate spill roots.
 * @param {string} id - Session id.
 * @returns {Promise<string[]>} existing spill directories.
 */
export async function findSpillDirectories(roots, id) {
  const name = spillDirectoryName(id)
  /** @type {string[]} */
  const found = []
  for (const root of roots) {
    const candidate = join(root, name)
    if (await directoryExists(candidate)) found.push(candidate)
  }
  return found
}

/**
 * Recursively measure the files and bytes under one path.
 *
 * @param {string} target - file or directory.
 * @returns {Promise<{ files: number, bytes: number }>} the measurement.
 */
export async function measurePath(target) {
  const result = { files: 0, bytes: 0 }
  let info
  try {
    info = await stat(target)
  } catch {
    return result
  }
  if (info.isFile()) {
    result.files = 1
    result.bytes = info.size
    return result
  }
  if (!info.isDirectory()) return result
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const child = await measurePath(join(target, entry.name))
    result.files += child.files
    result.bytes += child.bytes
  }
  return result
}

/**
 * Remove one path, retrying the transient Windows locks a closing handle leaves behind.
 *
 * @param {string} target - file or directory.
 * @returns {Promise<{ removed: boolean, files: number, bytes: number, error?: string }>} the outcome.
 */
async function removePath(target) {
  const measurement = await measurePath(target)
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 })
    return { removed: true, ...measurement }
  } catch (error) {
    return { removed: false, ...measurement, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Delete every on-disk artifact owned by the given Sessions.
 *
 * A missing artifact is success, so a repeated sweep after a stop is safe. One
 * failure never aborts the rest: the report carries it and the Service decides how
 * to surface it.
 *
 * @param {object} options - purge inputs.
 * @param {string} options.sessionsRoot - sessions root.
 * @param {string} options.dshHome - `$DSH_HOME`.
 * @param {string[]} options.sessionIds - target ids, parent first.
 * @param {string[]} [options.spillRoots] - extra spill roots.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {Promise<{
 *   sessionDirs: string[],
 *   cacheFiles: string[],
 *   spillDirs: string[],
 *   projectDirs: string[],
 *   files: number,
 *   bytes: number,
 *   failures: { path: string, message: string }[],
 * }>} the removal report.
 */
export async function purgeSessionArtifacts(options) {
  const { sessionsRoot, dshHome, sessionIds, spillRoots = [], log } = options
  const report = {
    sessionDirs: [],
    cacheFiles: [],
    spillDirs: [],
    projectDirs: [],
    files: 0,
    bytes: 0,
    failures: [],
  }
  const roots = await discoverSpillRoots(spillRoots)
  const touchedProjects = new Set()

  for (const id of sessionIds) {
    for (const directory of await findSessionDirectories(sessionsRoot, id)) {
      touchedProjects.add(join(directory, '..'))
      const outcome = await removePath(directory)
      report.files += outcome.files
      report.bytes += outcome.bytes
      if (outcome.removed) report.sessionDirs.push(directory)
      else {
        report.failures.push({ path: directory, message: outcome.error ?? 'unknown error' })
        log?.(`failed to remove session directory '${directory}': ${outcome.error ?? 'unknown error'}`)
      }
    }
    for (const file of await findProjectionCacheFiles(dshHome, id)) {
      const outcome = await removePath(file)
      report.files += outcome.files
      report.bytes += outcome.bytes
      if (outcome.removed) report.cacheFiles.push(file)
      else {
        report.failures.push({ path: file, message: outcome.error ?? 'unknown error' })
        log?.(`failed to remove projection cache '${file}': ${outcome.error ?? 'unknown error'}`)
      }
    }
    for (const directory of await findSpillDirectories(roots, id)) {
      const outcome = await removePath(directory)
      report.files += outcome.files
      report.bytes += outcome.bytes
      if (outcome.removed) report.spillDirs.push(directory)
      else {
        report.failures.push({ path: directory, message: outcome.error ?? 'unknown error' })
        log?.(`failed to remove spill directory '${directory}': ${outcome.error ?? 'unknown error'}`)
      }
    }
  }

  // A Project directory this purge emptied is part of the session's footprint too.
  for (const project of touchedProjects) {
    try {
      const remaining = await readdir(project)
      if (remaining.length > 0) continue
      // Non-recursive removal only: a session created in this directory between the
      // read and the removal makes rmdir fail instead of taking a live log with it.
      await rmdir(project)
      report.projectDirs.push(project)
    } catch {
      /* a shared or already-removed project directory is not a failure */
    }
  }
  return report
}

/**
 * Merge a follow-up sweep into the report of the first one.
 *
 * @param {Awaited<ReturnType<typeof purgeSessionArtifacts>>} base - first report.
 * @param {Awaited<ReturnType<typeof purgeSessionArtifacts>>} next - follow-up report.
 * @returns {Awaited<ReturnType<typeof purgeSessionArtifacts>>} the merged report.
 */
export function mergeReports(base, next) {
  const unique = (values) => [...new Set(values)]
  return {
    sessionDirs: unique([...base.sessionDirs, ...next.sessionDirs]),
    cacheFiles: unique([...base.cacheFiles, ...next.cacheFiles]),
    spillDirs: unique([...base.spillDirs, ...next.spillDirs]),
    projectDirs: unique([...base.projectDirs, ...next.projectDirs]),
    files: base.files + next.files,
    bytes: base.bytes + next.bytes,
    failures: [...base.failures, ...next.failures],
  }
}