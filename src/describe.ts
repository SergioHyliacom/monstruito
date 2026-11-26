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
      const text = plural(git.count, 'commit nuevo', 'commits nuevos')
      if (git.submodules && !git.submodules.ok) {
        return { text, tone: 'warning', detail: `Submódulos: ${git.submodules.message ?? 'fallaron'}` }
      }
      return { text, tone: 'success' }
    }
    case 'fetched':
      return {
        text: `${plural(git.count, 'commit', 'commits')} por traer`,
        tone: 'accent',
        detail: 'Descargados sin mover la rama.'
      }
    case 'up-to-date':
      return { text: 'Al día', tone: 'neutral' }
    case 'no-upstream':
      return {
        text: 'Sin rama remota',
        tone: 'warning',
        detail: 'La rama actual no sigue a ninguna remota, así que no se ha traído nada.'
      }
    case 'dirty':
      return {
        text: 'Cambios sin commitear',
        tone: 'warning',
        detail: 'No se ha traído nada para no mezclarlo con tu trabajo.'
      }
    case 'failed':
      return {
        text:
          git.step === 'fetch'
            ? 'No se pudo descargar'
            : git.step === 'merge'
              ? 'No se pudo avanzar'
              : 'Error de git',
        tone: 'danger',
        detail: git.message
      }
    case 'skipped':
      return { text: 'Sin git', tone: 'neutral' }
    case 'cancelled':
      return { text: 'Detenido', tone: 'neutral' }
  }
}

export function describeAgent(agent: AgentOutcome): Described {
  switch (agent.kind) {
    case 'launched': {
      const name = agent.model
        ? `${agentLabel(agent.agent)} (${modelLabel(agent.agent, agent.model)})`
        : agentLabel(agent.agent)
      return { text: agent.withPrompt ? `${name} con prompt` : `${name} abierto`, tone: 'success' }
    }
    case 'resumed':
      return { text: 'Sesión retomada', tone: 'success', detail: agent.title }
    case 'already-open':
      return { text: `${agentLabel(agent.agent)} ya estaba abierto`, tone: 'neutral' }
    case 'no-commits':
      return { text: 'Sin commits: agente no abierto', tone: 'neutral' }
    case 'disabled':
      return { text: 'Sin agente', tone: 'neutral' }
    case 'no-workspace':
      return {
        text: 'Sin workspace en Orca',
        tone: 'warning',
        detail: 'Orca no tiene abierto el checkout principal de este proyecto.'
      }
    case 'failed':
      return { text: 'El agente no arrancó', tone: 'danger', detail: agent.message }
    case 'cancelled':
      return { text: 'Agente no abierto: detenido', tone: 'neutral' }
  }
}

const STEP_TEXT: Record<ProgressStep, string> = {
  waiting: 'en cola',
  git: 'trayendo cambios',
  deps: 'instalando dependencias',
  prepare: 'ejecutando la preparación',
  worktrees: 'mirando worktrees',
  agent: 'abriendo el agente',
  command: 'abriendo sus comandos',
  web: 'esperando a que la web esté lista'
}

export function describeProgress(progress: Progress): { title: string; lines: string[]; percent: number } {
  const what = progress.kind === 'run' ? 'Arrancando' : 'Revisando commits'
  const title = progress.stopping
    ? 'Deteniendo…'
    : `${what}: ${progress.done} de ${plural(progress.total, 'proyecto', 'proyectos')}`
  return {
    title,
    lines: progress.active.map((item) => `${item.name}: ${STEP_TEXT[item.step]}`),
    percent: progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  }
}

const dateFormat = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit'
})

/** Título y resumen de una ejecución del historial. */
export function describeHistoryEntry(run: RunRecord): { title: string; summary: string } {
  const how = run.trigger === 'startup' ? 'Al abrir Orca' : 'A mano'
  const problems = run.results.filter(isProblem).length
  const parts = [plural(run.results.length, 'proyecto', 'proyectos')]
  if (run.profile) parts.unshift(run.profile)
  if (problems > 0) parts.push(`${problems} con problemas`)
  if (run.stopped) parts.push('detenida')
  return { title: `${how} · ${dateFormat.format(new Date(run.finishedAt))}`, summary: parts.join(' · ') }
}

export function describeStep(step: StepOutcome): Described {
  switch (step.kind) {
    case 'ok':
      return { text: `${step.command} ✓`, tone: 'success' }
    case 'opened':
      return { text: `${step.command} abierto`, tone: 'success' }
    case 'already-open':
      return { text: `${step.command} ya estaba abierto`, tone: 'neutral' }
    case 'failed':
      return { text: `${step.command} falló`, tone: 'danger', detail: step.message }
  }
}

