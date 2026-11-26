// Git sin riesgo: descargar, y como mucho avanzar la rama actual hacia su remota. Nunca mezcla
// ramas divergentes, nunca hace rebase y nunca guarda ni reaplica cambios locales: si el avance
// pisaría algo, git se niega y el proyecto queda como estaba.
import { execFile } from 'node:child_process'
import type { GitOutcome } from './protocol'

export type GitResult = { ok: boolean; stdout: string; stderr: string }
/** `signal` corta el proceso de git en marcha (Detener). */
export type GitRunner = (cwd: string, args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<GitResult>

/** Cuántas líneas de commit se guardan y se pasan al agente como mucho. */
export const MAX_COMMITS = 30

export const runGit: GitRunner = (cwd, args, timeoutMs = 60_000, signal) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        signal,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // Sin ventanas ni preguntas de credenciales: si hacen falta, el fetch falla y se informa.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (error ? error.message : '')
        })
      }
    )
  })

/** La línea de git que explica el fallo (`fatal: …`, `error: …`), o la primera que haya. */
export function explain(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? 'git falló sin decir por qué'
  return line.length > 200 ? `${line.slice(0, 197)}…` : line
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function upstreamOf(git: GitRunner, cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return result.ok ? result.stdout.trim() : null
}

/** Archivos versionados con cambios sin commitear (los no versionados no cuentan). */
export async function isDirty(git: GitRunner, cwd: string): Promise<boolean> {
  const result = await git(cwd, ['status', '--porcelain', '--untracked-files=no'])
  return !result.ok || result.stdout.trim() !== ''
}

async function fetch(git: GitRunner, cwd: string, all: boolean): Promise<GitResult> {
  return git(cwd, all ? ['fetch', '--all', '--prune', '--quiet'] : ['fetch', '--quiet'], 120_000)
}

/** Commits de un rango: cuántos son y las primeras líneas. */
async function commitsIn(git: GitRunner, cwd: string, range: string): Promise<{ count: number; commits: string[] }> {
  const count = await git(cwd, ['rev-list', '--count', range])
  const log = await git(cwd, ['log', '--oneline', '--no-decorate', '-n', String(MAX_COMMITS), range])
  const commits = log.ok ? lines(log.stdout) : []
  const total = Number.parseInt(count.stdout.trim(), 10)
  return { count: Number.isFinite(total) ? total : commits.length, commits }
}

export type SyncOptions = {
  mode: 'pull' | 'fetch'
  fetchAll: boolean
  skipIfDirty: boolean
  updateSubmodules: boolean
}

/** Descarga y, en modo `pull`, avanza. `changedFiles` son los archivos que cambió el avance. */
export async function syncProject(
  git: GitRunner,
  cwd: string,
  options: SyncOptions
): Promise<{ outcome: GitOutcome; changedFiles: string[] }> {
  const done = (outcome: GitOutcome, changedFiles: string[] = []) => ({ outcome, changedFiles })

  const upstream = await upstreamOf(git, cwd)
  if (!upstream) return done({ kind: 'no-upstream' })
  if (options.skipIfDirty && (await isDirty(git, cwd))) return done({ kind: 'dirty' })

  const fetched = await fetch(git, cwd, options.fetchAll)
  if (!fetched.ok) return done({ kind: 'failed', step: 'fetch', message: explain(fetched.stderr) })

  if (options.mode === 'fetch') {
    const incoming = await commitsIn(git, cwd, 'HEAD..@{u}')
    return done(
      incoming.count > 0
        ? { kind: 'fetched', upstream, ...incoming }
        : { kind: 'up-to-date', upstream }
    )
  }

  const before = await git(cwd, ['rev-parse', 'HEAD'])
  if (!before.ok) return done({ kind: 'failed', step: 'git', message: explain(before.stderr) })

  const merge = await git(cwd, ['merge', '--ff-only', '--no-autostash', '@{u}'])
  if (!merge.ok) return done({ kind: 'failed', step: 'merge', message: explain(merge.stderr) })

  const after = await git(cwd, ['rev-parse', 'HEAD'])
  if (!after.ok) return done({ kind: 'failed', step: 'git', message: explain(after.stderr) })

  const from = before.stdout.trim()
  const to = after.stdout.trim()
  if (from === to) return done({ kind: 'up-to-date', upstream })

  const { count, commits } = await commitsIn(git, cwd, `${from}..${to}`)
  const diff = await git(cwd, ['diff', '--name-only', from, to])
  const outcome: GitOutcome = { kind: 'updated', upstream, count, commits }
  if (options.updateSubmodules) {
    const submodules = await git(cwd, ['submodule', 'update', '--init', '--recursive'], 300_000)
    outcome.submodules = submodules.ok ? { ok: true } : { ok: false, message: explain(submodules.stderr) }
  }
  return done(outcome, diff.ok ? lines(diff.stdout) : [])
}

/** Para la revisión periódica: descarga y cuenta lo que hay por traer, sin mover nada. */
export async function checkIncoming(
  git: GitRunner,
  cwd: string,
  fetchAll: boolean
): Promise<{ upstream: string; count: number } | null> {
  const upstream = await upstreamOf(git, cwd)
  if (!upstream) return null
  const fetched = await fetch(git, cwd, fetchAll)
  if (!fetched.ok) throw new Error(explain(fetched.stderr))
  const { count } = await commitsIn(git, cwd, 'HEAD..@{u}')
  return { upstream, count }
}

/** Cuántos commits va por detrás de su remota un worktree; null si no sigue a ninguna. */
export async function behindCount(git: GitRunner, cwd: string): Promise<number | null> {
  if (!(await upstreamOf(git, cwd))) return null
  const count = await git(cwd, ['rev-list', '--count', 'HEAD..@{u}'])
  const total = Number.parseInt(count.stdout.trim(), 10)
  return count.ok && Number.isFinite(total) ? total : null
}
