// Ajustes: valores por defecto, lectura segura, herencia por proyecto, los campos que dibuja el
// panel y las variables del prompt. Sin dependencias de Node: lo usan el panel y el worker.
import type {
  AgentMode,
  GitMode,
  GitOutcome,
  GlobalSettings,
  ProjectOverride,
  ProjectSettings
} from './protocol'

export const DEFAULT_SETTINGS: GlobalSettings = {
  runOnStartup: true,
  startupDelaySeconds: 4,
  concurrency: 4,
  notifyOnFinish: true,
  recheckMinutes: 0,
  gitMode: 'pull',
  skipIfDirty: false,
  fetchAll: false,
  updateSubmodules: false,
  fetchOtherWorktrees: false,
  agent: 'claude',
  model: '',
  effort: '',
  mode: 'wait',
  onlyWithCommits: false,
  prompt: '',
  staggerSeconds: 0,
  installDeps: true,
  installMissing: true,
  runCommands: true
}

export const AGENTS: { value: string; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'copilot', label: 'GitHub Copilot' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'droid', label: 'Droid' },
  { value: 'grok', label: 'Grok' }
]

export function agentLabel(agent: string): string {
  return AGENTS.find((option) => option.value === agent)?.label ?? agent
}

export type ModelSupport = {
  /** Modelos que se ofrecen en la lista; el resto se puede escribir. */
  models: { value: string; label: string }[]
  /** Ejemplo para escribir uno a mano. */
  placeholder: string
  /** Si acepta razonamiento (`--effort`). */
  effort: boolean
}

/**
 * Agentes a los que Orca deja elegir modelo al abrirlos (`orca agent launch --model`). Los demás
 * (Copilot, Kimi, Droid…) usan el de su propia configuración.
 */
