// Textos que ven las personas: los usan el panel y el worker (barra de estado, comando y avisos).
// Sin dependencias de Node, para que el panel también pueda importarlo.
import type {
  AgentOutcome,
  GitOutcome,
  GlobalSettings,
  CommandOutcome,
  PendingCheck,
  Progress,
  ProgressStep,
  ProjectResult,
  RunRecord,
  StepOutcome,
  WorktreeStatus
} from './protocol'
import { agentLabel, modelLabel } from './settings'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type Described = { text: string; tone: Tone; detail?: string }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function describeGit(git: GitOutcome): Described {
  switch (git.kind) {
    case 'updated': {
      const text = plural(git.count, 'new commit', 'new commits')
      const rebased = git.rebased
        ? `Rebased ${plural(git.rebased, 'local commit', 'local commits')} on top of ${git.upstream}.`
        : undefined
      if (git.submodules && !git.submodules.ok) {
        const submodules = `Submodules: ${git.submodules.message ?? 'failed'}`
        return { text, tone: 'warning', detail: rebased ? `${rebased} ${submodules}` : submodules }
      }
      return rebased ? { text, tone: 'success', detail: rebased } : { text, tone: 'success' }
    }
    case 'fetched':
      return {
        text: `${plural(git.count, 'commit', 'commits')} not applied`,
        tone: 'accent',
        detail: 'Already fetched; your branch and files stay as they are until you git pull.'
      }
    case 'up-to-date':
      return { text: 'Up to date', tone: 'neutral' }
    case 'no-upstream':
      return {
        text: 'No upstream',
        tone: 'warning',
        detail: 'The current branch does not track a remote branch, so nothing was pulled.'
      }
    case 'dirty':
      return {
        text: 'Uncommitted changes',
        tone: 'warning',
        detail: 'Nothing was pulled, so it would not get mixed with your work.'
      }
    case 'failed':
      return {
        text:
          git.step === 'fetch'
            ? 'Fetch failed'
            : git.step === 'merge'
              ? 'Could not fast-forward'
              : git.step === 'rebase'
                ? 'Rebase failed'
                : 'Git error',
        tone: 'danger',
        detail: git.message
      }
    case 'skipped':
      return { text: 'No git', tone: 'neutral' }
    case 'cancelled':
      return { text: 'Stopped', tone: 'neutral' }
  }
}

/**
 * La etiqueta de git de la última ejecución según cómo está la rama ahora (`behindNow`, mirado en
 * local): si los commits que quedaron sin aplicar se aplicaron después, a mano, deja de pedirlos.
 */
export function describeGitNow(git: GitOutcome, behindNow: number | undefined): Described {
  if (git.kind !== 'fetched' || behindNow === undefined || behindNow === git.count) return describeGit(git)
  if (behindNow === 0) {
    return {
      text: 'Up to date now',
      tone: 'success',
      detail: `The ${plural(git.count, 'commit', 'commits')} this run left unapplied are in your branch now.`
    }
  }
  return describeGit({ ...git, count: behindNow })
}

/** Los commits locales que no están en la remota, si se contaron y hay alguno. */
export function describeAhead(git: GitOutcome): Described | null {
  const ahead = 'ahead' in git ? git.ahead : undefined
  if (!ahead) return null
  return {
    text: plural(ahead, 'unpushed commit', 'unpushed commits'),
    tone: 'warning',
    detail: 'They are only in your local branch: git push to share them.'
  }
}

export function describeAgent(agent: AgentOutcome): Described {
  switch (agent.kind) {
    case 'launched': {
      const name = agent.model
        ? `${agentLabel(agent.agent)} (${modelLabel(agent.agent, agent.model)})`
        : agentLabel(agent.agent)
      return { text: agent.withPrompt ? `${name} with prompt` : `${name} opened`, tone: 'success' }
    }
    case 'resumed':
      return { text: 'Session resumed', tone: 'success', detail: agent.title }
    case 'already-open':
      return { text: `${agentLabel(agent.agent)} already open`, tone: 'neutral' }
    case 'no-commits':
      return { text: 'No commits: agent not opened', tone: 'neutral' }
    case 'disabled':
      return { text: 'No agent', tone: 'neutral' }
    case 'no-workspace':
      return {
        text: 'No workspace in Orca',
        tone: 'warning',
        detail: "Orca does not have this project's main checkout open."
      }
    case 'failed':
      return { text: 'The agent did not start', tone: 'danger', detail: agent.message }
    case 'cancelled':
      return { text: 'Agent not opened: stopped', tone: 'neutral' }
  }
}

