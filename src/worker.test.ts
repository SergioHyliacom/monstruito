// Ejecuta el `activate(orca)` del worker sobre un Orca de mentira, con git y shell de mentira.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca/worker'
import type { ModelLaunch, Port } from './cli'
import type { ShellRunner } from './deps'
import type { GitResult, GitRunner } from './git'
import type { PendingCheck, RunRecord } from './protocol'
import { createActivate, type WorkerDeps } from './worker'

const PATH = 'D:\\Proyectos\\web'
const PROJECT = { id: 'p1', name: 'web', kind: 'git', hostId: 'local', path: PATH }
const status = (lastActivityAt: number) => ({ state: 'inactive', unread: false, terminalCount: 1, lastActivityAt })
const WORKSPACE = {
  id: 'p1::D:/Proyectos/web',
  kind: 'worktree',
  name: 'main',
  projectId: 'p1',
  path: 'D:/Proyectos/web',
  branch: 'refs/heads/main',
  hostId: 'local',
  status: status(3000)
}
const OTHER_WORKTREE = {
  ...WORKSPACE,
  id: 'p1::D:/Proyectos/web-feature',
  name: 'feature',
  path: 'D:/Proyectos/web-feature',
  branch: 'feature/login',
  status: status(1000)
}
const CLAUDE_OPEN = { terminalId: 't9', title: 'x', agent: 'claude', state: 'done', stateStartedAt: 1 }

type RepoOptions = {
  upstream?: boolean
  dirty?: boolean
  mergeFails?: string
  commits?: string[]
  changedFiles?: string[]
  behind?: Record<string, number>
}

/** Un repositorio de mentira: `commits` son los que hay en la remota y no en local. */
function fakeRepo(options: RepoOptions = {}) {
  const calls: string[][] = []
  const callsIn: { cwd: string; args: string[] }[] = []
  let head = 'aaa'
  const commits = options.commits ?? []
  const ok = (stdout = ''): GitResult => ({ ok: true, stdout, stderr: '' })
  const fail = (stderr: string): GitResult => ({ ok: false, stdout: '', stderr })
  const pendingIn = (range: string) =>
    range === 'HEAD..@{u}' ? (head === 'aaa' ? commits : []) : range === 'aaa..bbb' ? commits : []
  const git: GitRunner = async (cwd, args) => {
    calls.push(args)
    callsIn.push({ cwd, args })
    if (cwd !== PATH) {
      // Otro worktree: solo se le pregunta cuánto va por detrás.
      if (args[0] === 'rev-parse') return ok('origin/feature\n')
      if (args[0] === 'rev-list') return ok(String(options.behind?.[cwd] ?? 0))
    }
    switch (args[0]) {
      case 'rev-parse':
        if (args.includes('@{u}')) return options.upstream === false ? fail('fatal: no upstream configured') : ok('origin/main\n')
        return ok(`${head}\n`)
      case 'status':
        return ok(options.dirty ? ' M src/app.ts\n' : '')
      case 'fetch':
        return ok()
      case 'merge':
        if (options.mergeFails) return fail(options.mergeFails)
        if (commits.length) head = 'bbb'
        return ok()
      case 'rev-list':
        return ok(String(pendingIn(args[2]).length))
      case 'log':
        return ok(pendingIn(args[args.length - 1]).join('\n'))
      case 'diff':
        return ok((options.changedFiles ?? []).join('\n'))
      case 'submodule':
        return ok()
      default:
        return fail(`orden inesperada: ${args.join(' ')}`)
    }
  }
  return { git, calls, callsIn }
}

function setupWorker(
  git: GitRunner,
  host: {
    storage?: Record<string, JsonValue>
    settings?: Record<string, JsonValue>
    agents?: unknown[]
    sessions?: unknown[]
    terminals?: unknown[]
    workspaces?: unknown[]
  } = {},
  overrides: Partial<WorkerDeps> = {}
) {
  let startup: Promise<void> = Promise.resolve()
  const shellCalls: { cwd: string; command: string }[] = []
  const sleeps: number[] = []
  const modelLaunches: ModelLaunch[] = []
  const webOpened: { path: string; url: string }[] = []
  /** Lo que devuelve cada llamada a «puertos»; la última se repite. */
  const portScans: Port[][] = [[]]
  const shell: ShellRunner = async (cwd, command) => {
    shellCalls.push({ cwd, command })
    return { ok: true, output: '' }
  }
  const orca = mockHost({
    storage: host.storage ?? { selection: ['p1'] },
    settings: { startupDelaySeconds: 0, ...host.settings },
    results: {
      'project.list': { projects: [PROJECT], truncated: false },
      'workspace.list': { workspaces: host.workspaces ?? [WORKSPACE], truncated: false },
      'agents.list': { agents: host.agents ?? [] },
      'agent.launch': { terminalId: 't1' },
      'agent.listSessions': { sessions: host.sessions ?? [], truncated: false },
      'agent.resume': { terminalId: 't2', started: true },
      'terminal.list': { terminals: host.terminals ?? [], truncated: false },
      'terminal.create': { terminalId: 't3' },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  const deps: WorkerDeps = {
    git,
    shell,
    readText: async () => 'dependencies:\n  flutter:\n    sdk: flutter\n',
    launchWithModel: async (launch) => {
      modelLaunches.push(launch)
    },
    // Por defecto nada existe: «Instalar si faltan» no encuentra manifiestos.
    exists: () => false,
    web: {
      ports: async () => (portScans.length > 1 ? portScans.shift()! : portScans[0]),
      open: async (path, url) => {
        webOpened.push({ path, url })
      }
    },
    parentPid: 4242,
    bootTime: 1000,
    now: () => 5000,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    projectWait: { attempts: 1, intervalMs: 0 },
    onStartup: (task) => {
      startup = task
    },
    ...overrides
  }
  return {
    host: orca,
    shellCalls,
    sleeps,
    modelLaunches,
    webOpened,
    portScans,
    mount: async () => {
      const worker = await mountWorker({ default: createActivate(deps) }, { host: orca })
      await startup
      return worker
    }
  }
}

function history(host: { data(): { storage: Record<string, unknown> } }): RunRecord[] {
  return (host.data().storage.history as RunRecord[] | undefined) ?? []
}

function lastRun(host: { data(): { storage: Record<string, unknown> } }): RunRecord {
  return history(host)[0]
}

type Launch = { workspaceId: string; agent: string; prompt?: string }

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 1))
  assert.ok(condition(), 'la condición no llegó a cumplirse')
}

