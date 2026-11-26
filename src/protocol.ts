// El contrato entre el panel (src/panel.tsx) y el worker (src/worker.ts), declarado una sola vez.

export type GitMode = 'pull' | 'fetch' | 'none'
/** Qué hace el agente en cada proyecto después de git. */
export type AgentMode = 'wait' | 'summarize' | 'prompt' | 'resume' | 'none'

/** Lo que se puede cambiar por proyecto. */
export type ProjectSettings = {
  gitMode: GitMode
  skipIfDirty: boolean
  fetchAll: boolean
  updateSubmodules: boolean
  fetchOtherWorktrees: boolean
  agent: string
  /** Modelo del agente; vacío = el de su propia configuración. */
  model: string
  /** Razonamiento: '' (el del agente), low, medium, high, xhigh o max. Solo con modelo. */
  effort: string
  mode: AgentMode
  onlyWithCommits: boolean
  prompt: string
  installDeps: boolean
  /** Instalar también si faltan (node_modules, vendor…), aunque git no haya cambiado nada. */
  installMissing: boolean
  /** Ejecutar los comandos de cada proyecto (su lista, en su engranaje). */
  runCommands: boolean
}

/** Un comando de un proyecto. Los comandos son del proyecto y valen en todos los perfiles. */
export type CommandDef = {
  id: string
  /** Para el título de la pestaña y el panel; vacío = el comando. */
  name: string
  command: string
  /** `tab`: en su pestaña, sin esperar (servidores). `prepare`: en segundo plano y se espera. */
  kind: 'tab' | 'prepare'
  /** Cuándo: siempre, solo si entran commits, o solo si cambian archivos de `files`. */
  when: 'always' | 'commits' | 'files'
  /** Para `when: files`: rutas desde la raíz; `carpeta/` es todo lo de dentro; `*` y `**` valen. */
  files: string[]
  /** Pestaña: si ya estaba abierta, cerrarla y abrirla otra vez. */
  restart: boolean
  /** Pestaña: cuando escuche en un puerto, abrir su dirección en el navegador de Orca. */
  openUrl: boolean
  enabled: boolean
}

export type CommandOutcome = {
  name: string
  kind: CommandDef['kind']
  result: 'ok' | 'opened' | 'restarted' | 'already-open' | 'skipped' | 'failed'
  message?: string
  /** La dirección que se abrió en el navegador. */
  url?: string
}

/** Un comando propuesto a partir de package.json, composer.json, Makefile… */
export type CommandSuggestion = { name: string; command: string; kind: CommandDef['kind']; source: string }

/** Lo global: lo de cada proyecto como valor por defecto, más lo que solo tiene sentido global. */
export type GlobalSettings = ProjectSettings & {
  runOnStartup: boolean
  startupDelaySeconds: number
  concurrency: number
  notifyOnFinish: boolean
  recheckMinutes: number
  staggerSeconds: number
}

/** Lo que un proyecto cambia respecto a lo global; lo que falta se hereda. */
export type ProjectOverride = Partial<ProjectSettings>

export type GitOutcome =
  /** La rama avanzó con estos commits. */
  | {
      kind: 'updated'
      upstream: string
      count: number
      commits: string[]
      submodules?: { ok: boolean; message?: string }
    }
  /** Descargado sin mover la rama: estos commits están por traer. */
  | { kind: 'fetched'; upstream: string; count: number; commits: string[] }
  | { kind: 'up-to-date'; upstream: string }
  | { kind: 'no-upstream' }
  | { kind: 'dirty' }
  | { kind: 'failed'; step: 'fetch' | 'merge' | 'git'; message: string }
  | { kind: 'skipped' }
  /** Se pulsó Detener antes de acabar. */
  | { kind: 'cancelled' }

export type AgentOutcome =
  | { kind: 'launched'; agent: string; withPrompt: boolean; model?: string }
  | { kind: 'resumed'; agent: string; title: string }
  | { kind: 'already-open'; agent: string }
  | { kind: 'no-commits' }
  | { kind: 'disabled' }
  | { kind: 'no-workspace' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }

/** Un paso con comando: instalar dependencias o el comando de arranque. */
export type StepOutcome = {
  command: string
  kind: 'ok' | 'opened' | 'already-open' | 'failed'
  message?: string
}

export type WorktreeStatus = { name: string; branch: string | null; behind: number | null }

export type ProjectResult = {
  projectId: string
  name: string
  path: string
  git: GitOutcome
  agent: AgentOutcome
  deps: StepOutcome[]
  /** Los comandos del proyecto, en el orden en que se ejecutaron. */
  commands: CommandOutcome[]
  /** Ejecuciones guardadas por la 0.2 y la 0.3, que tenían un solo comando de arranque. */
  startCommand?: StepOutcome | null
  worktrees: WorktreeStatus[]
}

export type RunRecord = {
  trigger: 'startup' | 'manual'
  startedAt: number
  finishedAt: number
  results: ProjectResult[]
  /** Proyectos marcados que Orca ya no lista (borrados o en otro equipo). */
  missing: string[]
  /** El perfil con el que se ejecutó. */
  profile?: string
  /** Se pulsó Detener. */
  stopped?: boolean
  /** El proyecto que se mostró al terminar. */
  opened?: string
}

/** Un conjunto de proyectos marcados con sus ajustes, por ejemplo Trabajo y Personal. */
export type Profile = {
  id: string
  name: string
  selection: string[]
  /** Ajustes generales propios del perfil; lo que falta sale de los de todos los perfiles. */
  settings: Partial<GlobalSettings>
  /** Días en que se usa solo al abrir Orca: 0 domingo … 6 sábado. */
  days: number[]
  /** Al terminar el arranque al abrir Orca: '' nada, OPEN_RECENT o el id de un proyecto. */
  openAtEnd: string
}

