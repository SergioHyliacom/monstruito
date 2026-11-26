// Los comandos de cada proyecto: lectura segura, título de su pestaña y cuándo toca ejecutarlos.
// Sin dependencias de Node: lo usan el panel y el worker.
import type { CommandDef, GitOutcome } from './protocol'

export const MAX_COMMANDS = 20

export function emptyCommand(id: string, command = '', kind: CommandDef['kind'] = 'tab', name = ''): CommandDef {
  return { id, name, command, kind, when: 'always', files: [], restart: false, openUrl: false, enabled: true }
}

export function newCommandId(existing: { id: string }[]): string {
  let n = existing.length + 1
  while (existing.some((item) => item.id === `c${n}`)) n++
  return `c${n}`
}

function sanitizeCommand(raw: unknown): CommandDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const command = typeof value.command === 'string' ? value.command.trim().slice(0, 500) : ''
  if (!command || typeof value.id !== 'string' || !value.id) return null
  const kind = value.kind === 'prepare' ? 'prepare' : 'tab'
  return {
    id: value.id.slice(0, 40),
    name: typeof value.name === 'string' ? value.name.trim().slice(0, 40) : '',
    command,
    kind,
    when: value.when === 'commits' || value.when === 'files' ? value.when : 'always',
    files: Array.isArray(value.files)
      ? value.files
          .filter((file): file is string => typeof file === 'string')
          .map((file) => file.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    // Reiniciar y abrir la web solo tienen sentido en una pestaña.
    restart: kind === 'tab' && value.restart === true,
    openUrl: kind === 'tab' && value.openUrl === true,
    enabled: value.enabled !== false
  }
}

/** Una lista válida: sin comandos vacíos ni ids repetidos, como mucho MAX_COMMANDS. */
export function sanitizeCommands(raw: unknown): CommandDef[] {
  if (!Array.isArray(raw)) return []
  const commands: CommandDef[] = []
  for (const item of raw) {
    const command = sanitizeCommand(item)
    if (command && !commands.some((other) => other.id === command.id)) commands.push(command)
  }
  return commands.slice(0, MAX_COMMANDS)
}

export function sanitizeCommandMap(raw: unknown): Record<string, CommandDef[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const map: Record<string, CommandDef[]> = {}
  for (const [projectId, value] of Object.entries(raw)) {
    const commands = sanitizeCommands(value)
    if (commands.length > 0) map[projectId] = commands
  }
  return map
}

/**
 * Hasta la 0.3 cada proyecto tenía un solo `startCommand` en sus ajustes propios. Pasa a ser el
 * primer comando de su lista.
 */
export function commandsFromLegacy(rawOverrides: unknown): Record<string, CommandDef[]> {
  if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) return {}
  const map: Record<string, CommandDef[]> = {}
  for (const [projectId, value] of Object.entries(rawOverrides)) {
    const command = (value as { startCommand?: unknown } | null)?.startCommand
    if (typeof command === 'string' && command.trim()) map[projectId] = [emptyCommand('c1', command.trim())]
  }
  return map
}

export function commandLabel(command: Pick<CommandDef, 'name' | 'command'>): string {
  return command.name || command.command
}

/** El título de su pestaña: así se reconoce si ya está abierta. */
export function commandTitle(command: Pick<CommandDef, 'name' | 'command'>): string {
  return `Monstruito: ${commandLabel(command)}`.slice(0, 60)
}

/** `*` dentro de una carpeta, `**` en cualquier profundidad; `carpeta/` es todo lo de dentro. */
function patternToRegExp(pattern: string): RegExp {
  const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  const body = clean
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((piece) => piece.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
        .join('[^/]*')
    )
    .join('.*')
  return new RegExp(clean.endsWith('/') ? `^${body}` : `^${body}$`)
}

export function matchesFiles(changedFiles: string[], patterns: string[]): boolean {
  const regexps = patterns.map(patternToRegExp)
  return changedFiles.some((file) => regexps.some((regexp) => regexp.test(file)))
}

/** Si toca ejecutarlo; si no, por qué. */
export function shouldRun(
  command: CommandDef,
  git: GitOutcome,
  changedFiles: string[]
): { run: true } | { run: false; reason: string } {
  if (!command.enabled) return { run: false, reason: 'desactivado' }
  if (command.when === 'commits') {
    const commits = git.kind === 'updated' || git.kind === 'fetched' ? git.count : 0
    return commits > 0 ? { run: true } : { run: false, reason: 'sin commits nuevos' }
  }
  if (command.when === 'files') {
    return matchesFiles(changedFiles, command.files)
      ? { run: true }
      : { run: false, reason: 'no cambiaron esos archivos' }
  }
  return { run: true }
}

export function describeWhen(command: CommandDef): string {
  if (command.when === 'commits') return 'si entran commits'
  if (command.when === 'files') return command.files.length > 0 ? `si cambia ${command.files.join(', ')}` : 'si cambian archivos (sin indicar)'
  return 'siempre'
}