// ——— Arranque y git ———

test('al abrir Orca trae los cambios y abre Claude con el resumen', async () => {
  const repo = fakeRepo({ commits: ['bbb Arregla el login', 'ccc Añade pruebas'] })
  const { host, mount } = setupWorker(repo.git, { settings: { mode: 'summarize' } })
  const worker = await mount()

  assert.ok(repo.calls.some((args) => args.join(' ') === 'merge --ff-only --no-autostash @{u}'))
  const launches = host.callsOf('agent.launch') as Launch[]
  assert.equal(launches.length, 1)
  assert.equal(launches[0].workspaceId, WORKSPACE.id)
  assert.equal(launches[0].agent, 'claude')
  assert.ok(launches[0].prompt?.includes('2 commits nuevos de origin/main'))
  assert.ok(launches[0].prompt?.includes('bbb Arregla el login'))
  assert.ok(!launches[0].prompt?.includes('\n'), 'el prompt va en una sola línea')

  const run = lastRun(host)
  assert.equal(run.trigger, 'startup')
  assert.deepEqual(run.results[0].git, {
    kind: 'updated',
    upstream: 'origin/main',
    count: 2,
    commits: ['bbb Arregla el login', 'ccc Añade pruebas']
  })
  assert.deepEqual(run.results[0].agent, { kind: 'launched', agent: 'claude', withPrompt: true })
  assert.deepEqual(host.data().storage.session, { parentPid: 4242, at: 5000 })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('espera lo configurado antes de empezar', async () => {
  const { sleeps, mount } = setupWorker(fakeRepo().git, { settings: { startupDelaySeconds: 10 } })
  const worker = await mount()
  assert.ok(sleeps.includes(10_000))
  await worker.deactivate()
})

test('en modo esperar abre Claude sin prompt', async () => {
  const { host, mount } = setupWorker(fakeRepo({ commits: ['bbb Algo'] }).git)
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: WORKSPACE.id, agent: 'claude' }])
  await worker.deactivate()
})

test('no repite si el worker se reinicia con Orca abierto', async () => {
  const repo = fakeRepo({ commits: ['bbb Algo'] })
  const { host, mount } = setupWorker(repo.git, {
    storage: { selection: ['p1'], session: { parentPid: 4242, at: 2000 } }
  })
  const worker = await mount()
  assert.deepEqual(repo.calls, [])
  assert.deepEqual(host.callsOf('agent.launch'), [])
  await worker.deactivate()
})

test('tras reiniciar el equipo vuelve a ejecutarse aunque el pid coincida', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, {
    storage: { selection: ['p1'], session: { parentPid: 4242, at: 500 } }
  })
  const worker = await mount()
  assert.equal(host.callsOf('agent.launch').length, 1)
  assert.deepEqual(lastRun(host).results[0].git, { kind: 'up-to-date', upstream: 'origin/main' })
  await worker.deactivate()
})

test('con "Ejecutar al abrir Orca" apagado no hace nada al arrancar', async () => {
  const repo = fakeRepo({ commits: ['bbb Algo'] })
  const { host, mount } = setupWorker(repo.git, { settings: { runOnStartup: false } })
  const worker = await mount()
  assert.deepEqual(repo.calls, [])
  assert.deepEqual(host.callsOf('agent.launch'), [])
  await worker.deactivate()
})

test('si git no puede avanzar lo cuenta y abre Claude igualmente', async () => {
  const repo = fakeRepo({ mergeFails: 'hint: x\nfatal: Not possible to fast-forward, aborting.\n' })
  const { host, mount } = setupWorker(repo.git, { settings: { mode: 'summarize' } })
  const worker = await mount()
  assert.deepEqual(lastRun(host).results[0].git, {
    kind: 'failed',
    step: 'merge',
    message: 'fatal: Not possible to fast-forward, aborting.'
  })
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: WORKSPACE.id, agent: 'claude' }])
  await worker.deactivate()
})

test('una rama sin remota no se toca', async () => {
  const repo = fakeRepo({ upstream: false })
  const { host, mount } = setupWorker(repo.git)
  const worker = await mount()
  assert.deepEqual(lastRun(host).results[0].git, { kind: 'no-upstream' })
  assert.ok(!repo.calls.some((args) => args[0] === 'fetch' || args[0] === 'merge'))
  await worker.deactivate()
})

