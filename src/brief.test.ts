import { assert, test } from 'orca/testing'
import { buildBrief, failuresOf, WRAP_PROMPT, type BriefContext } from './brief'
import type { ProjectResult } from './protocol'

const context = (extra: Partial<BriefContext> = {}): BriefContext => ({
  project: 'web',
  branch: 'main',
  git: { kind: 'updated', upstream: 'origin/main', count: 2, commits: [] },
  failures: [],
  note: null,
  requests: [],
  proposeCommands: false,
  extra: '',
  ...extra
})

test('el brief cuenta la rutina y pide dejar el proyecto listo, sin borrar ni subir nada', () => {
  const brief = buildBrief(context())
  assert.ok(brief.startsWith('Monstruito just prepared web on main: I pulled 2 new commits from origin/main. Nothing failed.'))
  assert.ok(brief.includes('Upgrade the dependencies'))
  assert.ok(brief.includes('design systems, fonts and UI libraries'))
  assert.ok(brief.includes('Update the plugins'))
  assert.ok(brief.includes('Clean up only what the tools regenerate'))
  assert.ok(brief.includes('Never delete my files, commit, push, reset or stash without asking me first.'))
  assert.ok(brief.includes('write .monstruito/ready.md'))
  assert.ok(brief.includes('"Next: <the next item>"'))
  assert.ok(brief.includes('There is no note from last time.'))
  assert.ok(!brief.includes('commands.json'), 'si ya tiene comandos, no se los pide')
  assert.ok(!/\n/.test(brief), 'una sola línea')
})

test('el brief lleva los fallos, la nota de ayer, lo abierto en Requests y lo de más', () => {
  const brief = buildBrief(
    context({
      git: { kind: 'failed', step: 'fetch', message: 'fatal: could not read Username' },
      failures: ['npm install (ERESOLVE)'],
      note: 'Stopped at the pricing table.\nNext: the mobile header',
      requests: [
        { id: 'k3fp', title: 'Fix the login copy', status: 'need' },
        { id: 'a1b2', title: 'Pricing page', status: 'run' }
      ],
      proposeCommands: true,
      extra: 'Use pnpm.'
    })
  )
  assert.ok(brief.includes('git failed (fatal: could not read Username)'))
  assert.ok(brief.includes('These steps failed: npm install (ERESOLVE).'))
  assert.ok(brief.includes('says: "Stopped at the pricing table. Next: the mobile header"'))
  assert.ok(brief.includes('[k3fp] Fix the login copy (needs me); [a1b2] Pricing page (in progress)'))
  assert.ok(brief.includes('propose them in .monstruito/commands.json'))
  assert.ok(brief.endsWith('Also: Use pnpm.'))
})

test('una nota muy larga se recorta para que el brief quepa en 4000 caracteres', () => {
  const brief = buildBrief(context({ note: 'x'.repeat(10_000), extra: 'y'.repeat(500) }))
  assert.ok(brief.length <= 4000)
  assert.ok(brief.includes('write .monstruito/ready.md'), 'lo importante no se pierde')
  assert.ok(brief.includes('…"'))
})

test('los fallos de la rutina salen de git, las dependencias y los comandos de preparación', () => {
  const result: ProjectResult = {
    projectId: 'p1',
    name: 'web',
    path: '/web',
    git: { kind: 'failed', step: 'merge', message: 'fatal: Not possible to fast-forward' },
    agent: { kind: 'cancelled' },
    deps: [
      { command: 'npm install', kind: 'failed', message: 'ERESOLVE' },
      { command: 'composer install', kind: 'ok' }
    ],
    commands: [
      { name: 'migrate', kind: 'prepare', result: 'failed', message: 'SQLSTATE' },
      { name: 'dev', kind: 'tab', result: 'opened' }
    ],
    worktrees: []
  }
  assert.deepEqual(failuresOf(result), [
    'git (fatal: Not possible to fast-forward)',
    'npm install (ERESOLVE)',
    'migrate (SQLSTATE)'
  ])
})

test('el cierre pide la nota para mañana y nada más', () => {
  assert.ok(WRAP_PROMPT.includes('.monstruito/next.md'))
  assert.ok(WRAP_PROMPT.includes("don't commit, push or change anything else"))
  assert.ok(!/\n/.test(WRAP_PROMPT))
})
