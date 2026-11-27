import { assert, test } from 'orca/testing'
import {
  commandsFromLegacy,
  commandTitle,
  emptyCommand,
  matchesFiles,
  newCommandId,
  sanitizeCommands,
  shouldRun
} from './commands'
import type { GitOutcome } from './protocol'

const updated: GitOutcome = { kind: 'updated', upstream: 'origin/main', count: 2, commits: ['a', 'b'] }
const upToDate: GitOutcome = { kind: 'up-to-date', upstream: 'origin/main' }

test('qué archivos casan con cada patrón', () => {
  const changed = ['database/migrations/2026_01_add.php', 'src/app/main.ts', 'package.json']
  assert.ok(matchesFiles(changed, ['database/migrations/']), 'una carpeta con / es todo lo de dentro')
  assert.ok(matchesFiles(changed, ['package.json']))
  assert.ok(matchesFiles(changed, ['src/**/*.ts']))
  assert.ok(matchesFiles(changed, ['./src/app/*.ts']))
  assert.ok(!matchesFiles(changed, ['src/*.ts']), '* no baja de carpeta')
  assert.ok(!matchesFiles(changed, ['composer.json']))
  assert.ok(!matchesFiles(changed, ['package']), 'sin / ni comodín, el nombre entero')
  assert.ok(!matchesFiles([], ['**']))
})

test('cuándo toca un comando', () => {
  const always = emptyCommand('c1', 'npm run dev')
  assert.deepEqual(shouldRun(always, upToDate, []), { run: true })
  assert.deepEqual(shouldRun({ ...always, enabled: false }, updated, []), { run: false, reason: 'disabled' })
  assert.deepEqual(shouldRun({ ...always, when: 'commits' }, upToDate, []), { run: false, reason: 'no new commits' })
  assert.deepEqual(shouldRun({ ...always, when: 'commits' }, updated, []), { run: true })
  assert.deepEqual(
    shouldRun({ ...always, when: 'files', files: ['database/migrations/'] }, updated, ['README.md']),
    { run: false, reason: "those files didn't change" }
  )
  assert.deepEqual(
    shouldRun({ ...always, when: 'files', files: ['database/migrations/'] }, updated, ['database/migrations/x.php']),
    { run: true }
  )
})

test('limpia la lista guardada', () => {
  const commands = sanitizeCommands([
    { id: 'c1', command: '  npm run dev ', kind: 'tab', restart: true, openUrl: true, when: 'files', files: [' .\\src\\ ', 3] },
    { id: 'c1', command: 'duplicado' },
    { id: 'c2', command: '   ' },
    { id: 'c3', command: 'make setup', kind: 'prepare', restart: true, openUrl: true, when: 'raro' },
    'basura'
  ])
  assert.deepEqual(commands, [
    { ...emptyCommand('c1', 'npm run dev'), restart: true, openUrl: true, when: 'files', files: ['src/'] },
    { ...emptyCommand('c3', 'make setup', 'prepare') }
  ])
})

test('el comando único de la 0.3 pasa a la lista', () => {
  assert.deepEqual(commandsFromLegacy({ p1: { startCommand: ' npm run dev ' }, p2: { mode: 'resume' }, p3: null }), {
    p1: [emptyCommand('c1', 'npm run dev')]
  })
})

test('títulos e ids', () => {
  assert.equal(commandTitle({ name: '', command: 'npm run dev' }), 'Monstruito: npm run dev')
  assert.equal(commandTitle({ name: 'web', command: 'npm run dev' }), 'Monstruito: web')
  assert.equal(newCommandId([{ id: 'c1' }, { id: 'c3' }]), 'c4')
  assert.equal(newCommandId([{ id: 'c2' }]), 'c3')
})
