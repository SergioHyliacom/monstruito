// Instalar dependencias cuando el avance de git cambia un lockfile de la raíz del proyecto. Se
// ejecuta en segundo plano y se espera a que acabe, para que el comando de arranque y el agente
// encuentren las dependencias ya instaladas.
import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StepOutcome } from './protocol'

/** `signal` corta la instalación en marcha (Detener). */
export type ShellRunner = (
  cwd: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<{ ok: boolean; output: string }>
export type ReadText = (path: string) => Promise<string | null>

const INSTALL_TIMEOUT = 15 * 60_000

export const runShell: ShellRunner = (cwd, command, timeoutMs, signal) =>
  new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        signal,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        // Que ningún instalador se quede esperando una respuesta.
        env: { ...process.env, CI: 'true' }
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim() || (error?.message ?? '') })
      }
    )
  })

export const readText: ReadText = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Lockfile de la raíz → instalación. Uno por gestor: si cambian dos de npm, se instala una vez. */
const INSTALLERS: { files: string[]; command: string }[] = [
  { files: ['pnpm-lock.yaml'], command: 'pnpm install' },
  { files: ['package-lock.json'], command: 'npm install' },
  { files: ['yarn.lock'], command: 'yarn install' },
  { files: ['bun.lock', 'bun.lockb'], command: 'bun install' },
  { files: ['composer.lock'], command: 'composer install' },
  { files: ['Gemfile.lock'], command: 'bundle install' },
  { files: ['poetry.lock'], command: 'poetry install' },
  { files: ['uv.lock'], command: 'uv sync' }
]

/** Las instalaciones que tocan según los archivos que cambió git. */
export async function installCommands(changedFiles: string[], projectPath: string, read: ReadText): Promise<string[]> {
  const changed = new Set(changedFiles.filter((file) => !file.includes('/')))
  const commands = INSTALLERS.filter((installer) => installer.files.some((file) => changed.has(file))).map(
    (installer) => installer.command
  )
  if (changed.has('pubspec.lock') || changed.has('pubspec.yaml')) {
    const pubspec = (await read(join(projectPath, 'pubspec.yaml'))) ?? ''
    commands.push(/sdk:\s*flutter/.test(pubspec) ? 'flutter pub get' : 'dart pub get')
  }
  return commands
}

export type Exists = (path: string) => boolean

/** Instalaciones que faltan en un clon nuevo: hay manifiesto pero no la carpeta que deja instalar. */
export async function missingInstallCommands(projectPath: string, exists: Exists, read: ReadText): Promise<string[]> {
  const has = (file: string) => exists(join(projectPath, file))
  const commands: string[] = []
  if (has('package.json') && !has('node_modules')) {
    commands.push(
      has('pnpm-lock.yaml')
        ? 'pnpm install'
        : has('yarn.lock')
          ? 'yarn install'
          : has('bun.lock') || has('bun.lockb')
            ? 'bun install'
            : 'npm install'
    )
  }
  if (has('composer.json') && !has('vendor')) commands.push('composer install')
  if (has('pubspec.yaml') && !has('.dart_tool')) {
    const pubspec = (await read(join(projectPath, 'pubspec.yaml'))) ?? ''
    commands.push(/sdk:\s*flutter/.test(pubspec) ? 'flutter pub get' : 'dart pub get')
  }
  if (has('uv.lock') && !has('.venv')) commands.push('uv sync')
  return commands
}

export function lastLines(output: string, count: number): string {
  const all = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const text = all.slice(-count).join(' · ')
  return text.length > 300 ? `…${text.slice(-299)}` : text
}

/** Ejecuta las instalaciones en orden, esperando a cada una. */
export async function runInstalls(
  shell: ShellRunner,
  projectPath: string,
  commands: string[],
  signal?: AbortSignal
): Promise<StepOutcome[]> {
  const results: StepOutcome[] = []
  for (const command of commands) {
    if (signal?.aborted) break
    const result = await shell(projectPath, command, INSTALL_TIMEOUT, signal)
    results.push(
      result.ok
        ? { command, kind: 'ok' }
        : { command, kind: 'failed', message: lastLines(result.output, 3) || 'falló sin salida' }
    )
  }
  return results
}