const MODEL_SUPPORT: Record<string, ModelSupport> = {
  claude: {
    models: [
      { value: 'opus', label: 'Opus (el último)' },
      { value: 'sonnet', label: 'Sonnet (el último)' },
      { value: 'haiku', label: 'Haiku (el último)' },
      { value: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
      { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
    ],
    placeholder: 'claude-opus-5-5',
    effort: true
  },
  codex: { models: [], placeholder: 'gpt-6-astra', effort: true },
  cursor: { models: [], placeholder: 'id del modelo', effort: true },
  grok: { models: [], placeholder: 'id del modelo', effort: true },
  opencode: { models: [], placeholder: 'proveedor/modelo', effort: false }
}

export function modelSupport(agent: string): ModelSupport | null {
  return MODEL_SUPPORT[agent] ?? null
}

export const EFFORTS: { value: string; label: string }[] = [
  { value: '', label: 'El del agente' },
  { value: 'low', label: 'Bajo' },
  { value: 'medium', label: 'Medio' },
  { value: 'high', label: 'Alto' },
  { value: 'xhigh', label: 'Muy alto' },
  { value: 'max', label: 'Máximo' }
]

/** Cómo se ve un modelo: su nombre en la lista, o el id tal cual. */
export function modelLabel(agent: string, model: string): string {
  if (!model) return 'el del agente'
  return modelSupport(agent)?.models.find((option) => option.value === model)?.label ?? model
}

const GIT_MODES: { value: GitMode; label: string }[] = [
  { value: 'pull', label: 'Descargar y avanzar la rama' },
  { value: 'fetch', label: 'Solo descargar, sin mover la rama' },
  { value: 'none', label: 'No tocar git' }
]

const AGENT_MODES: { value: AgentMode; label: string }[] = [
  { value: 'wait', label: 'Abrirse y esperar' },
  { value: 'summarize', label: 'Resumir los commits nuevos' },
  { value: 'prompt', label: 'Enviar mi prompt siempre' },
  { value: 'resume', label: 'Retomar la última sesión' },
  { value: 'none', label: 'No abrir agente' }
]

const PROJECT_KEYS = [
  'gitMode',
  'skipIfDirty',
  'fetchAll',
  'updateSubmodules',
  'fetchOtherWorktrees',
  'agent',
  'model',
  'effort',
  'mode',
  'onlyWithCommits',
  'prompt',
  'installDeps',
  'installMissing',
  'runCommands'
] as const satisfies readonly (keyof ProjectSettings)[]

type AnyKey = keyof GlobalSettings

export type FieldDef =
  | { key: AnyKey; kind: 'choice'; label: string; description?: string; options: { value: string; label: string }[] }
  /** El modelo: sus opciones dependen del agente elegido en el mismo sitio. */
  | { key: AnyKey; kind: 'model'; label: string; description?: string; maxLength: number }
  | { key: AnyKey; kind: 'toggle'; label: string; description?: string }
  | { key: AnyKey; kind: 'number'; label: string; description?: string; presets: number[]; unit: string; zero?: string }
  | { key: AnyKey; kind: 'text'; label: string; description?: string; placeholder?: string; multiline?: boolean; maxLength: number }

export type FieldGroup = { title: string; fields: FieldDef[] }

export const PROMPT_HELP = 'Variables: {proyecto}, {rama}, {remota}, {n_commits}, {commits}.'

export const GLOBAL_GROUPS: FieldGroup[] = [
  {
    title: 'Arranque',
    fields: [
      { key: 'runOnStartup', kind: 'toggle', label: 'Ejecutar al abrir Orca' },
      { key: 'startupDelaySeconds', kind: 'number', label: 'Espera al abrir Orca', presets: [0, 2, 4, 10, 30, 60], unit: 's' },
      { key: 'concurrency', kind: 'number', label: 'Proyectos a la vez', presets: [1, 2, 4, 8, 16], unit: '' },
      { key: 'notifyOnFinish', kind: 'toggle', label: 'Avisar al terminar', description: 'Y cuando la revisión periódica encuentre commits nuevos.' },
      { key: 'recheckMinutes', kind: 'number', label: 'Revisar commits nuevos cada', presets: [0, 5, 10, 15, 30, 60, 120], unit: ' min', zero: 'Nunca' }
    ]
  },
  {
    title: 'Git',
    fields: [
      { key: 'gitMode', kind: 'choice', label: 'Qué hacer con git', options: GIT_MODES },
      { key: 'skipIfDirty', kind: 'toggle', label: 'Saltar si hay cambios sin commitear' },
      { key: 'fetchAll', kind: 'toggle', label: 'Todas las ramas y limpiar las borradas', description: 'git fetch --all --prune' },
      { key: 'updateSubmodules', kind: 'toggle', label: 'Actualizar submódulos' },
      { key: 'fetchOtherWorktrees', kind: 'toggle', label: 'Informar de los demás worktrees', description: 'Cuántos commits va por detrás cada uno; no los mueve.' }
    ]
  },
  {
    title: 'Agente',
    fields: [
      { key: 'agent', kind: 'choice', label: 'Agente', options: AGENTS },
      { key: 'model', kind: 'model', label: 'Modelo', maxLength: 200 },
      { key: 'effort', kind: 'choice', label: 'Razonamiento', description: 'Solo se aplica si eliges un modelo.', options: EFFORTS },
      { key: 'mode', kind: 'choice', label: 'Qué hace el agente', options: AGENT_MODES },
      { key: 'onlyWithCommits', kind: 'toggle', label: 'Solo si hay commits nuevos' },
      { key: 'prompt', kind: 'text', label: 'Prompt de arranque', description: PROMPT_HELP, placeholder: 'Vacío = el resumen por defecto', multiline: true, maxLength: 4000 },
      { key: 'staggerSeconds', kind: 'number', label: 'Segundos entre agentes', presets: [0, 2, 5, 10, 30, 60], unit: 's' }
    ]
  },
  {
    title: 'Comandos',
    fields: [
      { key: 'installDeps', kind: 'toggle', label: 'Instalar dependencias si cambian', description: 'npm, pnpm, yarn, bun, composer, flutter, bundler, poetry o uv, antes de abrir nada.' },
      { key: 'installMissing', kind: 'toggle', label: 'Instalar dependencias si faltan', description: 'Si no hay node_modules, vendor, .dart_tool o .venv (un clon nuevo), aunque git no haya cambiado nada.' },
      { key: 'runCommands', kind: 'toggle', label: 'Ejecutar los comandos de cada proyecto', description: 'Los comandos se configuran en el engranaje de cada proyecto.' }
    ]
  }
]

const projectKeySet = new Set<string>(PROJECT_KEYS)

/** Los mismos grupos, solo con lo que se puede cambiar por proyecto. */
export const PROJECT_GROUPS: FieldGroup[] = GLOBAL_GROUPS.map((group) => ({
  title: group.title,
  fields: group.fields.filter((field) => projectKeySet.has(field.key))
})).filter((group) => group.fields.length > 0)

const ALL_FIELDS = GLOBAL_GROUPS.flatMap((group) => group.fields)
const LIMITS: Partial<Record<AnyKey, [number, number]>> = {
  startupDelaySeconds: [0, 300],
  concurrency: [1, 16],
  recheckMinutes: [0, 1440],
  staggerSeconds: [0, 300]
}

/** El valor si es válido para ese campo; undefined si no. */
function validValue(key: AnyKey, value: unknown): unknown {
  const field = ALL_FIELDS.find((candidate) => candidate.key === key)
  if (!field) return undefined
  switch (field.kind) {
    case 'toggle':
      return typeof value === 'boolean' ? value : undefined
    case 'choice':
      return typeof value === 'string' &&
        (key === 'agent' ? value.trim() !== '' : field.options.some((option) => option.value === value))
        ? value
        : undefined
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      const [min, max] = LIMITS[key] ?? [0, Number.MAX_SAFE_INTEGER]
      return Math.min(max, Math.max(min, Math.round(value)))
    }
    case 'text':
      return typeof value === 'string' ? value.slice(0, field.maxLength) : undefined
    case 'model':
      // Un id de modelo es una sola palabra: sin espacios, que acabarían como otro argumento.
      return typeof value === 'string' && !/\s/.test(value.trim()) ? value.trim().slice(0, field.maxLength) : undefined
  }
}

/**
 * Pone `layer` encima de `below`. El modelo y el razonamiento van con su agente: si la capa cambia
 * de agente sin decirlos, se usan los del agente nuevo por defecto, no los elegidos para otro.
 */
function layered<T extends ProjectSettings>(below: T, layer: Partial<ProjectSettings>): T {
  const merged = { ...below, ...layer }
  if (layer.agent !== undefined && layer.agent !== below.agent) {
    if (layer.model === undefined) merged.model = ''
    if (layer.effort === undefined) merged.effort = ''
  }
  return merged
}

export function readGlobalSettings(raw: Record<string, unknown>): GlobalSettings {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as AnyKey[]) {
    const value = validValue(key, raw[key])
    if (value !== undefined) settings[key] = value
  }
  // Compatibilidad con 0.1: un ajuste `pull` apagado equivalía a no tocar git.
  if (raw.gitMode === undefined && raw.pull === false) settings.gitMode = 'none'
  return settings as GlobalSettings
}

