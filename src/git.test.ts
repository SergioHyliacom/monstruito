import { assert, test } from 'orca/testing'
import { syncProject, type GitResult, type GitRunner, type SyncOptions } from './git'

const ok = (stdout = ''): GitResult => ({ ok: true, stdout, stderr: '' })
const fail = (stderr: string): GitResult => ({ ok: false, stdout: '', stderr })

/**
 * Una rama con 2 commits locales y 3 nuevos en la remota. Cada orden (sus argumentos unidos por
 * espacios) responde lo que diga el guion; `steadyCalls` son las que fueron por el git que Detener
 * no corta.
 */
function divergedRepo(answers: { rebase?: GitResult; abort?: GitResult; split?: string } = {}) {
  let head = 'aaa'
  const calls: string[] = []
  const steadyCalls: string[] = []
  const script: Record<string, () => GitResult> = {
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': () => ok('origin/main\n'),
    'fetch --quiet': () => ok(),
    'rev-parse HEAD': () => ok(`${head}\n`),
    'merge --ff-only --no-autostash @{u}': () => fail('fatal: Not possible to fast-forward, aborting.'),
    'rev-list --left-right --count HEAD...@{u}': () => ok(answers.split ?? '2\t3\n'),
    'rev-list --count HEAD..@{u}': () => ok(head === 'aaa' ? '3\n' : '0\n'),
    'log --oneline --no-decorate -n 30 HEAD..@{u}': () => ok('r1 Uno\nr2 Dos\nr3 Tres\n'),
    'rebase --no-autostash --no-autosquash @{u}': () => {
      const result = answers.rebase ?? ok()
      if (result.ok) head = 'ccc'
      return result
    },
    'rebase --abort': () => answers.abort ?? ok(),
    'rev-list --count @{u}..HEAD': () => ok('2\n'),
    'diff --name-only aaa ccc': () => ok('package-lock.json\n')
  }
  const answer = (key: string) => script[key]?.() ?? fail(`orden inesperada: ${key}`)
  const git: GitRunner = async (_cwd, args) => {
    calls.push(args.join(' '))
    return answer(args.join(' '))
  }
  const steady: GitRunner = async (_cwd, args) => {
    steadyCalls.push(args.join(' '))
    return answer(args.join(' '))
  }
  return { git, steady, calls, steadyCalls }
}

const options = (extra: Partial<SyncOptions> = {}): SyncOptions => ({
  mode: 'pull',
  fetchAll: false,
  skipIfDirty: false,
  updateSubmodules: false,
  rebaseIfDiverged: true,
  reportAhead: true,
  ...extra
})

test('con rebase, una rama divergida se pone encima de la remota y cuenta lo que trajo', async () => {
  const repo = divergedRepo()
  const synced = await syncProject(repo.git, '/p', options({ steady: repo.steady }))
  assert.deepEqual(synced.outcome, {
    kind: 'updated',
    upstream: 'origin/main',
    count: 3,
    commits: ['r1 Uno', 'r2 Dos', 'r3 Tres'],
    rebased: 2,
    ahead: 2
  })
  assert.deepEqual(synced.changedFiles, ['package-lock.json'], 'los archivos cambiados sirven para instalar')
  assert.deepEqual(repo.steadyCalls, ['rebase --no-autostash --no-autosquash @{u}'], 'el rebase no se corta con Detener')
})

test('si el rebase choca, lo deshace y lo cuenta', async () => {
  const repo = divergedRepo({ rebase: fail('error: could not apply r9... Local\nhint: Resolve all conflicts manually') })
  const synced = await syncProject(repo.git, '/p', options({ steady: repo.steady }))
  assert.deepEqual(synced.outcome, {
    kind: 'failed',
    step: 'rebase',
    message: 'error: could not apply r9... Local Rebase aborted: the branch is as it was.',
    ahead: 2
  })
  assert.deepEqual(repo.steadyCalls, ['rebase --no-autostash --no-autosquash @{u}', 'rebase --abort'])
  assert.deepEqual(synced.changedFiles, [])
})

test('si el rebase ni empieza, no hay nada que deshacer', async () => {
  const repo = divergedRepo({
    rebase: fail('error: cannot rebase: You have unstaged changes.'),
    abort: fail('fatal: No rebase in progress?')
  })
  const synced = await syncProject(repo.git, '/p', options({ steady: repo.steady }))
  assert.equal(synced.outcome.kind, 'failed')
  assert.ok(synced.outcome.kind === 'failed' && synced.outcome.message.endsWith('Rebase aborted: the branch is as it was.'))
})

test('si tampoco se puede abortar el rebase, pide arreglarlo a mano', async () => {
  const repo = divergedRepo({
    rebase: fail('error: could not apply r9... Local'),
    abort: fail('fatal: could not move back to aaa')
  })
  const synced = await syncProject(repo.git, '/p', options({ steady: repo.steady }))
  assert.ok(synced.outcome.kind === 'failed' && synced.outcome.message.includes('finish or abort the rebase by hand'))
})

test('sin la opción, una rama divergida no se toca y se cuentan los commits sin subir', async () => {
  const repo = divergedRepo()
  const synced = await syncProject(repo.git, '/p', options({ rebaseIfDiverged: false, steady: repo.steady }))
  assert.deepEqual(synced.outcome, {
    kind: 'failed',
    step: 'merge',
    message: 'fatal: Not possible to fast-forward, aborting.',
    ahead: 2
  })
  assert.ok(!repo.calls.some((call) => call.startsWith('rebase') || call.includes('--left-right')))
  assert.deepEqual(repo.steadyCalls, [])
})

test('si el avance falla sin que la rama haya divergido, no hay rebase', async () => {
  const repo = divergedRepo({ split: '0\t3\n' })
  const synced = await syncProject(repo.git, '/p', options({ steady: repo.steady }))
  assert.equal(synced.outcome.kind === 'failed' && synced.outcome.step, 'merge')
  assert.deepEqual(repo.steadyCalls, [])
})

test('si se pulsa Detener antes del rebase, no empieza', async () => {
  const repo = divergedRepo()
  const synced = await syncProject(repo.git, '/p', options({ steady: repo.steady, stopped: () => true }))
  assert.deepEqual(synced.outcome, { kind: 'cancelled' })
  assert.deepEqual(repo.steadyCalls, [])
})

test('con «Report unpushed commits» apagado no se cuentan', async () => {
  const repo = divergedRepo()
  const synced = await syncProject(repo.git, '/p', options({ rebaseIfDiverged: false, reportAhead: false }))
  assert.ok(!('ahead' in synced.outcome))
  assert.ok(!repo.calls.includes('rev-list --count @{u}..HEAD'))
})