test('en modo solo descargar no mueve la rama y cuenta lo que hay por traer', async () => {
  const repo = fakeRepo({ commits: ['bbb Uno', 'ccc Dos'] })
  const { host, mount } = setupWorker(repo.git, { settings: { gitMode: 'fetch', mode: 'summarize' } })
  const worker = await mount()
  assert.ok(!repo.calls.some((args) => args[0] === 'merge'))
  assert.deepEqual(lastRun(host).results[0].git, {
    kind: 'fetched',
    upstream: 'origin/main',
    count: 2,
    commits: ['bbb Uno', 'ccc Dos']
  })
  const [launch] = host.callsOf('agent.launch') as Launch[]
  assert.ok(launch.prompt?.includes('todavía no están en tu rama'))
  await worker.deactivate()
})

test('con git apagado no se ejecuta ninguna orden de git', async () => {
  const repo = fakeRepo({ commits: ['bbb Uno'] })
  const { host, mount } = setupWorker(repo.git, { settings: { gitMode: 'none' } })
  const worker = await mount()
  assert.deepEqual(repo.calls, [])
  assert.deepEqual(lastRun(host).results[0].git, { kind: 'skipped' })
  await worker.deactivate()
})

test('salta los proyectos con cambios sin commitear si se pide', async () => {
  const repo = fakeRepo({ dirty: true, commits: ['bbb Uno'] })
  const { host, mount } = setupWorker(repo.git, { settings: { skipIfDirty: true } })
  const worker = await mount()
  assert.deepEqual(lastRun(host).results[0].git, { kind: 'dirty' })
  assert.ok(!repo.calls.some((args) => args[0] === 'fetch' || args[0] === 'merge'))
  await worker.deactivate()
})

test('todas las ramas, submódulos y demás worktrees', async () => {
  const repo = fakeRepo({ commits: ['bbb Uno'], behind: { 'D:/Proyectos/web-feature': 3 } })
  const { host, mount } = setupWorker(repo.git, {
    settings: { fetchAll: true, updateSubmodules: true, fetchOtherWorktrees: true },
    workspaces: [WORKSPACE, OTHER_WORKTREE]
  })
  const worker = await mount()
  assert.ok(repo.calls.some((args) => args.join(' ') === 'fetch --all --prune --quiet'))
  assert.ok(repo.calls.some((args) => args.join(' ') === 'submodule update --init --recursive'))
  const result = lastRun(host).results[0]
  assert.deepEqual(result.git, {
    kind: 'updated',
    upstream: 'origin/main',
    count: 1,
    commits: ['bbb Uno'],
    submodules: { ok: true }
  })
  assert.deepEqual(result.worktrees, [{ name: 'feature', branch: 'feature/login', behind: 3 }])
  await worker.deactivate()
})

// ——— Agente ———

test('no abre otro Claude si ya hay uno en ese workspace', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { agents: [CLAUDE_OPEN] })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [])
  assert.deepEqual(lastRun(host).results[0].agent, { kind: 'already-open', agent: 'claude' })
  await worker.deactivate()
})

test('en modo retomar reabre la última sesión del agente', async () => {
  const session = (sessionId: string, title: string, updatedAt: number) => ({
    sessionId,
    agent: 'claude',
    title,
    workspaceId: WORKSPACE.id,
    hostId: 'local',
    branch: 'main',
    createdAt: 1,
    updatedAt,
    messageCount: 3,
    totalTokens: 4,
    running: false
  })
  const { host, mount } = setupWorker(fakeRepo().git, {
    settings: { mode: 'resume' },
    sessions: [session('s2', 'Login nuevo', 20), session('s1', 'Viejo', 10)]
  })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.resume'), [{ workspaceId: WORKSPACE.id, agent: 'claude', sessionId: 's2' }])
  assert.deepEqual(host.callsOf('agent.launch'), [])
  assert.deepEqual(lastRun(host).results[0].agent, { kind: 'resumed', agent: 'claude', title: 'Login nuevo' })
  await worker.deactivate()
})

test('solo abre el agente si hay commits nuevos, si se pide', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { settings: { onlyWithCommits: true } })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [])
  assert.deepEqual(lastRun(host).results[0].agent, { kind: 'no-commits' })
  await worker.deactivate()
})

test('"No abrir agente" no abre ninguno', async () => {
  const { host, mount } = setupWorker(fakeRepo({ commits: ['bbb Uno'] }).git, { settings: { mode: 'none' } })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [])
  assert.deepEqual(lastRun(host).results[0].agent, { kind: 'disabled' })
  await worker.deactivate()
})

test('el prompt propio rellena las variables y va siempre en modo prompt', async () => {
  const { host, mount } = setupWorker(fakeRepo({ commits: ['bbb Uno', 'ccc Dos'] }).git, {
    settings: {
      mode: 'prompt',
      agent: 'codex',
      prompt: 'Proyecto {proyecto} en {rama}:\n{n_commits} de {remota} → {commits}. {desconocida}'
    }
  })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [
    {
      workspaceId: WORKSPACE.id,
      agent: 'codex',
      prompt: 'Proyecto web en main: 2 de origin/main → bbb Uno; ccc Dos. {desconocida}'
    }
  ])
  await worker.deactivate()
})

test('los ajustes de un proyecto mandan sobre los globales', async () => {
  const { host, mount } = setupWorker(fakeRepo({ commits: ['bbb Uno'] }).git, {
    settings: { mode: 'wait', agent: 'claude' },
    storage: { selection: ['p1'], overrides: { p1: { agent: 'copilot', mode: 'summarize', prompt: 'Hola {proyecto}' } } }
  })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: WORKSPACE.id, agent: 'copilot', prompt: 'Hola web' }])
  await worker.deactivate()
})

