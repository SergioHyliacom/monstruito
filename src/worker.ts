// El worker del plugin. Como el manifiesto declara un elemento en la barra de estado, Orca lo
// arranca en cuanto el plugin está activo, es decir, al abrir Orca, y lo mantiene vivo. Su
// `activate` es por tanto el momento "al abrir Orca".
//
// Un worker también se reinicia sin que Orca se cierre (al guardar un archivo en desarrollo, si
// se cae, al reactivar el plugin). Para no repetir el arranque en esos casos guarda qué proceso
// de Orca lo lanzó: si es el mismo de la última vez y el equipo no se ha reiniciado desde
// entonces, no repite.
import { existsSync } from 'node:fs'
import os from 'node:os'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { createModelLauncher, createOrcaCli, createWebOpener, type ModelLauncher, type WebOpener } from './cli'
import { commandsFromLegacy, sanitizeCommandMap, sanitizeCommands } from './commands'
import { readText as readTextFromDisk, runShell, type Exists, type ReadText, type ShellRunner } from './deps'
import { WRAP_PROMPT } from './brief'
import {
  describeRun,
  describeWrapRun,
  notificationFor,
  notificationForReady,
  notificationForWrap,
  statusFor,
  statusForPending,
  statusForReady,
  statusForWrap
} from './describe'
import { aheadCount, behindCount, checkIncoming, runGit, workingChanges, type GitRunner } from './git'
import {
  diskFiles,
  excludeNotes,
  NEXT_NOTE,
  nextItem,
  notePath,
  readProposedCommands,
  readReady,
  requestsFile,
  type NoteFiles
} from './notes'
import { emptyProfile, findProfile, newProfileId, profileForDay, projectToOpen, sanitizeProfiles } from './profiles'
import { suggestCommands } from './suggest'
import type {
  CommandDef,
  GlobalSettings,
  PanelState,
  PendingCheck,
  Profile,
  ProfilePatch,
  Progress,
  ProjectOverride,
  ReadyNote,
  RunRecord,
  WrapRecord,
  WrapResult
} from './protocol'
import {
  errorMessage,
  lastUsedByProject,
  listLocalProjects,
  mapLimit,
  normalizePath,
  runProjects,
  type OpenedTerminal,
  type Project
} from './run'
import {
  effectiveSettings,
  readGlobalSettings,
  resolveSettings,
  sanitizeOverride,
  sanitizeOverrides,
  sanitizePartialSettings
} from './settings'
import { applyImport, buildExport, parseExport } from './transfer'

const LEGACY_SELECTION = 'selection'
const LEGACY_LAST_RUN = 'lastRun'
const PROFILES = 'profiles'
const ACTIVE_PROFILE = 'activeProfile'
const OVERRIDES = 'overrides'
const COMMANDS = 'commands'
const OPENED = 'openedTerminals'
const HISTORY = 'history'
const PENDING = 'pending'
const SESSION = 'session'
const IMPORT_BACKUP = 'importBackup'
const STATUS = 'status'
const LAST_WRAP = 'lastWrap'
/** Ya se contestó (o no hacía falta) «¿arrancar al abrir Orca?». */
const STARTUP_ASKED = 'startupAsked'
const HISTORY_SIZE = 10
/** Cuánto se espera a que los agentes acaben el brief, y cada cuánto se mira. */
const READY_WAIT_MS = 90 * 60_000
const READY_POLL_MS = 20_000
/** Cuánto se espera la nota de cierre de cada agente, y cada cuánto se mira. */
const NOTE_WAIT_MS = 3 * 60_000
const NOTE_POLL_MS = 5_000
/** Un agente que espera o ha terminado: se le puede escribir o cerrar sin cortarle a medias. */
const IDLE = new Set(['waiting', 'done'])

export type WorkerDeps = {
  git: GitRunner
  shell: ShellRunner
  readText: ReadText
  /** Abre el agente con modelo por la CLI de Orca. */
  launchWithModel: ModelLauncher
  exists: Exists
  /** Puertos y navegador de Orca, por su CLI, para «Abrir la web». */
  web: WebOpener
  /** El proceso de Orca que lanzó este worker: no cambia mientras Orca siga abierto. */
  parentPid: number
  /** Cuándo arrancó el equipo, en milisegundos desde 1970. */
  bootTime: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Al abrir Orca, reintentos mientras aún no lista los proyectos marcados. */
  projectWait: { attempts: number; intervalMs: number }
  /** Las pruebas esperan aquí a que termine lo que se hace al abrir Orca. */
  onStartup?: (task: Promise<void>) => void
  /** Las notas de `.monstruito/` de cada proyecto. */
  notes: NoteFiles
  /** La lista del plugin Requests, para el brief. */
  requestsFile: string
  /** Repite `fn` cada `ms` hasta que se llame a lo que devuelve. */
  every: (ms: number, fn: () => void) => () => void
}

type StatusUpdate = {
  text: string
  icon: 'refresh' | 'check' | 'warning' | 'error' | 'download'
  tone: 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
}

type Backup = {
  profiles: Profile[]
  activeProfileId: string
  overrides: Record<string, ProjectOverride>
  commands?: Record<string, CommandDef[]>
  settings: GlobalSettings
}

