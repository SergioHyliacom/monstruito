// Una ejecución: por cada proyecto marcado, con sus ajustes efectivos, git → dependencias →
// comandos de preparación → demás worktrees → agente → comandos en pestaña → abrir la web.
import type { HostMethods } from 'orca/host'
import type { OrcaWorkerApi } from 'orca/worker'
import { waitForWeb, type ModelLauncher, type WebOpener } from './cli'
import { commandLabel, commandTitle, shouldRun } from './commands'
import {
  installCommands,
  lastLines,
  missingInstallCommands,
  runInstalls,
  type Exists,
  type ReadText,
  type ShellRunner
} from './deps'
import { behindCount, syncProject, type GitRunner } from './git'
import type {
  AgentOutcome,
  CommandDef,
  CommandOutcome,
  GitOutcome,
  GlobalSettings,
  ProjectOverride,
  ProjectResult,
  ProgressStep,
  ProjectSettings
} from './protocol'
import {
  DEFAULT_SUMMARY_FETCHED,
  DEFAULT_SUMMARY_UPDATED,
  effectiveSettings,
  modelSupport,
  promptVariables,
  renderPrompt
} from './settings'

type Host = OrcaWorkerApi['host']
type Workspace = HostMethods['workspace.list']['result']['workspaces'][number]
type ResumableAgent = HostMethods['agent.resume']['params']['agent']

export type Project = { id: string; name: string; path: string; kind: 'git' | 'folder' }

export type RunDeps = {
  host: Host
  git: GitRunner
  shell: ShellRunner
  readText: ReadText
  log: (message: string) => void
  sleep: (ms: number) => Promise<void>
  /** Detener: corta git y las instalaciones en marcha y no empieza nada nuevo. */
  signal?: AbortSignal
  /** Los proyectos que se van a procesar, antes de empezar. */
  started?: (projects: Project[]) => void
  /** Cada paso de cada proyecto, para el avance en vivo. */
  report?: (project: Project, step: ProgressStep | 'done') => void
  /** Abre el agente con modelo, por la CLI de Orca. Sin él, el modelo se ignora. */
  launchWithModel?: ModelLauncher
  /** Para «Instalar si faltan»: si existe un archivo o carpeta. */
  exists?: Exists
  /** Para «Abrir la web»: puertos del workspace y navegador de Orca. */
  web?: WebOpener
  /** Cada pestaña de comando que se abre, para poder cerrarlas luego todas. */
  terminalOpened?: (terminal: { terminalId: string; title: string; project: string }) => void
}

/** Un comando de preparación se corta a los 15 minutos, como una instalación. */
const PREPARE_TIMEOUT = 15 * 60_000

/** Agentes que Orca sabe retomar por id de sesión. */
const RESUMABLE = new Set([
  'claude', 'codebuddy', 'codex', 'qoder', 'qoder-cn', 'qwen-code', 'antigravity', 'opencode',
  'opencode2', 'pi', 'mimo-code', 'droid', 'grok', 'devin', 'omp', 'prime-agent', 'copilot',
  'cursor', 'kimi', 'muse', 'zcode', 'dsh', 'jcode', 'kiro', 'hermes'
])