test('con modelo abre el agente por la CLI de Orca, con modelo y razonamiento', async () => {
  const { host, modelLaunches, mount } = setupWorker(fakeRepo({ commits: ['bbb Uno'] }).git, {
    settings: { model: 'opus', effort: 'high', mode: 'summarize' }
  })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [], 'no por la API de plugins')
  assert.equal(modelLaunches.length, 1)
  const [launch] = modelLaunches
  assert.deepEqual({ ...launch, prompt: undefined }, {
    path: WORKSPACE.path,
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    prompt: undefined
  })
  assert.ok(launch.prompt?.includes('1 commits nuevos de origin/main'))
  assert.deepEqual(lastRun(host).results[0].agent, { kind: 'launched', agent: 'claude', withPrompt: true, model: 'opus' })
  await worker.deactivate()
})

test('el modelo va con su agente: un proyecto con otro agente no hereda el modelo', async () => {
  const { host, modelLaunches, mount } = setupWorker(fakeRepo().git, {
    settings: { agent: 'claude', model: 'opus' },
    storage: { selection: ['p1'], overrides: { p1: { agent: 'codex' } } }
  })
  const worker = await mount()
  assert.deepEqual(modelLaunches, [])
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: WORKSPACE.id, agent: 'codex' }])
  await worker.deactivate()
})

test('los agentes que no eligen modelo lo ignoran, y OpenCode va sin razonamiento', async () => {
  const copilot = setupWorker(fakeRepo().git, { settings: { agent: 'copilot', model: 'gpt-x', effort: 'high' } })
  let worker = await copilot.mount()
  assert.deepEqual(copilot.modelLaunches, [])
  assert.deepEqual(copilot.host.callsOf('agent.launch'), [{ workspaceId: WORKSPACE.id, agent: 'copilot' }])
  await worker.deactivate()

  const opencode = setupWorker(fakeRepo().git, { settings: { agent: 'opencode', model: 'anthropic/claude', effort: 'high' } })
  worker = await opencode.mount()
  assert.deepEqual(opencode.modelLaunches, [
    { path: WORKSPACE.path, agent: 'opencode', model: 'anthropic/claude', effort: undefined, prompt: undefined }
  ])
  await worker.deactivate()
})

test('si la CLI de Orca no puede abrir el agente, se cuenta', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { settings: { model: 'no-existe' } }, {
    launchWithModel: async () => {
      throw new Error('Unknown model: no-existe')
    }
  })
  const worker = await mount()
  assert.deepEqual(lastRun(host).results[0].agent, { kind: 'failed', message: 'Unknown model: no-existe' })
  await worker.deactivate()
})

test('escalona la apertura de agentes', async () => {
  const second = { ...PROJECT, id: 'p2', name: 'api', path: 'D:\\Proyectos\\api' }
  const secondWorkspace = { ...WORKSPACE, id: 'p2::D:/Proyectos/api', projectId: 'p2', path: 'D:/Proyectos/api' }
  const { host, sleeps, mount } = setupWorker(fakeRepo().git, {
    settings: { staggerSeconds: 5, gitMode: 'none' },
    storage: { selection: ['p1', 'p2'] },
    workspaces: [WORKSPACE, secondWorkspace]
  })
  host.respond('project.list', { projects: [PROJECT, second], truncated: false })
  const worker = await mount()
  assert.equal(host.callsOf('agent.launch').length, 2)
  assert.deepEqual(sleeps.filter((ms) => ms === 5000), [5000], 'una espera entre los dos')
  await worker.deactivate()
})

// ——— Comandos ———

test('instala dependencias si el avance cambia un lockfile', async () => {
  const repo = fakeRepo({
    commits: ['bbb Sube dependencias'],
    changedFiles: ['package-lock.json', 'composer.lock', 'pubspec.lock', 'apps/web/pnpm-lock.yaml', 'README.md']
  })
  const { host, shellCalls, mount } = setupWorker(repo.git)
  const worker = await mount()
  assert.deepEqual(
    shellCalls.map((call) => call.command),
    ['npm install', 'composer install', 'flutter pub get'],
    'solo lockfiles de la raíz'
  )
  assert.ok(shellCalls.every((call) => call.cwd === PATH))
  assert.deepEqual(
    lastRun(host).results[0].deps.map((step) => step.kind),
    ['ok', 'ok', 'ok']
  )
  await worker.deactivate()
})

test('sin avance no instala nada', async () => {
  const { shellCalls, mount } = setupWorker(fakeRepo({ changedFiles: ['package-lock.json'] }).git)
  const worker = await mount()
  assert.deepEqual(shellCalls, [])
  await worker.deactivate()
})

const cmd = (id: string, command: string, extra: Record<string, JsonValue> = {}) => ({
  id,
  name: '',
  command,
  kind: 'tab',
  when: 'always',
  files: [],
  restart: false,
  openUrl: false,
  enabled: true,
  ...extra
})