const STEP_TEXT: Record<ProgressStep, string> = {
  waiting: 'queued',
  git: 'pulling changes',
  deps: 'installing dependencies',
  prepare: 'running setup commands',
  worktrees: 'checking worktrees',
  agent: 'opening the agent',
  command: 'opening its commands',
  web: 'waiting for the web page to be ready'
}

export function describeProgress(progress: Progress): { title: string; lines: string[]; percent: number } {
  const what = progress.kind === 'run' ? 'Starting' : 'Checking commits'
  const title = progress.stopping
    ? 'Stopping…'
    : `${what}: ${progress.done} of ${plural(progress.total, 'project', 'projects')}`
  return {
    title,
    lines: progress.active.map((item) => `${item.name}: ${STEP_TEXT[item.step]}`),
    percent: progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  }
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
})

/** Título y resumen de una ejecución del historial. */
export function describeHistoryEntry(run: RunRecord): { title: string; summary: string } {
  const how = run.trigger === 'startup' ? 'When Orca opened' : 'Manual'
  const problems = run.results.filter(isProblem).length
  const parts = [plural(run.results.length, 'project', 'projects')]
  if (run.profile) parts.unshift(run.profile)
  if (problems > 0) parts.push(`${problems} with problems`)
  if (run.stopped) parts.push('stopped')
  return { title: `${how} · ${dateFormat.format(new Date(run.finishedAt))}`, summary: parts.join(' · ') }
}

export function describeStep(step: StepOutcome): Described {
  switch (step.kind) {
    case 'ok':
      return { text: `${step.command} ✓`, tone: 'success' }
    case 'opened':
      return { text: `${step.command} opened`, tone: 'success' }
    case 'already-open':
      return { text: `${step.command} already open`, tone: 'neutral' }
    case 'failed':
      return { text: `${step.command} failed`, tone: 'danger', detail: step.message }
  }
}

export function describeCommand(command: CommandOutcome): Described {
  const detail = [command.url ? `Opened ${command.url}` : '', command.message ?? ''].filter(Boolean).join(' · ') || undefined
  switch (command.result) {
    case 'ok':
      return { text: `${command.name} ✓`, tone: 'success', detail }
    case 'opened':
      return { text: `${command.name} opened`, tone: command.message ? 'warning' : 'success', detail }
    case 'restarted':
      return { text: `${command.name} restarted`, tone: command.message ? 'warning' : 'success', detail }
    case 'already-open':
      return { text: `${command.name} already open`, tone: 'neutral', detail }
    case 'skipped':
      return { text: `${command.name}: skipped`, tone: 'neutral', detail }
    case 'failed':
      return { text: `${command.name} failed`, tone: 'danger', detail }
  }
}

/** Lo que se ve de un resultado: los comandos que no tocaban no ocupan sitio. */
export function visibleCommands(result: ProjectResult): Described[] {
  const commands = (result.commands ?? []).filter((command) => command.result !== 'skipped').map(describeCommand)
  if (result.startCommand) commands.push(describeStep(result.startCommand))
  return commands
}

export function describeWorktrees(worktrees: WorktreeStatus[]): string | undefined {
  if (worktrees.length === 0) return undefined
  return `Worktrees: ${worktrees
    .map((worktree) => {
      const name = worktree.branch ?? worktree.name
      if (worktree.behind === null) return `${name} no upstream`
      return worktree.behind === 0 ? `${name} up to date` : `${name} ${worktree.behind} behind`
    })
    .join(', ')}`
}

export function isProblem(result: ProjectResult): boolean {
  return (
    result.git.kind === 'failed' ||
    result.agent.kind === 'failed' ||
    result.agent.kind === 'no-workspace' ||
    result.deps.some((step) => step.kind === 'failed') ||
    result.startCommand?.kind === 'failed' ||
    (result.commands ?? []).some((command) => command.result === 'failed') ||
    (result.git.kind === 'updated' && result.git.submodules?.ok === false)
  )
}

/** Una línea por proyecto, para la barra de estado y el comando. */
export function describeRun(run: RunRecord): string {
  const lines = run.results.map((result) => {
    const parts = [describeGit(result.git).text, describeAgent(result.agent).text]
    for (const step of result.deps) parts.push(describeStep(step).text)
    for (const command of visibleCommands(result)) parts.push(command.text)
    return `${result.name}: ${parts.join(' · ')}`
  })
  if (run.missing.length > 0) {
    lines.push(`${plural(run.missing.length, 'selected project is', 'selected projects are')} no longer in Orca.`)
  }
  if (run.stopped) lines.push('Stopped before finishing.')
  if (run.opened) lines.push(`Showed ${run.opened} at the end.`)
  return lines.length > 0 ? lines.join('\n') : 'No projects were selected.'
}

