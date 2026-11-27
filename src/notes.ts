// Lo que el agente deja en `.monstruito/` de cada proyecto: el resumen al dejarlo listo
// (ready.md), la nota de cierre para el día siguiente (next.md) y los comandos que propone
// (commands.json). La carpeta se excluye solo en local (.git/info/exclude): git no la ve y nunca
// se commitea. También lee, sin tocarla, la lista del plugin Requests (~/.requests/requests.json).
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GitRunner } from './git'
import type { CommandSuggestion, ReadyNote } from './protocol'

export const READY_NOTE = '.monstruito/ready.md'
export const NEXT_NOTE = '.monstruito/next.md'
export const PROPOSED_COMMANDS = '.monstruito/commands.json'

/** Lo que se necesita del disco; las pruebas lo sustituyen. */
export type NoteFiles = {
  /** El texto del archivo; null si no existe o no se puede leer. */
  read: (file: string) => Promise<string | null>
  /** Cuándo se modificó, en ms; null si no existe. */
  mtime: (file: string) => Promise<number | null>
  /** Añade al final, creando la carpeta y el archivo si hace falta. */
  append: (file: string, text: string) => Promise<void>
}

export const diskFiles: NoteFiles = {
  read: (file) => readFile(file, 'utf8').catch(() => null),
  mtime: (file) => stat(file).then((info) => info.mtimeMs, () => null),
  append: async (file, text) => {
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, text, 'utf8')
  }
}

export const notePath = (projectPath: string, note: string) => path.join(projectPath, note)

/** El archivo de Requests: el mismo que usa ese plugin. */
export function requestsFile(env: Record<string, string | undefined> = process.env): string {
  return env.REQUESTS_FILE || path.join(os.homedir(), '.requests', 'requests.json')
}

const EXCLUDED = new Set(['/.monstruito/', '.monstruito/', '/.monstruito', '.monstruito'])

/**
 * Que git no vea `.monstruito/`: una línea en el exclude local del repositorio, que no se
 * commitea ni se comparte. false si no se pudo (no es git, o no se puede escribir).
 */
export async function excludeNotes(git: GitRunner, files: NoteFiles, cwd: string): Promise<boolean> {
  const where = await git(cwd, ['rev-parse', '--git-path', 'info/exclude'])
  if (!where.ok || !where.stdout.trim()) return false
  const file = path.resolve(cwd, where.stdout.trim())
  const current = (await files.read(file)) ?? ''
  if (current.split(/\r?\n/).some((line) => EXCLUDED.has(line.trim()))) return true
  const gap = current && !current.endsWith('\n') ? '\n' : ''
  try {
    await files.append(file, `${gap}# Monstruito: notes for you and your agent, never committed\n/.monstruito/\n`)
    return true
  } catch {
    return false
  }
}

/** La línea «Next: …» de una nota, sin adornos de Markdown. */
export function nextItem(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const match = /^[\s>#*_-]*next(?:\s+item)?[*_\s]*[:：][*_\s]*(.+)$/i.exec(raw)
    if (match) {
      const value = match[1].replace(/[*_`]+$/g, '').trim()
      if (value) return value.length > 200 ? `${value.slice(0, 199)}…` : value
    }
  }
  return null
}

/** El resumen del brief, solo si se escribió después de mandarlo. */
export async function readReady(files: NoteFiles, projectPath: string, since: number): Promise<ReadyNote | null> {
  const file = notePath(projectPath, READY_NOTE)
  const at = await files.mtime(file)
  if (at === null || at < since) return null
  const text = ((await files.read(file)) ?? '').trim()
  return { at, next: nextItem(text), text: text.length > 4000 ? `${text.slice(0, 3999)}…` : text }
}

/** La nota de cierre del día anterior, recortada para el brief; null si no hay. */
export async function readNextNote(files: NoteFiles, projectPath: string): Promise<string | null> {
  const text = ((await files.read(notePath(projectPath, NEXT_NOTE))) ?? '').trim()
  if (!text) return null
  return text.length > 1200 ? `${text.slice(0, 1199)}…` : text
}

/** Los comandos que propuso el agente: una lista de {name, command, kind}. Lo que no vale se ignora. */
export async function readProposedCommands(files: NoteFiles, projectPath: string): Promise<CommandSuggestion[]> {
  const text = await files.read(notePath(projectPath, PROPOSED_COMMANDS))
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { commands?: unknown } | null)?.commands
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  return list
    .flatMap((item): CommandSuggestion[] => {
      if (!item || typeof item !== 'object') return []
      const { name, command, kind } = item as Record<string, unknown>
      if (typeof command !== 'string') return []
      // Una sola línea: un salto la mandaría a medias a la terminal.
      const clean = command.trim()
      if (!clean || clean.length > 400 || /[\r\n]/.test(clean) || seen.has(clean)) return []
      seen.add(clean)
      return [
        {
          name: typeof name === 'string' ? name.trim().slice(0, 60) : '',
          command: clean,
          kind: kind === 'tab' ? 'tab' : 'prepare',
          source: 'Claude'
        }
      ]
    })
    .slice(0, 12)
}

export type OpenRequest = { id: string; title: string; status: 'need' | 'run' | 'queue' }

const STATUS_ORDER: OpenRequest['status'][] = ['need', 'run', 'queue']
const key = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/** Lo que sigue abierto en Requests para un proyecto (por su nombre): primero lo que espera por ti. */
export async function openRequests(files: NoteFiles, file: string, projectName: string): Promise<OpenRequest[]> {
  const text = await files.read(file)
  if (!text) return []
  let data: { threads?: unknown; items?: unknown }
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(data?.threads) || !Array.isArray(data?.items)) return []
  const threads = new Set(
    data.threads
      .filter((thread) => key((thread as { project?: unknown })?.project) === key(projectName))
      .map((thread) => (thread as { id?: unknown }).id)
  )
  return data.items
    .flatMap((raw): OpenRequest[] => {
      const item = raw as { id?: unknown; thread?: unknown; title?: unknown; status?: unknown }
      const status = item?.status
      if (!threads.has(item?.thread) || typeof item.id !== 'string' || typeof item.title !== 'string') return []
      if (status !== 'need' && status !== 'run' && status !== 'queue') return []
      return [{ id: item.id, title: item.title.slice(0, 140), status }]
    })
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    .slice(0, 5)
}