/** `openAtEnd`: el proyecto marcado usado más recientemente. */
export const OPEN_RECENT = '__recent'

export type ProgressStep = 'waiting' | 'git' | 'deps' | 'prepare' | 'worktrees' | 'agent' | 'command' | 'web'

/** Lo que está haciendo ahora una ejecución o una revisión. */
export type Progress = {
  kind: 'run' | 'check'
  total: number
  done: number
  active: { projectId: string; name: string; step: ProgressStep }[]
  stopping: boolean
}

/** Lo que se lleva a otro equipo: los proyectos van por ruta y nombre, no por id. */
export type ProjectRef = { name: string; path: string }

export type ExportFile = {
  /** 'orca-arranque' en las exportaciones anteriores a la 0.5, cuando se llamaba Arranque de proyectos. */
  format: 'monstruito' | 'orca-arranque'
  version: 1
  exportedAt: string
  settings: Partial<GlobalSettings>
  activeProfile: string
  profiles: {
    name: string
    days: number[]
    openAtEnd: '' | typeof OPEN_RECENT | ProjectRef
    settings: Partial<GlobalSettings>
    projects: ProjectRef[]
  }[]
  projectSettings: { project: ProjectRef; override: ProjectOverride }[]
  /** Desde la 0.4; las exportaciones anteriores no lo traen. */
  projectCommands?: { project: ProjectRef; commands: CommandDef[] }[]
}

export type ImportReport = {
  profiles: number
  matched: number
  /** Proyectos del archivo que no hay en este equipo. */
  missing: string[]
}

/** Lo que encontró la última revisión periódica. */
export type PendingCheck = {
  checkedAt: number
  projects: { projectId: string; name: string; upstream: string; count: number }[]
  failed: number
}

export type ProjectRow = {
  id: string
  name: string
  path: string
  selected: boolean
  /** Tiene ajustes propios. */
  customized: boolean
  /** Última actividad en Orca de cualquiera de sus workspaces; null si no consta ninguna. */
  lastUsedAt: number | null
}

export type PanelState = {
  /** `selected` es la selección del perfil activo. */
  projects: ProjectRow[]
  running: boolean
  checking: boolean
  progress: Progress | null
  /** Las últimas ejecuciones, la más reciente primero. */
  history: RunRecord[]
  lastRun: RunRecord | null
  pending: PendingCheck | null
  profiles: Profile[]
  activeProfileId: string
  /** Los ajustes de todos los perfiles (Settings de Orca). */
  baseSettings: GlobalSettings
  /** Los que valen para el perfil activo: los de todos más los suyos. */
  settings: GlobalSettings
  overrides: Record<string, ProjectOverride>
  /** Los comandos de cada proyecto. */
  commands: Record<string, CommandDef[]>
  /** Cuántas pestañas de comandos abrió Monstruito y siguen apuntadas. */
  openedTerminals: number
  /** Se puede deshacer la última importación. */
  canUndoImport: boolean
}

export type ProfilePatch = Partial<Pick<Profile, 'name' | 'days' | 'openAtEnd' | 'settings'>>

declare module 'orca' {
  interface PluginRequests {
    /** Proyectos, perfiles, ajustes y ejecuciones. Pregunta a Orca cada vez. */
    'state.get': { output: PanelState }
    /** Marca o desmarca un proyecto en el perfil activo. */
    'selection.set': { input: { projectId: string; selected: boolean }; output: PanelState }
    /** Marca o desmarca varios a la vez, por ejemplo una carpeta entera. */
    'selection.setMany': { input: { projectIds: string[]; selected: boolean }; output: PanelState }
    /** Guarda los ajustes propios de un proyecto; null los quita. */
    'override.set': {
      input: { projectId: string; override: ProjectOverride | null }
      output: PanelState
    }
    /** Guarda la lista de comandos de un proyecto. */
    'commands.set': { input: { projectId: string; commands: CommandDef[] }; output: PanelState }
    /** Comandos que se le pueden proponer, leyendo package.json, composer.json, Makefile… */
    'commands.suggest': { input: { projectId: string }; output: { suggestions: CommandSuggestion[] } }
    /** Cierra las pestañas de comandos que abrió Monstruito. */
    'terminals.closeAll': { output: PanelState }
    /** Empieza una ejecución manual y responde enseguida, sin esperar a que acabe. */
    'run.start': { output: PanelState }
    /** Empieza una revisión de commits nuevos y responde enseguida. */
    'check.start': { output: PanelState }
    /** Detiene la ejecución o la revisión en marcha. */
    'run.stop': { output: PanelState }
    'profile.select': { input: { profileId: string }; output: PanelState }
    /** Crea un perfil (vacío, o copia de otro) y lo deja activo. */
    'profile.create': { input: { name: string; copyFrom?: string }; output: PanelState }
    'profile.update': { input: { profileId: string; patch: ProfilePatch }; output: PanelState }
    'profile.delete': { input: { profileId: string }; output: PanelState }
    /** El archivo de exportación, como texto JSON. */
    'config.export': { output: { fileName: string; text: string } }
    'config.import': { input: { text: string }; output: { state: PanelState; report: ImportReport } }
    'config.undoImport': { output: PanelState }
  }
  interface PluginPanelEvents {
    /** Se envía a cada panel abierto cuando cambia algo. */
    'state.changed': PanelState
    /** Avance de la ejecución o revisión en marcha; null al terminar. Más ligero que el estado. */
    'progress.changed': { progress: Progress | null }
  }
}