test('el comando de arranque de la 0.3 pasa a la lista y se abre en su pestaña, una sola vez', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, {
    storage: { selection: ['p1'], overrides: { p1: { startCommand: 'npm run dev' } } }
  })
  const worker = await mount()
  assert.deepEqual(host.callsOf('terminal.create'), [
    { workspaceId: WORKSPACE.id, title: 'Monstruito: npm run dev', command: 'npm run dev' }
  ])
  assert.deepEqual(lastRun(host).results[0].commands, [{ name: 'npm run dev', kind: 'tab', result: 'opened' }])
  const state = await worker.request('state.get')
  assert.deepEqual(state.commands.p1.map((item) => item.command), ['npm run dev'])

  host.respond('terminal.list', { terminals: [{ id: 't3', title: 'Monstruito: npm run dev' }], truncated: false })
  await worker.command('monstruito.run')
  assert.equal(host.callsOf('terminal.create').length, 1)
  assert.deepEqual(lastRun(host).results[0].commands, [{ name: 'npm run dev', kind: 'tab', result: 'already-open' }])
  await worker.deactivate()
})

test('preparación antes del agente, pestañas después, y cada una con su condición', async () => {
  const order: string[] = []
  const repo = fakeRepo({ commits: ['bbb Uno'], changedFiles: ['database/migrations/2026_add.php', 'README.md'] })
  const { host, shellCalls, mount } = setupWorker(repo.git, {
    settings: { installMissing: false },
    storage: {
      selection: ['p1'],
      commands: {
        p1: [
          cmd('c1', 'docker compose up -d', { kind: 'prepare' }),
          cmd('c2', 'php artisan migrate --force', { kind: 'prepare', when: 'files', files: ['database/migrations/'] }),
          cmd('c3', 'npm run build', { kind: 'prepare', when: 'files', files: ['src/**/*.ts'] }),
          cmd('c4', 'php artisan serve', { name: 'servidor', when: 'commits' }),
          cmd('c5', 'npm run storybook', { enabled: false })
        ]
      }
    }
  }, {
    shell: async (cwd, command) => {
      order.push(`shell:${command}`)
      shellCalls.push({ cwd, command })
      return { ok: true, output: '' }
    }
  })
  host.respond('agent.launch', () => {
    order.push('agente')
    return { terminalId: 't1' }
  })
  host.respond('terminal.create', (params: { title: string }) => {
    order.push(`pestaña:${params.title}`)
    return { terminalId: 't9' }
  })
  const worker = await mount()
  assert.deepEqual(order, [
    'shell:docker compose up -d',
    'shell:php artisan migrate --force',
    'agente',
    'pestaña:Monstruito: servidor'
  ])
  assert.deepEqual(lastRun(host).results[0].commands, [
    { name: 'docker compose up -d', kind: 'prepare', result: 'ok' },
    { name: 'php artisan migrate --force', kind: 'prepare', result: 'ok' },
    { name: 'npm run build', kind: 'prepare', result: 'skipped', message: 'no cambiaron esos archivos' },
    { name: 'npm run storybook', kind: 'tab', result: 'skipped', message: 'desactivado' },
    { name: 'servidor', kind: 'tab', result: 'opened' }
  ])
  await worker.deactivate()
})

test('un comando de preparación que falla se cuenta y el resto sigue', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, {
    storage: { selection: ['p1'], commands: { p1: [cmd('c1', 'make setup', { kind: 'prepare' })] } }
  }, {
    shell: async () => ({ ok: false, output: 'paso 1\nmake: *** [setup] Error 2' })
  })
  const worker = await mount()
  const result = lastRun(host).results[0]
  assert.deepEqual(result.commands, [
    { name: 'make setup', kind: 'prepare', result: 'failed', message: 'paso 1 · make: *** [setup] Error 2' }
  ])
  assert.equal(result.agent.kind, 'launched')
  await worker.deactivate()
})

test('reiniciar cierra la pestaña que abrió el arranque y abre otra', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, {
    terminals: [{ id: 'viejo', title: 'Monstruito: npm run dev' }],
    storage: { selection: ['p1'], commands: { p1: [cmd('c1', 'npm run dev', { restart: true })] } }
  })
  host.respond('terminal.close', { closed: true })
  const worker = await mount()
  assert.deepEqual(host.callsOf('terminal.close'), [{ terminalId: 'viejo' }])
  assert.equal(host.callsOf('terminal.create').length, 1)
  assert.deepEqual(lastRun(host).results[0].commands, [{ name: 'npm run dev', kind: 'tab', result: 'restarted' }])

  // Una pestaña que no abrió el arranque no se puede cerrar: se deja.
  host.respond('terminal.close', () => {
    throw hostError('action_failed', 'not opened by this plugin')
  })
  await worker.command('monstruito.run')
  assert.equal(host.callsOf('terminal.create').length, 1)
  assert.deepEqual(lastRun(host).results[0].commands, [
    {
      name: 'npm run dev',
      kind: 'tab',
      result: 'already-open',
      message: 'No se pudo reiniciar: esa pestaña no la abrió Monstruito.'
    }
  ])
  await worker.deactivate()
})

test('abre la web en cuanto el servidor escucha en un puerto nuevo', async () => {
  const { host, webOpened, portScans, mount } = setupWorker(fakeRepo().git, {
    storage: { selection: ['p1'], commands: { p1: [cmd('c1', 'npm run dev', { openUrl: true })] } }
  })
  // Antes de abrir: 3000 (otra cosa). Luego aún nada nuevo. Luego el servidor en 4321.
  portScans.splice(0, portScans.length, [{ port: 3000 }], [{ port: 3000 }], [
    { port: 3000 },
    { port: 4321, url: 'http://localhost:4321/' }
  ])
  const worker = await mount()
  assert.deepEqual(webOpened, [{ path: WORKSPACE.path, url: 'http://localhost:4321/' }])
  assert.deepEqual(lastRun(host).results[0].commands, [
    { name: 'npm run dev', kind: 'tab', result: 'opened', url: 'http://localhost:4321/' }
  ])
  await worker.deactivate()
})

