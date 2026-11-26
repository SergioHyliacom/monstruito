// Exportar e importar la configuración. Los ids de proyecto de Orca cambian de un equipo a otro,
// así que el archivo nombra cada proyecto por su ruta y su nombre, y al importar se busca por
// ruta y, si no está, por nombre.
import { sanitizeCommands } from './commands'
import { newProfileId } from './profiles'
import {
  OPEN_RECENT,
  type CommandDef,
  type ExportFile,
  type GlobalSettings,
  type ImportReport,
  type Profile,
  type ProjectOverride,
  type ProjectRef
} from './protocol'
import type { Project } from './run'
import { sanitizeOverride, sanitizePartialSettings } from './settings'

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function buildExport(input: {
  baseSettings: GlobalSettings
  profiles: Profile[]
  activeProfileId: string
  overrides: Record<string, ProjectOverride>
  commands: Record<string, CommandDef[]>
  projects: Project[]
  now: number
}): ExportFile {
  const byId = new Map(input.projects.map((project) => [project.id, project]))
  const ref = (id: string): ProjectRef | null => {
    const project = byId.get(id)
    return project ? { name: project.name, path: project.path } : null
  }
  return {
    format: 'monstruito',
    version: 1,
    exportedAt: new Date(input.now).toISOString(),
    settings: input.baseSettings,
    activeProfile: input.profiles.find((profile) => profile.id === input.activeProfileId)?.name ?? '',
    profiles: input.profiles.map((profile) => ({
      name: profile.name,
      days: profile.days,
      openAtEnd: profile.openAtEnd === '' || profile.openAtEnd === OPEN_RECENT ? profile.openAtEnd : (ref(profile.openAtEnd) ?? ''),
      settings: profile.settings,
      projects: profile.selection.flatMap((id) => ref(id) ?? [])
    })),
    projectSettings: Object.entries(input.overrides).flatMap(([id, override]) => {
      const project = ref(id)
      return project ? [{ project, override }] : []
    }),
    projectCommands: Object.entries(input.commands).flatMap(([id, commands]) => {
      const project = ref(id)
      return project ? [{ project, commands }] : []
    })
  }
}

/** Lee el texto pegado; lanza un error que se puede enseñar tal cual si no vale. */
export function parseExport(text: string): ExportFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('No es un JSON válido. Pega el contenido completo del archivo exportado.')
  }
  const file = data as Partial<ExportFile> | null
  if (!file || typeof file !== 'object' || (file.format !== 'monstruito' && file.format !== 'orca-arranque')) {
    throw new Error('No es una exportación de Monstruito.')
  }
  if (file.version !== 1) throw new Error(`Versión de exportación desconocida: ${String(file.version)}.`)
  if (!Array.isArray(file.profiles) || file.profiles.length === 0) throw new Error('La exportación no tiene perfiles.')
  return file as ExportFile
}

export function applyImport(
  file: ExportFile,
  projects: Project[]
): {
  settings: Partial<GlobalSettings>
  profiles: Profile[]
  activeProfileId: string
  overrides: Record<string, ProjectOverride>
  commands: Record<string, CommandDef[]>
  report: ImportReport
} {
  const byPath = new Map(projects.map((project) => [normalize(project.path), project]))
  const missing = new Set<string>()
  const matched = new Set<string>()
  const resolve = (ref: unknown): string | null => {
    if (!ref || typeof ref !== 'object') return null
    const { name, path } = ref as Partial<ProjectRef>
    const samePath = typeof path === 'string' ? byPath.get(normalize(path)) : undefined
    const sameName =
      typeof name === 'string'
        ? projects.filter((project) => project.name.toLowerCase() === name.toLowerCase())
        : []
    // Por nombre solo si no hay duda: dos proyectos con el mismo nombre no se adivinan.
    const project = samePath ?? (sameName.length === 1 ? sameName[0] : undefined)
    if (project) {
      matched.add(project.id)
      return project.id
    }
    missing.add(typeof name === 'string' ? name : String(path ?? '?'))
    return null
  }

  const profiles: Profile[] = []
  for (const raw of file.profiles) {
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : 'Importado'
    const openAtEnd =
      raw.openAtEnd === '' || raw.openAtEnd === OPEN_RECENT ? raw.openAtEnd : (resolve(raw.openAtEnd) ?? '')
    profiles.push({
      id: newProfileId(profiles, name),
      name,
      selection: [...new Set((Array.isArray(raw.projects) ? raw.projects : []).flatMap((ref) => resolve(ref) ?? []))],
      settings: sanitizePartialSettings(raw.settings),
      days: Array.isArray(raw.days) ? raw.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) : [],
      openAtEnd
    })
  }

  const overrides: Record<string, ProjectOverride> = {}
  for (const entry of Array.isArray(file.projectSettings) ? file.projectSettings : []) {
    const id = resolve(entry?.project)
    const override = sanitizeOverride(entry?.override)
    if (id && Object.keys(override).length > 0) overrides[id] = override
  }

  const commands: Record<string, CommandDef[]> = {}
  for (const entry of Array.isArray(file.projectCommands) ? file.projectCommands : []) {
    const id = resolve(entry?.project)
    const list = sanitizeCommands(entry?.commands)
    if (id && list.length > 0) commands[id] = list
  }

  const active = profiles.find((profile) => profile.name === file.activeProfile) ?? profiles[0]
  return {
    settings: sanitizePartialSettings(file.settings),
    profiles,
    activeProfileId: active.id,
    overrides,
    commands,
    report: { profiles: profiles.length, matched: matched.size, missing: [...missing].sort() }
  }
}
