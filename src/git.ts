// Git sin riesgo: descargar, y como mucho avanzar la rama actual hacia su remota. Nunca mezcla
// ramas divergentes y nunca guarda ni reaplica cambios locales: si el avance pisaría algo, git se
// niega y el proyecto queda como estaba. Solo hace rebase si se pide, y si choca lo deshace.
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
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? 'git failed without saying why'
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
  /** Si la rama se ha separado de su remota, rebase encima; si choca, `rebase --abort`. */
  rebaseIfDiverged?: boolean
  /** Contar los commits locales que no están en la remota. */
  reportAhead?: boolean
  /**
   * Para el rebase y su `--abort`: un git que Detener no corta, porque un rebase cortado a medias
   * dejaría el proyecto a mitad de camino. Sin él se usa `git`.
   */
  steady?: GitRunner
  /** Se pulsó Detener: lo que no ha empezado (el rebase) ya no empieza. */
  stopped?: () => boolean
}

function countOf(result: GitResult): number | null {
  const total = Number.parseInt(result.stdout.trim(), 10)
  return result.ok && Number.isFinite(total) ? total : null
}

/** Commits propios (no están en la remota) y ajenos (no están en la rama); null si git falla. */
async function divergence(git: GitRunner, cwd: string): Promise<{ ahead: number; behind: number } | null> {
  const result = await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map((part) => Number.parseInt(part, 10))
  return result.ok && Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null
}

type Updated = Extract<GitOutcome, { kind: 'updated' }>

/** Descarga y, en modo `pull`, avanza. `changedFiles` son los archivos que cambió el avance. */
export async function syncProject(
  git: GitRunner,
  cwd: string,
  options: SyncOptions
): Promise<{ outcome: GitOutcome; changedFiles: string[] }> {
  const done = (outcome: GitOutcome, changedFiles: string[] = []) => ({ outcome, changedFiles })
  /** Como `done`, apuntando antes los commits sin subir, si se piden y hay alguno. */
  const finish = async (outcome: GitOutcome, changedFiles: string[] = []) => {
    if (
      options.reportAhead &&
      (outcome.kind === 'updated' ||
        outcome.kind === 'fetched' ||
        outcome.kind === 'up-to-date' ||
        (outcome.kind === 'failed' && (outcome.step === 'merge' || outcome.step === 'rebase')))
    ) {
      const ahead = countOf(await git(cwd, ['rev-list', '--count', '@{u}..HEAD']))
      if (ahead) outcome.ahead = ahead
    }
    return done(outcome, changedFiles)
  }

  const upstream = await upstreamOf(git, cwd)
  if (!upstream) return done({ kind: 'no-upstream' })
  if (options.skipIfDirty && (await isDirty(git, cwd))) return done({ kind: 'dirty' })

  const fetched = await fetch(git, cwd, options.fetchAll)
  if (!fetched.ok) return done({ kind: 'failed', step: 'fetch', message: explain(fetched.stderr) })

  if (options.mode === 'fetch') {
    const incoming = await commitsIn(git, cwd, 'HEAD..@{u}')
    return finish(
      incoming.count > 0
        ? { kind: 'fetched', upstream, ...incoming }
        : { kind: 'up-to-date', upstream }
    )
  }

  const before = await git(cwd, ['rev-parse', 'HEAD'])
  if (!before.ok) return done({ kind: 'failed', step: 'git', message: explain(before.stderr) })
  const from = before.stdout.trim()

  /** Lo común a avanzar y a rebase: commits (si no se contaron ya), archivos y submódulos. */
  const advanced = async (outcome: Updated, counted: boolean) => {
    const after = await git(cwd, ['rev-parse', 'HEAD'])
    if (!after.ok) return done({ kind: 'failed', step: 'git', message: explain(after.stderr) })
    const to = after.stdout.trim()
    if (from === to) return finish({ kind: 'up-to-date', upstream })
    if (!counted) Object.assign(outcome, await commitsIn(git, cwd, `${from}..${to}`))
    const diff = await git(cwd, ['diff', '--name-only', from, to])
    if (options.updateSubmodules) {
      const submodules = await git(cwd, ['submodule', 'update', '--init', '--recursive'], 300_000)
      outcome.submodules = submodules.ok ? { ok: true } : { ok: false, message: explain(submodules.stderr) }
    }
    return finish(outcome, diff.ok ? lines(diff.stdout) : [])
  }

  const merge = await git(cwd, ['merge', '--ff-only', '--no-autostash', '@{u}'])
  if (merge.ok) return advanced({ kind: 'updated', upstream, count: 0, commits: [] }, false)

  const split = options.rebaseIfDiverged ? await divergence(git, cwd) : null
  if (!split || split.ahead === 0 || split.behind === 0) {
    return finish({ kind: 'failed', step: 'merge', message: explain(merge.stderr) })
  }

  // La rama se ha separado. Los commits de la remota se cuentan antes: después del rebase,
  // `from..to` también incluiría las copias nuevas de los commits locales.
  const incoming = await commitsIn(git, cwd, 'HEAD..@{u}')
  if (options.stopped?.()) return done({ kind: 'cancelled' })
  const steady = options.steady ?? git
  const rebase = await steady(cwd, ['rebase', '--no-autostash', '--no-autosquash', '@{u}'], 120_000)
  if (!rebase.ok) {
    const reason = explain(rebase.stderr || rebase.stdout)
    const abort = await steady(cwd, ['rebase', '--abort'])
    // Si el rebase ni empezó (por ejemplo, con cambios sin commitear), no hay nada que deshacer.
    const undone = abort.ok || /no rebase in progress/i.test(abort.stderr)
    return finish({
      kind: 'failed',
      step: 'rebase',
      message: undone
        ? `${reason} Rebase aborted: the branch is as it was.`
        : `${reason} git rebase --abort failed too (${explain(abort.stderr)}): finish or abort the rebase by hand.`
    })
  }
  return advanced({ kind: 'updated', upstream, ...incoming, rebased: split.ahead }, true)
}

/** Para la revisión periódica: descarga y cuenta los commits sin aplicar, sin mover nada. */
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
