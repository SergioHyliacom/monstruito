// Comandos que se le pueden proponer a un proyecto, mirando qué tiene: package.json, composer.json,
// artisan, Makefile, docker compose, Flutter, Django, Cargo, Go.
import { join } from 'node:path'
import type { CommandSuggestion } from './protocol'

export type Exists = (path: string) => boolean
export type ReadText = (path: string) => Promise<string | null>

/** Lo que suele quedarse corriendo (va en una pestaña); el resto se espera a que acabe. */
const LONG_RUNNING = /^(dev|start|serve|watch|storybook|preview|emulators?|up|run|server)([:_-].*)?$|(^|[:_-])(dev|serve|watch)$/

function scriptKind(name: string): CommandSuggestion['kind'] {
  return LONG_RUNNING.test(name) ? 'tab' : 'prepare'
}

/** Los habituales primero, luego lo que se queda corriendo, luego el resto; y por nombre. */
function byPriority(a: string, b: string): number {
  const order = ['dev', 'start', 'serve', 'watch', 'storybook', 'preview']
  const rank = (name: string) => {
    const index = order.findIndex((item) => name === item || name.startsWith(`${item}:`))
    if (index !== -1) return index
    return scriptKind(name) === 'tab' ? order.length : order.length + 1
  }
  return rank(a) - rank(b) || a.localeCompare(b)
}

function nodeRunner(has: (file: string) => boolean): (script: string) => string {
  if (has('pnpm-lock.yaml')) return (script) => `pnpm run ${script}`
  if (has('yarn.lock')) return (script) => `yarn ${script}`
  if (has('bun.lock') || has('bun.lockb')) return (script) => `bun run ${script}`
  return (script) => (script === 'start' ? 'npm start' : `npm run ${script}`)
}

async function readJson(read: ReadText, path: string): Promise<Record<string, unknown> | null> {
  const text = await read(path)
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function scriptNames(json: Record<string, unknown> | null): string[] {
  const scripts = json?.scripts
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return []
  // Los pre/post de npm se lanzan solos con su script.
  return Object.keys(scripts).filter((name) => !/^(pre|post)/.test(name) || name === 'preview')
}

export async function suggestCommands(projectPath: string, read: ReadText, exists: Exists): Promise<CommandSuggestion[]> {
  const has = (file: string) => exists(join(projectPath, file))
  const suggestions: CommandSuggestion[] = []
  const add = (name: string, command: string, kind: CommandSuggestion['kind'], source: string) => {
    if (!suggestions.some((item) => item.command === command)) suggestions.push({ name, command, kind, source })
  }

  if (has('package.json')) {
    const run = nodeRunner(has)
    for (const script of scriptNames(await readJson(read, join(projectPath, 'package.json'))).sort(byPriority).slice(0, 12)) {
      add(script, run(script), scriptKind(script), 'package.json')
    }
  }
  if (has('artisan')) {
    add('serve', 'php artisan serve', 'tab', 'Laravel')
    add('migrate', 'php artisan migrate --force', 'prepare', 'Laravel')
  }
  if (has('composer.json')) {
    for (const script of scriptNames(await readJson(read, join(projectPath, 'composer.json'))).sort(byPriority).slice(0, 8)) {
      add(script, `composer run-script ${script}`, scriptKind(script), 'composer.json')
    }
  }
  for (const file of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    if (has(file)) {
      add('docker', 'docker compose up', 'tab', file)
      add('docker (background)', 'docker compose up -d', 'prepare', file)
      break
    }
  }
  if (has('pubspec.yaml') && /sdk:\s*flutter/.test((await read(join(projectPath, 'pubspec.yaml'))) ?? '')) {
    add('flutter', 'flutter run', 'tab', 'pubspec.yaml')
  }
  if (has('manage.py')) {
    add('runserver', 'python manage.py runserver', 'tab', 'Django')
    add('migrate', 'python manage.py migrate', 'prepare', 'Django')
  }
  if (has('Cargo.toml')) add('cargo', 'cargo run', 'tab', 'Cargo.toml')
  if (has('go.mod')) add('go', 'go run .', 'tab', 'go.mod')
  if (has('Makefile')) {
    const makefile = (await read(join(projectPath, 'Makefile'))) ?? ''
    const targets = [...makefile.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)]
      .map((match) => match[1])
      .filter((target, index, all) => all.indexOf(target) === index)
      .sort(byPriority)
      .slice(0, 8)
    for (const target of targets) add(target, `make ${target}`, scriptKind(target), 'Makefile')
  }
  return suggestions
}
