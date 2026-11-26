import { assert, test } from 'orca/testing'
import { suggestCommands } from './suggest'

/** Un proyecto de mentira: nombre de archivo → contenido (null = existe pero no se lee). */
function fakeProject(files: Record<string, string | null>) {
  const name = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? ''
  return {
    exists: (path: string) => name(path) in files,
    read: async (path: string) => files[name(path)] ?? null
  }
}

test('scripts de package.json con el gestor que toque, los habituales primero', async () => {
  const project = fakeProject({
    'package.json': JSON.stringify({ scripts: { lint: 'x', build: 'x', dev: 'x', 'dev:api': 'x', predev: 'x', storybook: 'x' } }),
    'pnpm-lock.yaml': null
  })
  const suggestions = await suggestCommands('D:/P/web', project.read, project.exists)
  assert.deepEqual(
    suggestions.map((item) => [item.command, item.kind]),
    [
      ['pnpm run dev', 'tab'],
      ['pnpm run dev:api', 'tab'],
      ['pnpm run storybook', 'tab'],
      ['pnpm run build', 'prepare'],
      ['pnpm run lint', 'prepare']
    ]
  )
})

test('Laravel, docker compose, Makefile y Flutter', async () => {
  const project = fakeProject({
    artisan: null,
    'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }),
    'compose.yaml': null,
    Makefile: '.PHONY: up\nup:\n\tdocker compose up\nseed: up\n\tphp artisan db:seed\nVAR := 1\n',
    'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n'
  })
  const suggestions = await suggestCommands('D:/P/api', project.read, project.exists)
  assert.deepEqual(
    suggestions.map((item) => `${item.command} (${item.kind}, ${item.source})`),
    [
      'php artisan serve (tab, Laravel)',
      'php artisan migrate --force (prepare, Laravel)',
      'composer run-script test (prepare, composer.json)',
      'docker compose up (tab, compose.yaml)',
      'docker compose up -d (prepare, compose.yaml)',
      'flutter run (tab, pubspec.yaml)',
      'make up (tab, Makefile)',
      'make seed (prepare, Makefile)'
    ]
  )
})

test('un proyecto sin nada conocido no propone nada', async () => {
  const project = fakeProject({ 'README.md': '# hola' })
  assert.deepEqual(await suggestCommands('D:/P/x', project.read, project.exists), [])
})