test('«Ejecutar los comandos» apagado en el perfil no lanza ninguno', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, {
    settings: { runCommands: false },
    storage: { selection: ['p1'], commands: { p1: [cmd('c1', 'npm run dev')] } }
  })
  const worker = await mount()
  assert.deepEqual(host.callsOf('terminal.create'), [])
  assert.deepEqual(lastRun(host).results[0].commands, [])
  await worker.deactivate()
})

test('instala las dependencias que faltan aunque git no traiga nada', async () => {
  const present = new Set(['package.json', 'pnpm-lock.yaml', 'composer.json', 'vendor'])
  const { shellCalls, mount } = setupWorker(fakeRepo().git, {}, {
    exists: (path) => present.has(path.replace(/\\/g, '/').split('/').pop() ?? '')
  })
  const worker = await mount()
  assert.deepEqual(shellCalls.map((call) => call.command), ['pnpm install'], 'composer no: ya hay vendor')
  await worker.deactivate()
})

test('guardar comandos, proponer y cerrar las pestañas abiertas', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { settings: { runOnStartup: false } }, {
    exists: (path) => path.replace(/\\/g, '/').endsWith('/package.json'),
    readText: async () => JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', test: 'vitest' } })
  })
  const worker = await mount()
  const saved = await worker.request('commands.set', {
    projectId: 'p1',
    commands: [cmd('c1', '  npm run dev  ', { openUrl: true }), cmd('c2', '   ')] as never
  })
  assert.deepEqual(saved.commands.p1.map((item) => [item.command, item.openUrl]), [['npm run dev', true]], 'el vacío no se guarda')

  const { suggestions } = await worker.request('commands.suggest', { projectId: 'p1' })
  assert.deepEqual(suggestions.map((item) => [item.command, item.kind]), [
    ['npm run dev', 'tab'],
    ['npm run build', 'prepare'],
    ['npm run test', 'prepare']
  ])

  await worker.command('monstruito.run')
  await worker.command('monstruito.run')
  host.respond('terminal.close', { closed: true })
  let state = await worker.request('state.get')
  assert.equal(state.openedTerminals, 2)
  state = await worker.request('terminals.closeAll')
  assert.equal(host.callsOf('terminal.close').length, 2)
  assert.equal(state.openedTerminals, 0)
  await worker.deactivate()
})

// ——— Avisos y revisión ———

test('avisa al terminar si está activado', async () => {
  const { host, mount } = setupWorker(fakeRepo({ commits: ['bbb Uno'] }).git)
  const worker = await mount()
  assert.deepEqual(host.callsOf('notifications.show'), [
    { title: 'Monstruito', body: 'Principal · 1 proyecto · 1 con commits nuevos · sin problemas' }
  ])
  await worker.deactivate()
})

test('sin aviso si está apagado', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { settings: { notifyOnFinish: false } })
  const worker = await mount()
  assert.deepEqual(host.callsOf('notifications.show'), [])
  await worker.deactivate()
})

test('revisar commits descarga, cuenta y avisa sin mover nada ni abrir agentes', async () => {
  const repo = fakeRepo({ commits: ['bbb Uno', 'ccc Dos'] })
  const { host, mount } = setupWorker(repo.git, { settings: { runOnStartup: false } })
  const worker = await mount()
  const answer = await worker.command('monstruito.check')
  assert.ok(String(answer).includes('web: 2 commits por traer'))
  const pending = host.data().storage.pending as PendingCheck
  assert.deepEqual(pending.projects, [{ projectId: 'p1', name: 'web', upstream: 'origin/main', count: 2 }])
  assert.ok(!repo.calls.some((args) => args[0] === 'merge'))
  assert.deepEqual(host.callsOf('agent.launch'), [])
  assert.deepEqual(host.callsOf('notifications.show'), [
    { title: 'Commits nuevos por traer', body: 'web (2)' }
  ])

  // Una segunda revisión con lo mismo no vuelve a avisar.
  await worker.command('monstruito.check')
  assert.equal(host.callsOf('notifications.show').length, 1)
  await worker.deactivate()
})

// ——— Panel ———

test('un workspace sin actividad (Orca da 0) cuenta como sin uso', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { storage: {} })
  host.respond('workspace.list', { workspaces: [{ ...WORKSPACE, status: status(0) }], truncated: false })
  const worker = await mount()
  const state = await worker.request('state.get')
  assert.equal(state.projects[0].lastUsedAt, null)
  await worker.deactivate()
})

test('el panel marca proyectos, guarda ajustes propios y ejecuta a mano', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { storage: {} })
  const worker = await mount()
  assert.deepEqual(host.callsOf('agent.launch'), [], 'sin proyectos marcados no hace nada')

  const marked = await worker.request('selection.set', { projectId: 'p1', selected: true })
  assert.deepEqual(marked.projects, [
    { id: 'p1', name: 'web', path: PATH, selected: true, customized: false, lastUsedAt: 3000 }
  ])
  assert.deepEqual(host.callsOf('workspace.list').at(-1), { includeStatus: true })

  const custom = await worker.request('override.set', {
    projectId: 'p1',
    override: { mode: 'none', prompt: '   ', installMissing: false }
  })
  assert.equal(custom.projects[0].customized, true)
  assert.deepEqual(custom.overrides, { p1: { mode: 'none', installMissing: false } }, 'un texto vacío hereda')

  const cleared = await worker.request('override.set', { projectId: 'p1', override: null })
  assert.deepEqual(cleared.overrides, {})

  const started = await worker.request('run.start')
  assert.equal(started.running, true)
  await until(() => host.callsOf('agent.launch').length === 1)
  await until(() => lastRun(host)?.trigger === 'manual')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('importar o quitar un workspace avisa al panel', async () => {
  const { mount } = setupWorker(fakeRepo().git, { storage: {} })
  const worker = await mount()
  const before = worker.posts.length
  await worker.emit('workspace.created', {
    workspaceId: 'w2',
    kind: 'worktree',
    path: 'D:/Proyectos/nuevo',
    branch: 'main'
  })
  await until(() => worker.posts.length > before)
  assert.equal(worker.posts.at(-1)?.event, 'state.changed')
  await worker.deactivate()
})