/** Orca escribe la misma ruta con `\` o con `/` según de dónde venga. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Los proyectos de este equipo, por nombre. */
export async function listLocalProjects(host: Host): Promise<Project[]> {
  const { projects } = await host.call('project.list')
  return projects
    .filter((project) => (project.hostId ?? 'local') === 'local')
    .map((project) => ({ id: project.id, name: project.name, path: project.path, kind: project.kind }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
}

/** La última actividad en Orca de cada proyecto: la más reciente de todos sus workspaces. */
export async function lastUsedByProject(host: Host): Promise<Map<string, number>> {
  const { workspaces } = await host.call('workspace.list', { includeStatus: true })
  const lastUsed = new Map<string, number>()
  for (const workspace of workspaces) {
    const at = workspace.status?.lastActivityAt
    // Orca pone 0, no null, en los workspaces que nunca han tenido actividad.
    if (!workspace.projectId || typeof at !== 'number' || at <= 0) continue
    lastUsed.set(workspace.projectId, Math.max(lastUsed.get(workspace.projectId) ?? 0, at))
  }
  return lastUsed
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(lanes)
  return results
}

/** Pone en fila las aperturas de agentes, con una espera entre una y la siguiente. */
export function createGate(delayMs: number, sleep: (ms: number) => Promise<void>) {
  let queue: Promise<unknown> = Promise.resolve()
  let first = true
  return <T>(task: () => Promise<T>): Promise<T> => {
    const turn = queue.then(async () => {
      if (!first && delayMs > 0) await sleep(delayMs)
      first = false
      return task()
    })
    queue = turn.catch(() => undefined)
    return turn
  }
}
type Gate = ReturnType<typeof createGate>

function shortBranch(branch: string | null): string | null {
  return branch ? branch.replace(/^refs\/heads\//, '') : null
}

function newCommits(git: GitOutcome): number {
  return git.kind === 'updated' || git.kind === 'fetched' ? git.count : 0
}

export function buildPrompt(settings: ProjectSettings, git: GitOutcome, project: string, branch: string | null): string | undefined {
  const variables = promptVariables(project, branch, git)
  if (settings.mode === 'prompt') {
    return settings.prompt.trim() ? renderPrompt(settings.prompt, variables) : undefined
  }
  if (settings.mode === 'summarize' && newCommits(git) > 0) {
    const template = settings.prompt.trim()
      ? settings.prompt
      : git.kind === 'fetched'
        ? DEFAULT_SUMMARY_FETCHED
        : DEFAULT_SUMMARY_UPDATED
    return renderPrompt(template, variables)
  }
  return undefined
}

async function startAgent(
  host: Host,
  workspace: Workspace,
  project: Project,
  settings: ProjectSettings,
  git: GitOutcome,
  gate: Gate,
  launchWithModel: ModelLauncher | undefined
): Promise<AgentOutcome> {
  if (settings.mode === 'none') return { kind: 'disabled' }
  if (settings.onlyWithCommits && newCommits(git) === 0) return { kind: 'no-commits' }
  const agent = settings.agent

  const { agents } = await host.call('agents.list', { workspaceId: workspace.id })
  if (agents.some((open) => open.agent === agent)) return { kind: 'already-open', agent }

  if (settings.mode === 'resume' && RESUMABLE.has(agent)) {
    const { sessions } = await host.call('agent.listSessions', { workspaceId: workspace.id, limit: 20 })
    const own = sessions.filter((session) => session.agent === agent)
    if (own.some((session) => session.running)) return { kind: 'already-open', agent }
    const latest = own[0]
    if (latest) {
      const resumed = await gate(() =>
        host.call('agent.resume', {
          workspaceId: workspace.id,
          agent: agent as ResumableAgent,
          sessionId: latest.sessionId
        })
      )
      return resumed.started ? { kind: 'resumed', agent, title: latest.title } : { kind: 'already-open', agent }
    }
    // Sin sesiones anteriores: se abre uno nuevo.
  }

  const prompt = buildPrompt(settings, git, project.name, shortBranch(workspace.branch))
  const support = modelSupport(agent)
  const model = settings.model.trim()
  if (model && support && launchWithModel) {
    // Con modelo, por la CLI de Orca: la API de plugins no deja elegirlo.
    await gate(() =>
      launchWithModel({
        path: workspace.path,
        agent,
        model,
        effort: support.effort && settings.effort ? settings.effort : undefined,
        prompt
      })
    )
    return { kind: 'launched', agent, withPrompt: prompt !== undefined, model }
  }
  await gate(() =>
    host.call('agent.launch', prompt ? { workspaceId: workspace.id, agent, prompt } : { workspaceId: workspace.id, agent })
  )
  return { kind: 'launched', agent, withPrompt: prompt !== undefined }
}

/**
 * Abre el comando en su pestaña. Si ya hay una con su título, la deja, o con «reiniciar» la cierra
 * y abre otra (solo puede cerrar las que abrió Monstruito). `beforeOpen` corre justo antes de
 * abrirla: ahí se apuntan los puertos que ya había, para reconocer luego el del servidor.
 */
async function openCommandTab(
  deps: RunDeps,
  project: Project,
  workspaceId: string,
  command: CommandDef,
  beforeOpen: () => Promise<void>
): Promise<CommandOutcome> {
  const name = commandLabel(command)
  const title = commandTitle(command)
  try {
    const { terminals } = await deps.host.call('terminal.list', { workspaceId })
    const open = terminals.filter((terminal) => terminal.title === title)
    if (open.length > 0) {
      if (!command.restart) return { name, kind: 'tab', result: 'already-open' }
      try {
        for (const terminal of open) await deps.host.call('terminal.close', { terminalId: terminal.id })
      } catch {
        return {
          name,
          kind: 'tab',
          result: 'already-open',
          message: 'No se pudo reiniciar: esa pestaña no la abrió Monstruito.'
        }
      }
      // Que el servidor anterior suelte su puerto antes de mirar cuáles hay.
      await deps.sleep(1500)
    }
    await beforeOpen()
    const { terminalId } = await deps.host.call('terminal.create', { workspaceId, title, command: command.command })
    deps.terminalOpened?.({ terminalId, title, project: project.name })
    return { name, kind: 'tab', result: open.length > 0 ? 'restarted' : 'opened' }
  } catch (error) {
    return { name, kind: 'tab', result: 'failed', message: errorMessage(error) }
  }
}

/** Un comando de preparación: en segundo plano, en la carpeta del proyecto, esperando a que acabe. */
async function runPrepare(deps: RunDeps, project: Project, command: CommandDef): Promise<CommandOutcome> {
  const name = commandLabel(command)
  const outcome = await deps.shell(project.path, command.command, PREPARE_TIMEOUT, deps.signal)
  return outcome.ok
    ? { name, kind: 'prepare', result: 'ok' }
    : { name, kind: 'prepare', result: 'failed', message: lastLines(outcome.output, 3) || 'falló sin salida' }
}

async function runProject(
  deps: RunDeps,
  project: Project,
  workspaces: Workspace[],
  settings: ProjectSettings,
  commands: CommandDef[],
  gate: Gate
): Promise<ProjectResult> {
  // El checkout principal: el workspace del proyecto que está en su misma carpeta.
  const main = workspaces.find(
    (row) => row.projectId === project.id && normalizePath(row.path) === normalizePath(project.path)
  )
  const signal = deps.signal
  const stopped = () => signal?.aborted === true
  const git: GitRunner = (cwd, args, timeoutMs) => deps.git(cwd, args, timeoutMs, signal)
  const step = (name: ProgressStep) => deps.report?.(project, name)

  const result: ProjectResult = {
    projectId: project.id,
    name: project.name,
    path: project.path,
    git: { kind: 'skipped' },
    agent: { kind: 'cancelled' },
    deps: [],
    commands: [],
    worktrees: []
  }
  // Detener: lo que ya se hizo se cuenta; lo que falta, no se empieza.
  const cancelled = (): ProjectResult => {
    deps.log(`${project.name}: detenido`)
    return result
  }
  if (stopped()) return { ...result, git: { kind: 'cancelled' } }

  let changedFiles: string[] = []
  if (settings.gitMode !== 'none' && project.kind === 'git') {
    step('git')
    try {
      const synced = await syncProject(git, project.path, {
        mode: settings.gitMode,
        fetchAll: settings.fetchAll,
        skipIfDirty: settings.skipIfDirty,
        updateSubmodules: settings.updateSubmodules
      })
      result.git = synced.outcome
      changedFiles = synced.changedFiles
    } catch (error) {
      result.git = { kind: 'failed', step: 'git', message: errorMessage(error) }
    }
    if (stopped()) {
      // Un git cortado a medias falla; se cuenta como detenido salvo que ya hubiera avanzado.
      if (result.git.kind !== 'updated') result.git = { kind: 'cancelled' }
      return cancelled()
    }
  }

  // Dependencias: las que cambió git y las que faltan, cada una una sola vez.
  const installs = new Set<string>()
  if (settings.installDeps && result.git.kind === 'updated') {
    for (const command of await installCommands(changedFiles, project.path, deps.readText)) installs.add(command)
  }
  if (settings.installMissing && deps.exists) {
    for (const command of await missingInstallCommands(project.path, deps.exists, deps.readText)) installs.add(command)
  }
  if (installs.size > 0) {
    step('deps')
    result.deps = await runInstalls(deps.shell, project.path, [...installs], signal)
    if (stopped()) return cancelled()
  }

  // Comandos: los que no tocan se apuntan con el motivo; los de preparación se esperan ya.
  const toRun = settings.runCommands ? commands : []
  const tabs: CommandDef[] = []
  for (const command of toRun) {
    const decision = shouldRun(command, result.git, changedFiles)
    if (!decision.run) {
      result.commands.push({ name: commandLabel(command), kind: command.kind, result: 'skipped', message: decision.reason })
    } else if (command.kind === 'tab') {
      tabs.push(command)
    } else {
      step('prepare')
      result.commands.push(await runPrepare(deps, project, command))
      if (stopped()) return cancelled()
    }
  }

  if (settings.fetchOtherWorktrees && ['updated', 'fetched', 'up-to-date'].includes(result.git.kind)) {
    step('worktrees')
    const others = workspaces.filter(
      (row) => row.projectId === project.id && row.kind === 'worktree' && row !== main
    )
    result.worktrees = await Promise.all(
      others.map(async (row) => ({
        name: row.name,
        branch: shortBranch(row.branch),
        behind: await behindCount(git, row.path).catch(() => null)
      }))
    )
    if (stopped()) return cancelled()
  }

  step('agent')
  result.agent = main
    ? await startAgent(deps.host, main, project, settings, result.git, gate, deps.launchWithModel).catch(
        (error): AgentOutcome => ({ kind: 'failed', message: errorMessage(error) })
      )
    : { kind: 'no-workspace' }
  if (stopped()) return cancelled()

  for (const command of tabs) {
    if (stopped()) return cancelled()
    if (!main) {
      result.commands.push({ name: commandLabel(command), kind: 'tab', result: 'failed', message: 'Sin workspace en Orca.' })
      continue
    }
    step('command')
    const web = command.openUrl ? deps.web : undefined
    const snapshot: { ports: Set<number> | null } = { ports: null }
    const outcome = await openCommandTab(deps, project, main.id, command, async () => {
      if (web) snapshot.ports = new Set((await web.ports(main.path).catch(() => [])).map((item) => item.port))
    })
    if (web && snapshot.ports && (outcome.result === 'opened' || outcome.result === 'restarted')) {
      step('web')
      try {
        outcome.url = await waitForWeb(web, main.path, snapshot.ports, { signal, sleep: deps.sleep })
      } catch (error) {
        if (!stopped()) outcome.message = `La web no se abrió: ${errorMessage(error)}`
      }
    }
    result.commands.push(outcome)
  }

  deps.log(`${project.name}: git ${result.git.kind}, agente ${result.agent.kind}`)
  return result
}

export async function runProjects(
  deps: RunDeps,
  input: {
    selection: string[]
    global: GlobalSettings
    overrides: Record<string, ProjectOverride>
    commands?: Record<string, CommandDef[]>
  }
): Promise<{ results: ProjectResult[]; missing: string[] }> {
  const projects = await listLocalProjects(deps.host)
  const byId = new Map(projects.map((project) => [project.id, project]))
  const chosen = input.selection.flatMap((id) => byId.get(id) ?? [])
  const missing = input.selection.filter((id) => !byId.has(id))
  const { workspaces } = await deps.host.call('workspace.list')
  const gate = createGate(input.global.staggerSeconds * 1000, deps.sleep)

  deps.started?.(chosen)
  const results = await mapLimit(chosen, input.global.concurrency, async (project) => {
    try {
      return await runProject(
        deps,
        project,
        workspaces,
        effectiveSettings(input.global, input.overrides[project.id]),
        input.commands?.[project.id] ?? [],
        gate
      )
    } finally {
      deps.report?.(project, 'done')
    }
  })
  return { results, missing }
}
