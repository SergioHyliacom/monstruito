// Los textos que Monstruito le manda al agente: el brief para dejar un proyecto listo después de
// la rutina (git, dependencias, preparación) y la petición de la nota de cierre del día. Van en
// una sola línea: un salto de línea enviaría el prompt a medias.
import type { GitOutcome, ProjectResult } from './protocol'
import { NEXT_NOTE, PROPOSED_COMMANDS, READY_NOTE, type OpenRequest } from './notes'

export type BriefContext = {
  project: string
  branch: string | null
  git: GitOutcome
  /** Lo que falló en la rutina, ya explicado. */
  failures: string[]
  /** La nota de cierre del día anterior. */
  note: string | null
  /** Lo que sigue abierto en Requests para este proyecto. */
  requests: OpenRequest[]
  /** El proyecto no tiene comandos en Monstruito: que el agente los proponga. */
  proposeCommands: boolean
  /** El prompt de los ajustes, como instrucciones de más. */
  extra: string
}

const MAX = 4000
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim()

function gitLine(git: GitOutcome): string {
  switch (git.kind) {
    case 'updated':
      return `I pulled ${plural(git.count, 'new commit', 'new commits')} from ${git.upstream}${git.rebased ? ', rebasing your local commits on top' : ''}`
    case 'fetched':
      return `${git.upstream} has ${plural(git.count, 'new commit', 'new commits')}, fetched but not in the branch yet`
    case 'up-to-date':
      return `the branch was already up to date with ${git.upstream}`
    case 'no-upstream':
      return 'the branch has no upstream, so nothing was pulled'
    case 'dirty':
      return 'there are uncommitted changes, so nothing was pulled'
    case 'failed':
      return `git failed (${clip(git.message, 160)})`
    case 'skipped':
      return 'git was left alone'
    case 'cancelled':
      return 'git was stopped'
  }
}

/** Lo que falló en la rutina de un proyecto, para que el agente lo arregle. */
export function failuresOf(result: ProjectResult): string[] {
  const failures: string[] = []
  if (result.git.kind === 'failed') failures.push(`git (${clip(result.git.message, 160)})`)
  for (const step of result.deps) {
    if (step.kind === 'failed') failures.push(`${step.command} (${clip(step.message ?? 'failed', 160)})`)
  }
  for (const command of result.commands) {
    if (command.result === 'failed') failures.push(`${command.name} (${clip(command.message ?? 'failed', 160)})`)
  }
  return failures
}

const STATUS_TEXT: Record<OpenRequest['status'], string> = {
  need: 'needs me',
  run: 'in progress',
  queue: 'queued'
}

export function buildBrief(context: BriefContext): string {
  const where = context.branch ? `${context.project} on ${context.branch}` : context.project
  const failed =
    context.failures.length > 0 ? `These steps failed: ${context.failures.join('; ')}.` : 'Nothing failed.'
  const requests =
    context.requests.length > 0
      ? ` Open requests for this project: ${context.requests.map((item) => `[${item.id}] ${item.title} (${STATUS_TEXT[item.status]})`).join('; ')}.`
      : ''
  const propose = context.proposeCommands
    ? ` 6) This project has no commands set up in Monstruito: propose them in ${PROPOSED_COMMANDS} as a JSON list of {"name", "command", "kind"}, with kind "tab" for servers and watchers that keep running or "prepare" for setup steps. Don't run them.`
    : ''
  const extra = context.extra.trim() ? ` Also: ${oneLine(context.extra)}` : ''
  const parts = (note: string) =>
    [
      `Monstruito just prepared ${where}: ${gitLine(context.git)}. ${failed}`,
      'Get this project ready for me to pick up the next item, then stop and wait for me.',
      "1) Upgrade the dependencies to the newest versions their declared ranges allow, design systems, fonts and UI libraries included, and run the project's checks or build if it has them; roll back any upgrade that breaks something.",
      '2) Update the plugins the project uses (for example Claude Code, framework or design tool plugins) with their own update commands.',
      "3) Clean up only what the tools regenerate, such as caches and build output, with the project's own scripts.",
      '4) Fix what failed above, if you can.',
      `5) Find the next item. ${note}${requests} Otherwise look at open branches, TODOs and recent commits.${propose}`,
      'Never delete my files, commit, push, reset or stash without asking me first.',
      `When you are done, write ${READY_NOTE}: what you updated, what you fixed, what is left, and a line "Next: <the next item>".${extra}`
    ].join(' ')
  const noNote = 'There is no note from last time.'
  if (!context.note) return clip(oneLine(parts(noNote)), MAX)
  // La nota es lo primero que se recorta si no cabe todo.
  const room = MAX - oneLine(parts('')).length - 80
  const note = room > 80 ? `My note from last time (${NEXT_NOTE}) says: "${clip(oneLine(context.note), room)}".` : noNote
  return clip(oneLine(parts(note)), MAX)
}

export const WRAP_PROMPT = oneLine(`Monstruito is wrapping up the day. Write ${NEXT_NOTE} for tomorrow: where we stopped,
  anything left half done, and a line "Next: <the next item>". Keep it short, and don't commit, push or
  change anything else.`)