export function describeCommand(command: CommandOutcome): Described {
  const detail = [command.url ? `Abierta ${command.url}` : '', command.message ?? ''].filter(Boolean).join(' · ') || undefined
  switch (command.result) {
    case 'ok':
      return { text: `${command.name} ✓`, tone: 'success', detail }
    case 'opened':
      return { text: `${command.name} abierto`, tone: command.message ? 'warning' : 'success', detail }
    case 'restarted':
      return { text: `${command.name} reiniciado`, tone: command.message ? 'warning' : 'success', detail }
    case 'already-open':
      return { text: `${command.name} ya estaba abierto`, tone: 'neutral', detail }
    case 'skipped':
      return { text: `${command.name}: no tocaba`, tone: 'neutral', detail }
    case 'failed':
      return { text: `${command.name} falló`, tone: 'danger', detail }
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
      if (worktree.behind === null) return `${name} sin remota`
      return worktree.behind === 0 ? `${name} al día` : `${name} ${worktree.behind} por detrás`
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
    lines.push(`${run.missing.length} proyecto(s) marcado(s) ya no están en Orca.`)
  }
  if (run.stopped) lines.push('Se detuvo antes de terminar.')
  if (run.opened) lines.push(`Al terminar se mostró ${run.opened}.`)
  return lines.length > 0 ? lines.join('\n') : 'No había proyectos marcados.'
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
    return { text: 'Monstruito: detenido', icon: 'warning', tone: 'warning', tooltip: describeRun(run) }
  }
  return problems > 0 || run.missing.length > 0
    ? { text: `Monstruito: ${ok}/${total}`, icon: 'warning', tone: 'warning', tooltip: describeRun(run) }
    : { text: `Monstruito: ${total} al día`, icon: 'check', tone: 'success', tooltip: describeRun(run) }
}

/** La notificación de escritorio al terminar una ejecución. */
export function notificationFor(run: RunRecord): { title: string; body: string } {
  const total = run.results.length
  const withCommits = run.results.filter((result) => result.git.kind === 'updated' || result.git.kind === 'fetched')
  const problems = run.results.filter(isProblem)
  const parts = [plural(total, 'proyecto', 'proyectos')]
  if (run.profile) parts.unshift(run.profile)
  if (run.stopped) parts.push('detenido')
  if (withCommits.length > 0) parts.push(`${withCommits.length} con commits nuevos`)
  if (problems.length > 0) parts.push(`${problems.length} con problemas: ${problems.map((p) => p.name).join(', ')}`)
  else parts.push('sin problemas')
  return { title: 'Monstruito', body: parts.join(' · ') }
}

export function statusForPending(pending: PendingCheck): {
  text: string
  icon: 'download' | 'check' | 'warning'
  tone: 'accent' | 'success' | 'warning'
  tooltip: string
} {
  const time = new Date(pending.checkedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  const lines = pending.projects.map((project) => `${project.name}: ${plural(project.count, 'commit', 'commits')} por traer`)
  if (pending.failed > 0) lines.push(`${pending.failed} proyecto(s) no se pudieron revisar.`)
  lines.push(`Revisado a las ${time}. Pulsa para traerlos.`)
  if (pending.projects.length > 0) {
    return {
      text: `Monstruito: ${plural(pending.projects.length, 'proyecto', 'proyectos')} con cambios`,
      icon: 'download',
      tone: 'accent',
      tooltip: lines.join('\n')
    }
  }
  return pending.failed > 0
    ? { text: 'Monstruito: revisión con fallos', icon: 'warning', tone: 'warning', tooltip: lines.join('\n') }
    : { text: 'Monstruito: al día', icon: 'check', tone: 'success', tooltip: lines.join('\n') }
}

/** Una frase con lo que hará el arranque, para el panel. */
export function describePlan(settings: GlobalSettings, selected: number, withCommands = 0): string {
  const when = settings.runOnStartup ? 'Al abrir Orca' : 'Al pulsar Ejecutar ahora'
  const steps: string[] = []
  if (settings.gitMode === 'pull') steps.push('trae los cambios de git')
  if (settings.gitMode === 'fetch') steps.push('descarga los cambios sin mover la rama')
  if (settings.mode !== 'none') {
    const agent = settings.model
      ? `${agentLabel(settings.agent)} (${modelLabel(settings.agent, settings.model)})`
      : agentLabel(settings.agent)
    steps.push(settings.onlyWithCommits ? `abre ${agent} donde haya commits nuevos` : `abre ${agent}`)
  }
  if (settings.runCommands && withCommands > 0) {
    steps.push(`lanza los comandos de ${plural(withCommands, 'proyecto', 'proyectos')}`)
  }
  const what = steps.length > 0 ? steps.join(', ') : 'no hace nada'
  return `${when} ${what} en ${plural(selected, 'proyecto marcado', 'proyectos marcados')}, salvo lo que cambies en cada proyecto.`
}
