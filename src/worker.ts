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
import { describeRun, notificationFor, statusFor, statusForPending } from './describe'
import { checkIncoming, runGit, type GitRunner } from './git'
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
  RunRecord
} from './protocol'
import {
  errorMessage,
  lastUsedByProject,
  listLocalProjects,
  mapLimit,
  normalizePath,
  runProjects,
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
const HISTORY_SIZE = 10

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

type OpenedTerminal = { terminalId: string; title: string; project: string }

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

    async function state(): Promise<PanelState> {
      const [base, active, overrides, history, pending, projects, lastUsed, backup, commands, opened] = await Promise.all([
        readBase(),
        readActive(),
        readOverrides(),
        readHistory(),
        readPending(),
        listLocalProjects(orca.host),
        readLastUsed(),
        orca.storage.get(IMPORT_BACKUP),
        readCommands(),
        readOpened()
      ])
      const chosen = new Set(active.profile.selection)
      return {
        baseSettings: base,
        settings: resolveSettings(base, active.profile.settings),
        profiles: active.profiles,
        activeProfileId: active.profile.id,
        overrides,
        commands,
        openedTerminals: opened.length,
        running,
        checking,
        progress,
        history,
        lastRun: history[0] ?? null,
        pending,
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
      if (running || checking) return null
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
        await setStatus(statusFor(record))
        if (global.notifyOnFinish && results.length > 0) {
          const message = notificationFor(record)
          await notify(message.title, message.body)
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

    /** Descarga y cuenta los commits sin aplicar de los proyectos marcados, sin mover nada. */
    async function recheck(): Promise<PendingCheck | null> {
      if (running || checking) return null
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

    async function startup(): Promise<void> {
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
      return { suggestions: await suggestCommands(project.path, deps.readText, deps.exists) }
    })

    orca.panels.handle('terminals.closeAll', async () => {
      await openedWrites
      for (const terminal of await readOpened()) {
        // Las que ya se cerraron a mano, o de una sesión anterior de Orca, fallan: no importa.
        await orca.host.call('terminal.close', { terminalId: terminal.terminalId }).catch(() => undefined)
      }
      await orca.storage.set(OPENED, [])
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
  projectWait: { attempts: 12, intervalMs: 5000 }
})