export function statusFor(run: RunRecord): {
  text: string
  icon: 'check' | 'warning'
  tone: 'success' | 'warning'
  tooltip: string
} {
  const problems = run.results.filter(isProblem).length
  const total = run.results.length
  const ok = total - problems
  if (run.stopped) {
    return { text: 'Monstruito: stopped', icon: 'warning', tone: 'warning', tooltip: describeRun(run) }
  }
  return problems > 0 || run.missing.length > 0
    ? { text: `Monstruito: ${ok}/${total}`, icon: 'warning', tone: 'warning', tooltip: describeRun(run) }
    : { text: `Monstruito: ${total} up to date`, icon: 'check', tone: 'success', tooltip: describeRun(run) }
}

/** La notificación de escritorio al terminar una ejecución. */
export function notificationFor(run: RunRecord): { title: string; body: string } {
  const total = run.results.length
  const withCommits = run.results.filter((result) => result.git.kind === 'updated' || result.git.kind === 'fetched')
  const problems = run.results.filter(isProblem)
  const parts = [plural(total, 'project', 'projects')]
  if (run.profile) parts.unshift(run.profile)
  if (run.stopped) parts.push('stopped')
  if (withCommits.length > 0) parts.push(`${withCommits.length} with new commits`)
  if (problems.length > 0) parts.push(`${problems.length} with problems: ${problems.map((p) => p.name).join(', ')}`)
  else parts.push('no problems')
  return { title: 'Monstruito', body: parts.join(' · ') }
}

/**
 * Qué hacer con los commits sin aplicar de la última revisión. Ejecutar ahora solo los aplica
 * en los proyectos que avanzan la rama; los de solo descargar necesitan un git pull a mano.
 */
export function pendingHint(projects: PendingCheck['projects'], where: 'panel' | 'status'): string {
  const fetchOnly = projects.filter((project) => project.fetchOnly).length
  if (fetchOnly === projects.length) return 'Already fetched; apply them with git pull.'
  if (fetchOnly === 0) return where === 'panel' ? 'Run now applies them.' : 'Click to apply them.'
  const run = where === 'panel' ? 'Run now applies' : 'Click to apply'
  return `${run} the rest; the fetch-only ones, with git pull.`
}

export function statusForPending(pending: PendingCheck): {
  text: string
  icon: 'download' | 'check' | 'warning'
  tone: 'accent' | 'success' | 'warning'
  tooltip: string
} {
  const time = new Date(pending.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const lines = pending.projects.map(
    (project) =>
      `${project.name}: ${plural(project.count, 'commit', 'commits')} not applied${project.fetchOnly ? ' (fetch only)' : ''}`
  )
  if (pending.failed > 0) lines.push(`${plural(pending.failed, 'project', 'projects')} could not be checked.`)
  lines.push(
    pending.projects.length > 0
      ? `Checked at ${time}. ${pendingHint(pending.projects, 'status')}`
      : `Checked at ${time}.`
  )
  if (pending.projects.length > 0) {
    return {
      text: `Monstruito: ${plural(pending.projects.length, 'project', 'projects')} with changes`,
      icon: 'download',
      tone: 'accent',
      tooltip: lines.join('\n')
    }
  }
  return pending.failed > 0
    ? { text: 'Monstruito: check failed', icon: 'warning', tone: 'warning', tooltip: lines.join('\n') }
    : { text: 'Monstruito: up to date', icon: 'check', tone: 'success', tooltip: lines.join('\n') }
}

/** Una frase con lo que hará el arranque, para el panel. */
export function describePlan(settings: GlobalSettings, selected: number, withCommands = 0): string {
  const when = settings.runOnStartup ? 'When Orca opens' : 'When you press Run now'
  const steps: string[] = []
  if (settings.gitMode === 'pull') steps.push('pulls the git changes')
  if (settings.gitMode === 'fetch') steps.push('fetches the changes without moving the branch')
  if (settings.mode !== 'none') {
    const agent = settings.model
      ? `${agentLabel(settings.agent)} (${modelLabel(settings.agent, settings.model)})`
      : agentLabel(settings.agent)
    steps.push(settings.onlyWithCommits ? `opens ${agent} where there are new commits` : `opens ${agent}`)
  }
  if (settings.runCommands && withCommands > 0) {
    steps.push(`runs the commands of ${plural(withCommands, 'project', 'projects')}`)
  }
  const what = steps.length > 1 ? `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}` : (steps[0] ?? 'does nothing')
  return `${when}, it ${what} in ${plural(selected, 'selected project', 'selected projects')}, except where a project has its own settings.`
}