// ——— Perfiles ———

const profile = (id: string, name: string, extra: Record<string, JsonValue> = {}) => ({
  id,
  name,
  selection: [],
  settings: {},
  days: [],
  openAtEnd: '',
  ...extra
})

test('lo marcado antes de los perfiles pasa a «Principal»', async () => {
  const { mount } = setupWorker(fakeRepo().git, { settings: { runOnStartup: false } })
  const worker = await mount()
  const state = await worker.request('state.get')
  assert.deepEqual(
    state.profiles.map((item) => [item.id, item.name, item.selection]),
    [['principal', 'Principal', ['p1']]]
  )
  assert.equal(state.activeProfileId, 'principal')
  assert.equal(state.projects[0].selected, true)
  await worker.deactivate()
})

test('al abrir Orca usa el perfil de ese día y sus ajustes', async () => {
  // deps.now() = 5000 ms desde 1970: un jueves (4).
  const { host, mount } = setupWorker(fakeRepo().git, {
    storage: {
      activeProfile: 'casa',
      profiles: [
        profile('casa', 'Casa', { selection: [] }),
        profile('trabajo', 'Trabajo', { selection: ['p1'], days: [new Date(5000).getDay()], settings: { agent: 'codex' } })
      ]
    }
  })
  const worker = await mount()
  assert.equal(host.data().storage.activeProfile, 'trabajo')
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: WORKSPACE.id, agent: 'codex' }])
  assert.equal(lastRun(host).profile, 'Trabajo')
  await worker.deactivate()
})

test('crear, elegir, cambiar y borrar perfiles', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { settings: { runOnStartup: false } })
  const worker = await mount()

  let state = await worker.request('profile.create', { name: 'Trabajo', copyFrom: 'principal' })
  assert.equal(state.activeProfileId, 'trabajo')
  assert.deepEqual(state.profiles.find((item) => item.id === 'trabajo')?.selection, ['p1'], 'la copia lleva lo marcado')

  state = await worker.request('selection.setMany', { projectIds: ['p1'], selected: false })
  assert.equal(state.projects[0].selected, false)
  state = await worker.request('profile.select', { profileId: 'principal' })
  assert.equal(state.projects[0].selected, true, 'cada perfil tiene su selección')

  // Un día solo puede ser de un perfil.
  await worker.request('profile.update', { profileId: 'principal', patch: { days: [1, 2] } })
  state = await worker.request('profile.update', {
    profileId: 'trabajo',
    patch: { name: '  Empresa ', days: [2, 3], settings: { mode: 'resume', concurrency: 2, prompt: '' } }
  })
  const [principal, trabajo] = state.profiles
  assert.deepEqual(principal.days, [1])
  assert.deepEqual(trabajo.days, [2, 3])
  assert.equal(trabajo.name, 'Empresa')
  assert.deepEqual(trabajo.settings, { mode: 'resume', concurrency: 2 }, 'un texto vacío hereda')

  state = await worker.request('profile.select', { profileId: 'trabajo' })
  assert.equal(state.settings.mode, 'resume', 'los ajustes del perfil van encima de los de todos')
  assert.equal(state.baseSettings.mode, 'wait')

  state = await worker.request('profile.delete', { profileId: 'trabajo' })
  assert.deepEqual(state.profiles.map((item) => item.id), ['principal'])
  assert.equal(state.activeProfileId, 'principal')
  await assert.rejects(worker.request('profile.delete', { profileId: 'principal' }), /al menos un perfil/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('al terminar el arranque muestra el proyecto del perfil', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, {
    storage: { profiles: [profile('principal', 'Principal', { selection: ['p1'], openAtEnd: '__recent' })] }
  })
  host.respond('workspace.open', { opened: true })
  const worker = await mount()
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: WORKSPACE.id }])
  assert.equal(lastRun(host).opened, 'web')

  // A mano no te mueve de sitio.
  await worker.command('monstruito.run')
  assert.equal(host.callsOf('workspace.open').length, 1)
  await worker.deactivate()
})

// ——— Avance, Detener e historial ———

test('avisa al panel del avance de cada proyecto', async () => {
  const { mount } = setupWorker(fakeRepo({ commits: ['bbb Uno'], changedFiles: ['package-lock.json'] }).git)
  const worker = await mount()
  const steps = worker.posts
    .filter((post) => post.event === 'progress.changed')
    .map((post) => {
      const progress = (post.payload as { progress: { active: { step: string }[]; done: number } | null }).progress
      return progress ? `${progress.done}:${progress.active.map((item) => item.step).join(',')}` : 'fin'
    })
  assert.deepEqual(steps, ['0:', '0:', '0:git', '0:deps', '0:agent', '1:', 'fin'])
  await worker.deactivate()
})