/** Los ajustes generales propios de un perfil: solo claves conocidas y válidas. Texto vacío = heredar. */
export function sanitizePartialSettings(raw: unknown): Partial<GlobalSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const partial: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_SETTINGS) as AnyKey[]) {
    const value = validValue(key, (raw as Record<string, unknown>)[key])
    if (value === undefined) continue
    if (typeof value === 'string' && value.trim() === '' && key === 'prompt') continue
    partial[key] = value
  }
  return partial as Partial<GlobalSettings>
}

/** Los ajustes de todos los perfiles con los propios del perfil encima. */
export function resolveSettings(base: GlobalSettings, profile: Partial<GlobalSettings> | undefined): GlobalSettings {
  return layered(base, sanitizePartialSettings(profile))
}

/** Solo las claves por proyecto con valores válidos; un texto vacío cuenta como "heredar". */
export function sanitizeOverride(raw: unknown): ProjectOverride {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const override: Record<string, unknown> = {}
  for (const key of PROJECT_KEYS) {
    const value = validValue(key, (raw as Record<string, unknown>)[key])
    if (value === undefined) continue
    if (typeof value === 'string' && value.trim() === '' && key === 'prompt') continue
    override[key] = value
  }
  return override as ProjectOverride
}

export function sanitizeOverrides(raw: unknown): Record<string, ProjectOverride> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const overrides: Record<string, ProjectOverride> = {}
  for (const [projectId, value] of Object.entries(raw)) {
    const override = sanitizeOverride(value)
    if (Object.keys(override).length > 0) overrides[projectId] = override
  }
  return overrides
}

export function effectiveSettings(global: GlobalSettings, override: ProjectOverride | undefined): ProjectSettings {
  const below = {} as Record<string, unknown>
  for (const key of PROJECT_KEYS) below[key] = global[key]
  return layered(below as ProjectSettings, sanitizeOverride(override))
}

/** Variables del prompt a partir de lo que pasó con git. */
export function promptVariables(project: string, branch: string | null, git: GitOutcome): Record<string, string> {
  const withCommits = git.kind === 'updated' || git.kind === 'fetched' ? git : null
  return {
    proyecto: project,
    rama: branch ?? '',
    remota: withCommits?.upstream ?? (git.kind === 'up-to-date' ? git.upstream : ''),
    n_commits: String(withCommits?.count ?? 0),
    commits: withCommits && withCommits.commits.length > 0 ? withCommits.commits.join('; ') : 'ninguno'
  }
}

/** Sustituye {variables} y deja el prompt en una sola línea: un salto podría enviarlo a medias. */
export function renderPrompt(template: string, variables: Record<string, string>): string {
  const filled = template.replace(/\{(\w+)\}/g, (match, name: string) => variables[name] ?? match)
  return filled.replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 4000)
}

export const DEFAULT_SUMMARY_UPDATED =
  'Al abrir Orca he traído {n_commits} commits nuevos de {remota}: {commits}. Resume en pocas líneas qué ha cambiado y avisa si algo merece atención antes de seguir trabajando. No cambies nada todavía.'

export const DEFAULT_SUMMARY_FETCHED =
  'En {remota} hay {n_commits} commits nuevos que todavía no están en tu rama: {commits}. Resume qué traen y avisa si algo puede chocar con lo que hay en local. No cambies nada todavía.'
