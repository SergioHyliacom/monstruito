// `orca plugin check` dibuja el panel una vez por escenario, con el worker sobre un Orca de
// mentira. "Ejecutar al abrir Orca" va apagado para que el worker no lance git de verdad.
import { defineCheck } from 'orca/testing'

const projects = {
  projects: [
    { id: 'p1', name: 'api', kind: 'git', hostId: 'local', path: 'D:/Proyectos/Empresa/api' },
    { id: 'p2', name: 'web', kind: 'git', hostId: 'local', path: 'D:/Proyectos/Empresa/web' },
    { id: 'p3', name: 'blog', kind: 'git', hostId: 'local', path: 'D:/Proyectos/Astro/blog' },
    { id: 'p4', name: 'tienda', kind: 'git', hostId: 'local', path: 'D:/Proyectos/Astro/tienda' },
    { id: 'p5', name: 'apuntes', kind: 'folder', hostId: 'local', path: 'D:/Proyectos/apuntes' }
  ],
  truncated: false
}

const workspace = (projectId: string, path: string, lastActivityAt: number | null) => ({
  id: `${projectId}::${path}`,
  kind: 'worktree',
  name: 'main',
  projectId,
  path,
  branch: 'main',
  hostId: 'local',
  status: { state: 'inactive', unread: false, terminalCount: 1, lastActivityAt }
})

const workspaces = {
  workspaces: [
    workspace('p1', 'D:/Proyectos/Empresa/api', Date.now() - 60 * 60 * 1000),
    workspace('p2', 'D:/Proyectos/Empresa/web', null),
    workspace('p3', 'D:/Proyectos/Astro/blog', Date.now() - 3 * 24 * 60 * 60 * 1000),
    workspace('p4', 'D:/Proyectos/Astro/tienda', null),
    workspace('p5', 'D:/Proyectos/apuntes', Date.now() - 26 * 60 * 60 * 1000)
  ],
  truncated: false
}

const results = {
  'project.list': projects,
  'workspace.list': workspaces,
  'statusBar.update': { ok: true }
}

export default defineCheck({
  vacio: {
    settings: { runOnStartup: false },
    results
  },
  conEjecucion: {
    settings: { runOnStartup: false, mode: 'summarize' },
    results,
    storage: {
      activeProfile: 'empresa',
      profiles: [
        { id: 'empresa', name: 'Work', selection: ['p1', 'p2'], settings: {}, days: [1, 2, 3, 4, 5], openAtEnd: '__recent' },
        { id: 'casa', name: 'Home', selection: ['p3'], settings: { mode: 'wait' }, days: [0, 6], openAtEnd: '' }
      ],
      overrides: { p2: { mode: 'resume' } },
      commands: {
        p2: [
          { id: 'c1', name: 'web', command: 'npm run dev', kind: 'tab', when: 'always', files: [], restart: true, openUrl: true, enabled: true },
          { id: 'c2', name: '', command: 'php artisan migrate --force', kind: 'prepare', when: 'files', files: ['database/migrations/'], restart: false, openUrl: false, enabled: true }
        ]
      },
      openedTerminals: [{ terminalId: 't1', title: 'Monstruito: web', project: 'web' }],
      pending: {
        checkedAt: Date.now() - 5 * 60 * 1000,
        failed: 0,
        projects: [{ projectId: 'p3', name: 'blog', upstream: 'origin/main', count: 4 }]
      },
      lastRun: {
        trigger: 'startup',
        startedAt: Date.now() - 2 * 60 * 60 * 1000 - 90_000,
        finishedAt: Date.now() - 2 * 60 * 60 * 1000,
        missing: [],
        results: [
          {
            projectId: 'p1',
            name: 'api',
            path: 'D:/Proyectos/Empresa/api',
            git: { kind: 'updated', upstream: 'origin/main', count: 2, commits: ['a1 Uno', 'b2 Dos'] },
            agent: { kind: 'launched', agent: 'claude', withPrompt: true },
            deps: [{ command: 'npm install', kind: 'ok' }],
            commands: [],
            worktrees: [{ name: 'feature', branch: 'feature/login', behind: 3 }]
          },
          {
            projectId: 'p2',
            name: 'web',
            path: 'D:/Proyectos/Empresa/web',
            git: { kind: 'failed', step: 'merge', message: 'fatal: Not possible to fast-forward, aborting.' },
            agent: { kind: 'already-open', agent: 'claude' },
            deps: [],
            commands: [
              { name: 'php artisan migrate --force', kind: 'prepare', result: 'skipped', message: 'those files did not change' },
              { name: 'web', kind: 'tab', result: 'restarted', url: 'http://localhost:5173/' }
            ],
            worktrees: []
          }
        ]
      }
    }
  }
})