function asStrings(value: JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const results = (value as { results?: unknown }).results
  // Las ejecuciones guardadas por la 0.1 no tienen `agent`: se descartan.
  return (
    Array.isArray(results) &&
    results.every((result) => !!result && typeof result === 'object' && !Array.isArray(result) && 'agent' in result)
  )
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

export function createActivate(deps: WorkerDeps) {
  return function activate(orca: OrcaWorkerApi): void {
    let running = false
    let checking = false
    let wrapping = false
    let stopReadyWatch: (() => void) | null = null
    let progress: Progress | null = null
    let controller: AbortController | null = null
    let recheckTimer: ReturnType<typeof setInterval> | null = null
    let recheckEvery = 0
    const log = (message: string) => orca.log(message)

    // ——— Lectura y escritura ———

    const readBase = async (): Promise<GlobalSettings> => readGlobalSettings(await orca.settings.get())
    const readOverrides = async (): Promise<Record<string, ProjectOverride>> =>
      sanitizeOverrides(await orca.storage.get(OVERRIDES))

    /** Los comandos de cada proyecto. La primera vez, el comando único de la 0.3 pasa a la lista. */
    async function readCommands(): Promise<Record<string, CommandDef[]>> {
      const stored = await orca.storage.get(COMMANDS)
      if (stored !== null) return sanitizeCommandMap(stored)
      const legacy = commandsFromLegacy(await orca.storage.get(OVERRIDES))
      await orca.storage.set(COMMANDS, asJson(legacy))
      return legacy
    }

    async function readOpened(): Promise<OpenedTerminal[]> {
      const value = await orca.storage.get(OPENED)
      return Array.isArray(value) ? (value as unknown as OpenedTerminal[]) : []
    }

    async function readProfiles(): Promise<Profile[]> {
      const stored = await orca.storage.get(PROFILES)
      const legacy = stored ? [] : asStrings(await orca.storage.get(LEGACY_SELECTION))
      return sanitizeProfiles(stored, legacy)
    }

    async function readActive(): Promise<{ profiles: Profile[]; profile: Profile }> {
      const profiles = await readProfiles()
      const activeId = await orca.storage.get(ACTIVE_PROFILE)
      return { profiles, profile: findProfile(profiles, typeof activeId === 'string' ? activeId : null) }
    }

    const writeProfiles = (profiles: Profile[]) => orca.storage.set(PROFILES, asJson(profiles))

    async function readHistory(): Promise<RunRecord[]> {
      const stored = await orca.storage.get(HISTORY)
      if (Array.isArray(stored)) return stored.filter(isRunRecord)
      const legacy = await orca.storage.get(LEGACY_LAST_RUN)
      return isRunRecord(legacy) ? [legacy] : []
    }

    async function readWrap(): Promise<WrapRecord | null> {
      const value = await orca.storage.get(LAST_WRAP)
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as unknown as WrapRecord) : null
    }

    /** El resumen de cada proyecto al que se mandó el brief, si ya lo escribió. */
    async function readyNow(record: RunRecord | null): Promise<Record<string, ReadyNote>> {
      const entries = await Promise.all(
        (record?.results ?? []).flatMap((result) =>
          result.brief
            ? [readReady(deps.notes, result.path, result.brief.sentAt).then((note) => [result.projectId, note] as const, () => null)]
            : []
        )
      )
      return Object.fromEntries(entries.filter((entry): entry is readonly [string, ReadyNote] => entry?.[1] != null))
    }

    /** Cuántos comandos propuso el agente en cada proyecto que aún no tiene ninguno. */
    async function proposedNow(record: RunRecord | null, commands: Record<string, CommandDef[]>): Promise<Record<string, number>> {
      const entries = await Promise.all(
        (record?.results ?? []).flatMap((result) =>
          result.brief && !commands[result.projectId]?.length
            ? [readProposedCommands(deps.notes, result.path).then((list) => [result.projectId, list.length] as const, () => null)]
            : []
        )
      )
      return Object.fromEntries(entries.filter((entry): entry is readonly [string, number] => !!entry && entry[1] > 0))
    }

    async function readPending(): Promise<PendingCheck | null> {
      const value = await orca.storage.get(PENDING)
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as unknown as PendingCheck) : null
    }

    async function readLastUsed(): Promise<Map<string, number>> {
      try {
        return await lastUsedByProject(orca.host)
      } catch (error) {
        // Sin fechas el panel sigue funcionando, solo pierde el orden por uso.
        log(`Could not read workspace activity: ${errorMessage(error)}`)
        return new Map()
      }
    }

    /**
     * Cuántos commits va por detrás ahora cada proyecto que tenía commits sin aplicar, en la última
     * ejecución o en la revisión. Solo en local (sin descargar), así que es rápido y ve lo que se
     * aplicó a mano. Durante una ejecución o revisión no se mira: git está ocupado en esos proyectos.
     */
    async function currentBehind(
      lastRun: RunRecord | null,
      pending: PendingCheck | null,
      projects: Project[]
    ): Promise<Record<string, number>> {
      if (running || checking) return {}
      const paths = new Map<string, string>()
      for (const result of lastRun?.results ?? []) {
        if (result.git.kind === 'fetched') paths.set(result.projectId, result.path)
      }
      for (const item of pending?.projects ?? []) {
        const path = projects.find((project) => project.id === item.projectId)?.path
        if (path) paths.set(item.projectId, path)
      }
      const counts = await Promise.all(
        [...paths].map(async ([projectId, path]) => {
          try {
            return [projectId, await behindCount(deps.git, path)] as const
          } catch {
            return [projectId, null] as const
          }
        })
      )
      return Object.fromEntries(counts.filter((entry): entry is readonly [string, number] => entry[1] !== null))
    }

    /** La revisión guardada, con lo que ya se aplicó fuera; si cambia, se guarda y se avisa en la barra. */
    async function refreshPending(pending: PendingCheck | null, now: Record<string, number>): Promise<PendingCheck | null> {
      if (!pending) return null
      const projects = pending.projects
        .map((item) => (item.projectId in now ? { ...item, count: now[item.projectId] } : item))
        .filter((item) => item.count > 0)
      const changed =
        projects.length !== pending.projects.length ||
        projects.some((item, index) => item.count !== pending.projects[index].count)
      if (!changed) return pending
      const next: PendingCheck = { ...pending, projects }
      await orca.storage.set(PENDING, asJson(next))
      await setStatus(statusForPending(next))
      return next
    }

    async function state(): Promise<PanelState> {
      const [base, active, overrides, history, storedPending, projects, lastUsed, backup, commands, opened, lastWrap, asked] =
        await Promise.all([
          readBase(),
          readActive(),
          readOverrides(),
          readHistory(),
          readPending(),
          listLocalProjects(orca.host),
          readLastUsed(),
          orca.storage.get(IMPORT_BACKUP),
          readCommands(),
          readOpened(),
          readWrap(),
          orca.storage.get(STARTUP_ASKED)
        ])
      const lastRun = history[0] ?? null
      const [behindNow, ready, proposed] = await Promise.all([
        currentBehind(lastRun, storedPending, projects),
        readyNow(lastRun),
        proposedNow(lastRun, commands)
      ])
      const pending = await refreshPending(storedPending, behindNow)
      const chosen = new Set(active.profile.selection)
      return {
        baseSettings: base,
        settings: resolveSettings(base, active.profile.settings),
        profiles: active.profiles,
        activeProfileId: active.profile.id,
        overrides,
        commands,
        openedTerminals: opened.filter((terminal) => terminal.kind !== 'agent').length,
        running,
        checking,
        progress,
        history,
        lastRun,
        pending,
        behindNow,
        ready,
        proposed,
        lastWrap,
        wrapping,
        askStartup: asked !== true,
        canUndoImport: backup !== null,
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          path: project.path,
          selected: chosen.has(project.id),
          customized: project.id in overrides,
          lastUsedAt: lastUsed.get(project.id) ?? null
        }))
      }
    }

    // ——— Avisos al panel y a la barra de estado ———

    async function broadcast(): Promise<PanelState | null> {
      try {
        const next = await state()
        orca.panels.post('state.changed', next)
        return next
      } catch (error) {
        log(`Could not notify the panel: ${errorMessage(error)}`)
        return null
      }
    }

    function postProgress(): void {
      // Una copia: `progress` sigue cambiando después de enviarlo.
      orca.panels.post('progress.changed', {
        progress: progress ? { ...progress, active: progress.active.map((item) => ({ ...item })) } : null
      })
    }

    async function setStatus(update: StatusUpdate): Promise<void> {
      try {
        await orca.host.call('statusBar.update', { id: STATUS, ...update })
      } catch (error) {
        log(`Could not update the status bar: ${errorMessage(error)}`)
      }
    }

    async function notify(title: string, body: string): Promise<void> {
      try {
        await orca.host.call('notifications.show', { title, body })
      } catch (error) {
        log(`Could not show the notification: ${errorMessage(error)}`)
      }
    }

    // ——— Avance y Detener ———

    function beginProgress(kind: Progress['kind']): AbortSignal {
      controller = new AbortController()
      progress = { kind, total: 0, done: 0, active: [], stopping: false }
      postProgress()
      return controller.signal
    }

    function endProgress(): void {
      controller = null
      progress = null
      postProgress()
    }

    const progressHooks = {
      started: (projects: Project[]) => {
        if (!progress) return
        progress.total = projects.length
        postProgress()
      },
      report: (project: Project, step: Progress['active'][number]['step'] | 'done') => {
        if (!progress) return
        progress.active = progress.active.filter((item) => item.projectId !== project.id)
        if (step === 'done') progress.done++
        else progress.active.push({ projectId: project.id, name: project.name, step })
        postProgress()
      }
    }

    function stop(): boolean {
      if (!controller) return false
      controller.abort()
      if (progress) progress.stopping = true
      postProgress()
      log('Stopped on request.')
      return true
    }

    // ——— Ejecutar ———

    /** Orca carga los proyectos poco a poco al arrancar: espera a que estén los marcados. */
    async function waitForProjects(selection: string[]): Promise<void> {
      for (let attempt = 1; attempt <= deps.projectWait.attempts; attempt++) {
        const ids = new Set((await listLocalProjects(orca.host)).map((project) => project.id))
        if (selection.every((id) => ids.has(id))) return
        if (attempt < deps.projectWait.attempts) await deps.sleep(deps.projectWait.intervalMs)
      }
    }

    /** Al terminar el arranque al abrir Orca, muestra el proyecto que diga el perfil. */
    async function openAtEnd(profile: Profile): Promise<string | undefined> {
      try {
        const projectId = projectToOpen(profile, await readLastUsed())
        if (!projectId) return undefined
        const project = (await listLocalProjects(orca.host)).find((item) => item.id === projectId)
        if (!project) return undefined
        const { workspaces } = await orca.host.call('workspace.list')
        const main = workspaces.find(
          (row) => row.projectId === project.id && normalizePath(row.path) === normalizePath(project.path)
        )
        if (!main) return undefined
        await orca.host.call('workspace.open', { workspaceId: main.id })
        return project.name
      } catch (error) {
        log(`Could not show the project at the end: ${errorMessage(error)}`)
        return undefined
      }
    }

    async function run(trigger: RunRecord['trigger']): Promise<RunRecord | null> {
      // Sin `await` antes de esto: quien llama ve `running` a true nada más volver.
      if (running || checking || wrapping) return null
      running = true
      const signal = beginProgress('run')
      const startedAt = deps.now()
      void setStatus({
        text: 'Monstruito: updating…',
        icon: 'refresh',
        tone: 'accent',
        tooltip: 'Pulling changes and opening what is configured'
      })
      void broadcast()
      try {
        const [base, active, overrides, commands] = await Promise.all([
          readBase(),
          readActive(),
          readOverrides(),
          readCommands()
        ])
        const { profile } = active
        const global = resolveSettings(base, profile.settings)
        if (trigger === 'startup') await waitForProjects(profile.selection)
        const { results, missing } = await runProjects(
          {
            host: orca.host,
            git: deps.git,
            shell: deps.shell,
            readText: deps.readText,
            launchWithModel: deps.launchWithModel,
            exists: deps.exists,
            web: deps.web,
            terminalOpened: (terminal) => void rememberTerminal(terminal),
            notes: deps.notes,
            requestsFile: deps.requestsFile,
            now: deps.now,
            log,
            sleep: deps.sleep,
            signal,
            ...progressHooks
          },
          { selection: profile.selection, global, overrides, commands }
        )
        const stopped = signal.aborted
        const opened = trigger === 'startup' && !stopped ? await openAtEnd(profile) : undefined
        const record: RunRecord = {
          trigger,
          startedAt,
          finishedAt: deps.now(),
          results,
          missing,
          profile: profile.name,
          ...(stopped ? { stopped: true } : {}),
          ...(opened ? { opened } : {})
        }
        const history = [record, ...(await readHistory())].slice(0, HISTORY_SIZE)
        await orca.storage.set(HISTORY, asJson(history))
        await orca.storage.delete(PENDING)
        if (results.some((result) => result.brief)) {
          // Con brief, el aviso espera a que los agentes dejen listo cada proyecto: un solo resumen al final.
          await setStatus(statusForReady(record, {}))
          watchReady(record, global.notifyOnFinish)
        } else {
          await setStatus(statusFor(record))
          if (global.notifyOnFinish && results.length > 0) {
            const message = notificationFor(record)
            await notify(message.title, message.body)
          }
        }
        return record
      } catch (error) {
        log(`The run failed: ${errorMessage(error)}`)
        await setStatus({ text: 'Monstruito: error', icon: 'error', tone: 'danger', tooltip: errorMessage(error) })
        return null
      } finally {
        running = false
        endProgress()
        await broadcast()
      }
    }

    /**
     * Después de mandar el brief, mira cada poco si los agentes han escrito su resumen. Cuando lo
     * han hecho todos, o pasado el tiempo, avisa una sola vez con lo que sigue en cada proyecto.
     */
    function watchReady(record: RunRecord, notifyAtEnd: boolean): void {
      stopReadyWatch?.()
      const total = record.results.filter((result) => result.brief).length
      const deadline = record.finishedAt + READY_WAIT_MS
      let seen = 0
      let busy = false
      const cancel = deps.every(READY_POLL_MS, () => void tick())
      stopReadyWatch = cancel
      async function tick(): Promise<void> {
        if (busy || stopReadyWatch !== cancel) return
        busy = true
        try {
          const ready = await readyNow(record)
          const count = Object.keys(ready).length
          const finished = count >= total || deps.now() >= deadline
          if (count !== seen || finished) {
            seen = count
            await setStatus(statusForReady(record, ready))
            await broadcast()
          }
          if (finished) {
            cancel()
            stopReadyWatch = null
            if (notifyAtEnd) {
              const message = notificationForReady(record, ready)
              await notify(message.title, message.body)
            }
          }
        } catch (error) {
          log(`Could not check whether the projects are ready: ${errorMessage(error)}`)
        } finally {
          busy = false
        }
      }
    }

    /** Descarga y cuenta los commits sin aplicar de los proyectos marcados, sin mover nada. */
    async function recheck(): Promise<PendingCheck | null> {
      if (running || checking || wrapping) return null
      checking = true
      const signal = beginProgress('check')
      void broadcast()
      try {
        const [base, active, overrides, previous, projects] = await Promise.all([
          readBase(),
          readActive(),
          readOverrides(),
          readPending(),
          listLocalProjects(orca.host)
        ])
        const global = resolveSettings(base, active.profile.settings)
        const chosen = projects.filter(
          (project) => active.profile.selection.includes(project.id) && project.kind === 'git'
        )
        progressHooks.started(chosen)
        const git: GitRunner = (cwd, args, timeoutMs) => deps.git(cwd, args, timeoutMs, signal)
        let failed = 0
        const found = await mapLimit(chosen, global.concurrency, async (project) => {
          const settings = effectiveSettings(global, overrides[project.id])
          if (signal.aborted || settings.gitMode === 'none') {
            progressHooks.report(project, 'done')
            return null
          }
          progressHooks.report(project, 'git')
          try {
            const incoming = await checkIncoming(git, project.path, settings.fetchAll)
            return incoming && incoming.count > 0
              ? {
                  projectId: project.id,
                  name: project.name,
                  upstream: incoming.upstream,
                  count: incoming.count,
                  ...(settings.gitMode === 'fetch' ? { fetchOnly: true } : {})
                }
              : null
          } catch (error) {
            if (!signal.aborted) {
              failed++
              log(`${project.name}: could not check: ${errorMessage(error)}`)
            }
            return null
          } finally {
            progressHooks.report(project, 'done')
          }
        })
        if (signal.aborted) return null
        const pending: PendingCheck = {
          checkedAt: deps.now(),
          projects: found.filter((item): item is NonNullable<typeof item> => item !== null),
          failed
        }
        await orca.storage.set(PENDING, asJson(pending))
        await setStatus(statusForPending(pending))
        // Avisar solo de lo que ha crecido desde la última revisión.
        const before = new Map((previous?.projects ?? []).map((item) => [item.projectId, item.count]))
        const grown = pending.projects.filter((item) => item.count > (before.get(item.projectId) ?? 0))
        if (global.notifyOnFinish && grown.length > 0) {
          await notify('New commits not applied', grown.map((item) => `${item.name} (${item.count})`).join(', '))
        }
        return pending
      } catch (error) {
        log(`The check failed: ${errorMessage(error)}`)
        return null
      } finally {
        checking = false
        endProgress()
        await broadcast()
      }
    }

    /**
     * El cierre de un proyecto: pide al agente la nota para mañana (solo si no está trabajando),
     * cuenta lo que queda sin commitear o sin subir (sin tocarlo) y cierra lo que se puede cerrar.
     */
    async function wrapProject(
      project: Project,
      workspaces: { id: string; projectId?: string | null; path: string }[],
      opened: OpenedTerminal[],
      closedIds: Set<string>,
      signal: AbortSignal
    ): Promise<WrapResult> {
      const result: WrapResult = {
        projectId: project.id,
        name: project.name,
        note: 'no-agent',
        uncommitted: null,
        untracked: null,
        unpushed: null,
        closed: 0,
        left: 0
      }
      const main = workspaces.find(
        (row) => row.projectId === project.id && normalizePath(row.path) === normalizePath(project.path)
      )
      const listAgents = async () =>
        main ? (await orca.host.call('agents.list', { workspaceId: main.id })).agents.filter((agent) => agent.terminalId) : []
      const noteFile = notePath(project.path, NEXT_NOTE)

      // 1. La nota para mañana, del agente que no está trabajando.
      let agents = await listAgents().catch(() => [])
      const idle = agents.find((agent) => IDLE.has(agent.state))
      if (agents.length > 0 && !idle) result.note = 'busy'
      if (idle && signal.aborted) result.note = 'cancelled'
      if (idle && !signal.aborted) {
        progressHooks.report(project, 'note')
        try {
          if (project.kind === 'git') await excludeNotes(deps.git, deps.notes, project.path).catch(() => false)
          const askedAt = deps.now()
          const sent = await orca.host.call('terminal.sendText', { terminalId: idle.terminalId!, text: WRAP_PROMPT, enter: true })
          result.note = sent.accepted ? 'timeout' : 'failed'
          if (!sent.accepted) result.message = 'The agent did not take the request.'
          for (let waited = 0; sent.accepted && waited < NOTE_WAIT_MS && !signal.aborted; waited += NOTE_POLL_MS) {
            await deps.sleep(NOTE_POLL_MS)
            const at = await deps.notes.mtime(noteFile)
            if (at !== null && at >= askedAt) {
              result.note = 'saved'
              result.next = nextItem((await deps.notes.read(noteFile)) ?? '')
              break
            }
          }
          if (result.note === 'timeout' && signal.aborted) result.note = 'cancelled'
          // Que acabe de contestar antes de cerrarlo.
          for (let tries = 0; result.note === 'saved' && tries < 6; tries++) {
            agents = await listAgents().catch(() => agents)
            if (agents.every((agent) => IDLE.has(agent.state))) break
            await deps.sleep(NOTE_POLL_MS)
          }
        } catch (error) {
          result.note = 'failed'
          result.message = errorMessage(error)
        }
      }

      // 2. Lo que queda sin guardar o sin subir. Solo se mira: nunca se commitea ni se sube nada.
      if (project.kind === 'git') {
        progressHooks.report(project, 'unsaved')
        const changes = await workingChanges(deps.git, project.path).catch(() => null)
        result.uncommitted = changes?.uncommitted ?? null
        result.untracked = changes?.untracked ?? null
        result.unpushed = await aheadCount(deps.git, project.path).catch(() => null)
      }
      if (signal.aborted) return result

      // 3. Cerrar: los agentes, solo si dejaron la nota; las pestañas de comandos, siempre.
      progressHooks.report(project, 'closing')
      const closable = result.note === 'saved' ? agents.filter((agent) => IDLE.has(agent.state)) : []
      result.left = agents.length - closable.length
      for (const agent of closable) {
        try {
          await orca.host.call('terminal.close', { terminalId: agent.terminalId! })
          closedIds.add(agent.terminalId!)
          result.closed++
        } catch {
          // Orca solo deja cerrar los que abrió el plugin o los del workspace a la vista.
          result.left++
        }
      }
      const open = new Set(agents.map((agent) => agent.terminalId))
      for (const terminal of opened.filter((item) => item.project === project.name)) {
        if (terminal.kind === 'agent') {
          // Los agentes que ya no están abiertos dejan de estar apuntados.
          if (!open.has(terminal.terminalId)) closedIds.add(terminal.terminalId)
          continue
        }
        const closed = await orca.host.call('terminal.close', { terminalId: terminal.terminalId }).then(
          () => true,
          () => false
        )
        // Si falla es que ya estaba cerrada: deja de estar apuntada igual.
        closedIds.add(terminal.terminalId)
        if (closed) result.closed++
      }
      return result
    }

    /** El cierre del día de los proyectos marcados: nota para mañana, lo pendiente y cerrar. */
    async function wrap(): Promise<WrapRecord | null> {
      if (running || checking || wrapping) return null
      wrapping = true
      const signal = beginProgress('wrap')
      const startedAt = deps.now()
      void setStatus({
        text: 'Monstruito: wrapping up…',
        icon: 'refresh',
        tone: 'accent',
        tooltip: 'Asking each agent for a note for tomorrow, then closing what can be closed'
      })
      void broadcast()
      try {
        await openedWrites
        const [base, active, projects, opened] = await Promise.all([
          readBase(),
          readActive(),
          listLocalProjects(orca.host),
          readOpened()
        ])
        const global = resolveSettings(base, active.profile.settings)
        const byId = new Map(projects.map((project) => [project.id, project]))
        const chosen = active.profile.selection.flatMap((id) => byId.get(id) ?? [])
        const { workspaces } = await orca.host.call('workspace.list')
        progressHooks.started(chosen)
        const closedIds = new Set<string>()
        const results = await mapLimit(chosen, global.concurrency, async (project) => {
          try {
            return await wrapProject(project, workspaces, opened, closedIds, signal)
          } finally {
            progressHooks.report(project, 'done')
          }
        })
        await openedWrites
        const remaining = (await readOpened()).filter((terminal) => !closedIds.has(terminal.terminalId))
        await orca.storage.set(OPENED, asJson(remaining))
        const record: WrapRecord = {
          startedAt,
          finishedAt: deps.now(),
          profile: active.profile.name,
          projects: results,
          ...(signal.aborted ? { stopped: true } : {})
        }
        await orca.storage.set(LAST_WRAP, asJson(record))
        await setStatus(statusForWrap(record))
        if (global.notifyOnFinish && results.length > 0) {
          const message = notificationForWrap(record)
          await notify(message.title, message.body)
        }
        return record
      } catch (error) {
        log(`The wrap-up failed: ${errorMessage(error)}`)
        await setStatus({ text: 'Monstruito: error', icon: 'error', tone: 'danger', tooltip: errorMessage(error) })
        return null
      } finally {
        wrapping = false
        endProgress()
        await broadcast()
      }
    }

    function scheduleRecheck(minutes: number): void {
      if (minutes === recheckEvery) return
      recheckEvery = minutes
      if (recheckTimer) clearInterval(recheckTimer)
      recheckTimer = null
      if (minutes > 0) {
        recheckTimer = setInterval(() => void recheck(), minutes * 60_000)
        // Que el temporizador no mantenga vivo el proceso por sí solo.
        ;(recheckTimer as { unref?: () => void }).unref?.()
        log(`Checking for new commits every ${minutes} min.`)
      }
    }

    /** La revisión periódica sigue los ajustes del perfil activo. */
    async function refreshSchedule(): Promise<void> {
      const [base, active] = await Promise.all([readBase(), readActive()])
      scheduleRecheck(resolveSettings(base, active.profile.settings).recheckMinutes)
    }

    function isSameOrcaSession(previous: JsonValue | null): boolean {
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return false
      return previous.parentPid === deps.parentPid && typeof previous.at === 'number' && previous.at > deps.bootTime
    }

    /**
     * «Ejecutar al abrir Orca» viene apagado y el panel lo pregunta la primera vez. Quien ya usaba
     * Monstruito no ve la pregunta y sigue como estaba (si nunca lo cambió, encendido).
     */
    async function settleStartupQuestion(): Promise<void> {
      if ((await orca.storage.get(STARTUP_ASKED)) === true) return
      const [profiles, legacy, history] = await Promise.all([
        orca.storage.get(PROFILES),
        orca.storage.get(LEGACY_SELECTION),
        orca.storage.get(HISTORY)
      ])
      if (profiles === null && legacy === null && history === null) return
      if ((await orca.settings.get()).runOnStartup === undefined) await orca.settings.set('runOnStartup', true)
      await orca.storage.set(STARTUP_ASKED, true)
    }

    async function startup(): Promise<void> {
      await settleStartupQuestion()
      if (isSameOrcaSession(await orca.storage.get(SESSION))) {
        await refreshSchedule()
        log('The worker restarted while Orca was open: not repeating the startup run.')
        return
      }
      await orca.storage.set(SESSION, { parentPid: deps.parentPid, at: deps.now() })

      // El perfil del día, si alguno lo tiene; si no, el que estaba activo.
      const active = await readActive()
      const weekday = new Date(deps.now()).getDay()
      const profile = profileForDay(active.profiles, active.profile.id, weekday)
      if (profile.id !== active.profile.id) {
        await orca.storage.set(ACTIVE_PROFILE, profile.id)
        log(`Today's profile: "${profile.name}".`)
      }
      await refreshSchedule()

      const settings = resolveSettings(await readBase(), profile.settings)
      if (!settings.runOnStartup) {
        log(`"Run when Orca opens" is off in "${profile.name}": doing nothing.`)
        return
      }
      if (profile.selection.length === 0) {
        log(`No projects selected in "${profile.name}".`)
        return
      }
      await deps.sleep(settings.startupDelaySeconds * 1000)
      await run('startup')
    }

    /** Apunta una pestaña abierta por Monstruito, para «Cerrar pestañas». Como mucho 100. */
    let openedWrites: Promise<unknown> = Promise.resolve()
    function rememberTerminal(terminal: OpenedTerminal): Promise<unknown> {
      // En fila: dos proyectos a la vez no pueden pisarse la lista.
      openedWrites = openedWrites.then(async () => {
        const opened = [...(await readOpened()), terminal].slice(-100)
        await orca.storage.set(OPENED, asJson(opened))
      })
      return openedWrites
    }

    // ——— Peticiones del panel ———

    /** Guarda, avisa a todos los paneles y responde con el estado nuevo. */
    async function answer(): Promise<PanelState> {
      const next = await state()
      orca.panels.post('state.changed', next)
      return next
    }

    async function updateSelection(ids: string[], selected: boolean): Promise<PanelState> {
      const { profiles, profile } = await readActive()
      const selection = new Set(profile.selection)
      for (const id of ids) {
        if (selected) selection.add(id)
        else selection.delete(id)
      }
      profile.selection = [...selection]
      await writeProfiles(profiles)
      return answer()
    }

    orca.panels.handle('state.get', () => state())
    orca.panels.handle('selection.set', ({ projectId, selected }) => updateSelection([projectId], selected))
    orca.panels.handle('selection.setMany', ({ projectIds, selected }) => updateSelection(projectIds, selected))

    orca.panels.handle('override.set', async ({ projectId, override }) => {
      const overrides = await readOverrides()
      const clean = sanitizeOverride(override)
      if (Object.keys(clean).length > 0) overrides[projectId] = clean
      else delete overrides[projectId]
      await orca.storage.set(OVERRIDES, asJson(overrides))
      return answer()
    })

    orca.panels.handle('commands.set', async ({ projectId, commands }) => {
      const map = await readCommands()
      const clean = sanitizeCommands(commands)
      if (clean.length > 0) map[projectId] = clean
      else delete map[projectId]
      await orca.storage.set(COMMANDS, asJson(map))
      return answer()
    })

    orca.panels.handle('commands.suggest', async ({ projectId }) => {
      const project = (await listLocalProjects(orca.host)).find((item) => item.id === projectId)
      if (!project) return { suggestions: [] }
      // Primero lo que propuso el agente; las reglas fijas quedan detrás, sin repetir.
      const [proposed, rules] = await Promise.all([
        readProposedCommands(deps.notes, project.path).catch(() => []),
        suggestCommands(project.path, deps.readText, deps.exists)
      ])
      const seen = new Set(proposed.map((suggestion) => suggestion.command))
      return { suggestions: [...proposed, ...rules.filter((suggestion) => !seen.has(suggestion.command))] }
    })

    orca.panels.handle('terminals.closeAll', async () => {
      await openedWrites
      const opened = await readOpened()
      // Solo las pestañas de comandos: los agentes se cierran con el cierre del día, tras su nota.
      for (const terminal of opened.filter((item) => item.kind !== 'agent')) {
        // Las que ya se cerraron a mano, o de una sesión anterior de Orca, fallan: no importa.
        await orca.host.call('terminal.close', { terminalId: terminal.terminalId }).catch(() => undefined)
      }
      await orca.storage.set(OPENED, asJson(opened.filter((item) => item.kind === 'agent')))
      return answer()
    })

    orca.panels.handle('run.start', () => {
      void run('manual')
      return state()
    })

    orca.panels.handle('check.start', () => {
      void recheck()
      return state()
    })

    orca.panels.handle('run.stop', () => {
      stop()
      return state()
    })

    orca.panels.handle('wrap.start', () => {
      void wrap()
      return state()
    })

    orca.panels.handle('startup.answer', async ({ runOnStartup }) => {
      await orca.settings.set('runOnStartup', runOnStartup)
      await orca.storage.set(STARTUP_ASKED, true)
      return answer()
    })

    orca.panels.handle('profile.select', async ({ profileId }) => {
      const profiles = await readProfiles()
      await orca.storage.set(ACTIVE_PROFILE, findProfile(profiles, profileId).id)
      // Si aún no se habían guardado (versiones sin perfiles), se guardan ya.
      await writeProfiles(profiles)
      await refreshSchedule()
      return answer()
    })

    orca.panels.handle('profile.create', async ({ name, copyFrom }) => {
      const profiles = await readProfiles()
      const clean = name.trim().slice(0, 60) || 'New profile'
      const source = copyFrom ? profiles.find((profile) => profile.id === copyFrom) : undefined
      const profile: Profile = {
        ...emptyProfile(newProfileId(profiles, clean), clean),
        ...(source
          ? { selection: [...source.selection], settings: { ...source.settings }, openAtEnd: source.openAtEnd }
          : {})
      }
      await writeProfiles([...profiles, profile])
      await orca.storage.set(ACTIVE_PROFILE, profile.id)
      await refreshSchedule()
      return answer()
    })

    orca.panels.handle('profile.update', async ({ profileId, patch }: { profileId: string; patch: ProfilePatch }) => {
      const profiles = await readProfiles()
      const profile = profiles.find((item) => item.id === profileId)
      if (!profile) throw new Error('That profile no longer exists.')
      if (patch.name !== undefined && patch.name.trim()) profile.name = patch.name.trim().slice(0, 60)
      if (patch.openAtEnd !== undefined) profile.openAtEnd = patch.openAtEnd
      if (patch.settings !== undefined) profile.settings = sanitizePartialSettings(patch.settings)
      if (patch.days !== undefined) {
        profile.days = [...new Set(patch.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
        // Un día solo puede ser de un perfil, para que al abrir Orca no haya duda.
        for (const other of profiles) {
          if (other !== profile) other.days = other.days.filter((day) => !profile.days.includes(day))
        }
      }
      await writeProfiles(profiles)
      await refreshSchedule()
      return answer()
    })

    orca.panels.handle('profile.delete', async ({ profileId }) => {
      const profiles = await readProfiles()
      if (profiles.length <= 1) throw new Error('At least one profile must remain.')
      const remaining = profiles.filter((profile) => profile.id !== profileId)
      await writeProfiles(remaining)
      const activeId = await orca.storage.get(ACTIVE_PROFILE)
      if (activeId === profileId || typeof activeId !== 'string') await orca.storage.set(ACTIVE_PROFILE, remaining[0].id)
      await refreshSchedule()
      return answer()
    })

    orca.panels.handle('config.export', async () => {
      const [base, active, overrides, commands, projects] = await Promise.all([
        readBase(),
        readActive(),
        readOverrides(),
        readCommands(),
        listLocalProjects(orca.host)
      ])
      const file = buildExport({
        baseSettings: base,
        profiles: active.profiles,
        activeProfileId: active.profile.id,
        overrides,
        commands,
        projects,
        now: deps.now()
      })
      const day = new Date(deps.now()).toISOString().slice(0, 10)
      return { fileName: `monstruito-${day}.json`, text: JSON.stringify(file, null, 2) }
    })

    async function writeSettings(settings: Partial<GlobalSettings>): Promise<void> {
      for (const [key, value] of Object.entries(settings)) {
        if (value !== undefined) await orca.settings.set(key, value)
      }
    }

    orca.panels.handle('config.import', async ({ text }) => {
      const file = parseExport(text)
      const [base, active, overrides, commands, projects] = await Promise.all([
        readBase(),
        readActive(),
        readOverrides(),
        readCommands(),
        listLocalProjects(orca.host)
      ])
      const applied = applyImport(file, projects)
      // Antes de sustituir nada, una copia para poder deshacer.
      const backup: Backup = {
        profiles: active.profiles,
        activeProfileId: active.profile.id,
        overrides,
        commands,
        settings: base
      }
      await orca.storage.set(IMPORT_BACKUP, asJson(backup))
      await writeProfiles(applied.profiles)
      await orca.storage.set(ACTIVE_PROFILE, applied.activeProfileId)
      await orca.storage.set(OVERRIDES, asJson(applied.overrides))
      // Las exportaciones anteriores a la 0.4 no traen comandos: entonces se dejan los que hay.
      if (Array.isArray(file.projectCommands)) await orca.storage.set(COMMANDS, asJson(applied.commands))
      await writeSettings(applied.settings)
      await refreshSchedule()
      log(`Imported ${applied.report.profiles} profiles; ${applied.report.missing.length} projects not found.`)
      return { state: await answer(), report: applied.report }
    })

    orca.panels.handle('config.undoImport', async () => {
      const value = await orca.storage.get(IMPORT_BACKUP)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('There is no import to undo.')
      const backup = value as unknown as Backup
      await writeProfiles(sanitizeProfiles(backup.profiles, []))
      await orca.storage.set(ACTIVE_PROFILE, backup.activeProfileId)
      await orca.storage.set(OVERRIDES, asJson(sanitizeOverrides(backup.overrides)))
      if (backup.commands) await orca.storage.set(COMMANDS, asJson(sanitizeCommandMap(backup.commands)))
      await writeSettings(sanitizePartialSettings(backup.settings))
      await orca.storage.delete(IMPORT_BACKUP)
      await refreshSchedule()
      return answer()
    })

    // ——— Comandos y eventos ———

    orca.commands.register('monstruito.run', async () => {
      const record = await run('manual')
      return record ? describeRun(record) : 'A run or a check is already in progress.'
    })

    orca.commands.register('monstruito.check', async () => {
      const pending = await recheck()
      if (!pending) return 'A run or a check is already in progress, or it was stopped.'
      return statusForPending(pending).tooltip
    })

    orca.commands.register('monstruito.wrap', async () => {
      const record = await wrap()
      return record ? describeWrapRun(record) : 'A run, a check or a wrap-up is already in progress.'
    })

    orca.commands.register('monstruito.stop', () => (stop() ? 'Stopping…' : 'Nothing is running.'))

    orca.settings.onDidChange(() => {
      void refreshSchedule()
      void broadcast()
    })

    // Se importa o se quita un proyecto o worktree: el panel abierto se actualiza solo.
    orca.events.on('workspace.created', () => void broadcast())
    orca.events.on('workspace.removed', () => void broadcast())

    const task = startup().catch((error) => log(`The startup run failed: ${errorMessage(error)}`))
    deps.onStartup?.(task)
  }
}

const orcaCli = createOrcaCli()

export default createActivate({
  git: runGit,
  shell: runShell,
  readText: readTextFromDisk,
  launchWithModel: createModelLauncher(orcaCli),
  exists: existsSync,
  web: createWebOpener(orcaCli),
  parentPid: process.ppid,
  bootTime: Date.now() - os.uptime() * 1000,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  projectWait: { attempts: 12, intervalMs: 5000 },
  notes: diskFiles,
  requestsFile: requestsFile(),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms)
    // Que el temporizador no mantenga vivo el proceso por sí solo.
    ;(timer as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  }
})