test('Detener corta git en marcha y no abre nada más', async () => {
  let fetching!: () => void
  const fetchStarted = new Promise<void>((resolve) => (fetching = resolve))
  const repo = fakeRepo({ commits: ['bbb Uno'] })
  // Un fetch que no acaba hasta que lo cortan.
  const git: GitRunner = (cwd, args, timeoutMs, signal) => {
    if (args[0] !== 'fetch') return repo.git(cwd, args, timeoutMs)
    fetching()
    return new Promise((resolve) =>
      signal?.addEventListener('abort', () => resolve({ ok: false, stdout: '', stderr: 'The operation was aborted' }))
    )
  }
  const { host, mount } = setupWorker(git, { settings: { runOnStartup: false } })
  const worker = await mount()
  await worker.request('run.start')
  await fetchStarted
  const stopping = await worker.request('run.stop')
  assert.equal(stopping.progress?.stopping, true)
  await until(() =>
    worker.posts.some(
      (post) => post.event === 'progress.changed' && (post.payload as { progress: unknown }).progress === null
    )
  )

  const run = lastRun(host)
  assert.equal(run.stopped, true)
  assert.deepEqual(run.results[0].git, { kind: 'cancelled' })
  assert.deepEqual(run.results[0].agent, { kind: 'cancelled' })
  assert.deepEqual(host.callsOf('agent.launch'), [])
  assert.equal(await worker.command('monstruito.stop'), 'No hay nada en marcha.')
  await worker.deactivate()
})

test('guarda las últimas 10 ejecuciones', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, { settings: { runOnStartup: false, notifyOnFinish: false } })
  const worker = await mount()
  for (let i = 0; i < 12; i++) await worker.command('monstruito.run')
  assert.equal(history(host).length, 10)
  const state = await worker.request('state.get')
  assert.equal(state.history.length, 10)
  assert.equal(state.lastRun, state.history[0])
  await worker.deactivate()
})

// ——— Exportar e importar ———

test('exporta e importa la configuración, y se puede deshacer', async () => {
  const { host, mount } = setupWorker(fakeRepo().git, {
    settings: { runOnStartup: false, mode: 'summarize' },
    storage: {
      profiles: [profile('principal', 'Principal', { selection: ['p1'], days: [1], openAtEnd: 'p1' })],
      overrides: { p1: { installDeps: false } },
      commands: { p1: [cmd('c1', 'npm run dev')] }
    }
  })
  const worker = await mount()
  const { fileName, text } = await worker.request('config.export')
  assert.equal(fileName, 'monstruito-1970-01-01.json')
  const file = JSON.parse(text)
  assert.deepEqual(file.profiles, [
    {
      name: 'Principal',
      days: [1],
      openAtEnd: { name: 'web', path: PATH },
      settings: {},
      projects: [{ name: 'web', path: PATH }]
    }
  ])
  assert.deepEqual(file.projectSettings, [{ project: { name: 'web', path: PATH }, override: { installDeps: false } }])
  assert.deepEqual(file.projectCommands, [{ project: { name: 'web', path: PATH }, commands: [cmd('c1', 'npm run dev')] }])
  assert.equal(file.settings.mode, 'summarize')

  // En "otro equipo": el proyecto está en otra ruta pero se llama igual, y hay uno que no existe.
  file.profiles[0].projects = [{ name: 'web', path: 'C:/otra/ruta/web' }, { name: 'perdido', path: 'C:/perdido' }]
  file.profiles.push({ name: 'Casa', days: [6, 0], openAtEnd: '', settings: { agent: 'codex' }, projects: [] })
  file.activeProfile = 'Casa'
  file.settings.mode = 'resume'
  file.projectCommands[0].commands.push(cmd('c2', 'npm run storybook'))
  const { state, report } = await worker.request('config.import', { text: JSON.stringify(file) })
  assert.deepEqual(state.commands.p1.map((item) => item.command), ['npm run dev', 'npm run storybook'])
  assert.deepEqual(report, { profiles: 2, matched: 1, missing: ['perdido'] })
  assert.deepEqual(state.profiles.map((item) => [item.name, item.selection]), [['Principal', ['p1']], ['Casa', []]])
  assert.equal(state.activeProfileId, 'casa')
  assert.equal(state.baseSettings.mode, 'resume')
  assert.equal(state.canUndoImport, true)

  const undone = await worker.request('config.undoImport')
  assert.deepEqual(undone.profiles.map((item) => item.name), ['Principal'])
  assert.deepEqual(undone.commands.p1.map((item) => item.command), ['npm run dev'])
  assert.equal(undone.baseSettings.mode, 'summarize')
  assert.equal(undone.canUndoImport, false)
  assert.equal(host.data().storage.importBackup, undefined)

  await assert.rejects(worker.request('config.import', { text: 'no es json' }), /No es un JSON válido/)
  await assert.rejects(worker.request('config.import', { text: '{"a":1}' }), /No es una exportación/)
  await worker.deactivate()
})

test('descarta la última ejecución guardada por la 0.1', async () => {
  const { mount } = setupWorker(fakeRepo().git, {
    settings: { runOnStartup: false },
    storage: {
      selection: ['p1'],
      lastRun: { trigger: 'startup', startedAt: 1, finishedAt: 2, missing: [], results: [{ claude: { kind: 'already-open' } }] }
    }
  })
  const worker = await mount()
  const state = await worker.request('state.get')
  assert.equal(state.lastRun, null)
  await worker.deactivate()
})
