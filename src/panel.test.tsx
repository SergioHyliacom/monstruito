// `orca plugin test .` lo ejecuta en Node con el mismo runtime y las mismas comprobaciones de Orca.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { CommandDef, PanelState, Profile, ProjectOverride, ProjectRow, RunRecord } from './protocol'
import { DEFAULT_SETTINGS } from './settings'

const HOUR = 60 * 60 * 1000

function row(path: string, options: { selected?: boolean; hoursAgo?: number; customized?: boolean } = {}): ProjectRow {
  const name = path.split('/').pop() ?? path
  return {
    id: name,
    name,
    path,
    selected: options.selected ?? false,
    customized: options.customized ?? false,
    lastUsedAt: options.hoursAgo === undefined ? null : Date.now() - options.hoursAgo * HOUR
  }
}

const PRINCIPAL: Profile = { id: 'principal', name: 'Principal', selection: ['api'], settings: {}, days: [], openAtEnd: '' }

function panelState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    projects: [row('D:/Proyectos/api', { selected: true, hoursAgo: 1 }), row('D:/Proyectos/web')],
    running: false,
    checking: false,
    progress: null,
    history: [],
    lastRun: null,
    pending: null,
    profiles: [PRINCIPAL],
    activeProfileId: 'principal',
    baseSettings: DEFAULT_SETTINGS,
    settings: DEFAULT_SETTINGS,
    overrides: {},
    commands: {},
    openedTerminals: 0,
    canUndoImport: false,
    ...overrides
  }
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    trigger: 'startup',
    startedAt: 1,
    finishedAt: 2,
    missing: [],
    profile: 'Principal',
    results: [
      {
        projectId: 'api',
        name: 'api',
        path: 'D:/Proyectos/api',
        git: { kind: 'updated', upstream: 'origin/main', count: 3, commits: ['a', 'b', 'c'] },
        agent: { kind: 'launched', agent: 'claude', withPrompt: false },
        deps: [{ command: 'npm install', kind: 'failed', message: 'ERESOLVE' }],
        commands: [
          { name: 'npm run dev', kind: 'tab', result: 'opened', url: 'http://localhost:4321/' },
          { name: 'migrar', kind: 'prepare', result: 'skipped', message: 'no cambiaron esos archivos' }
        ],
        worktrees: [{ name: 'feature', branch: 'feature/x', behind: 2 }]
      }
    ],
    ...overrides
  }
}

/** Proyectos en carpetas: Empresa/Repositorios es lo más reciente, Astro lo siguiente. */
const NESTED = [
  row('D:/Trabajo/Empresa/Repositorios/intranet', { hoursAgo: 0 }),
  row('D:/Trabajo/Empresa/Repositorios/tienda'),
  row('D:/Trabajo/Proyectos/Astro/blog', { hoursAgo: 30 }),
  row('D:/Trabajo/Proyectos/Astro/portfolio'),
  row('D:/Trabajo/Proyectos/Flutter/forge'),
  row('D:/Trabajo/apuntes', { hoursAgo: 5 })
]

// ——— Lista de proyectos ———

test('muestra los proyectos y guarda la selección', async () => {
  const selections: { projectId: string; selected: boolean }[] = []
  const host = mockHost({
    requests: {
      'state.get': () => panelState(),
      'selection.set': (input) => {
        selections.push(input)
        return panelState({
          projects: panelState().projects.map((project) =>
            project.id === input.projectId ? { ...project, selected: input.selected } : project
          )
        })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ role: 'status' })?.text, '1 selected')
  assert.ok(view.find({ text: 'Selected · 1' }))
  assert.ok(view.find({ text: 'Not selected · 1' }))
  assert.equal(view.findAll({ type: 'Separator' }).length, 2, 'otra raya separa marcados y sin marcar')
  assert.equal(view.valueOf({ label: 'api' }), true)
  assert.equal(view.valueOf({ label: 'web' }), false)

  await view.toggle({ label: 'web' })
  assert.deepEqual(selections, [{ projectId: 'web', selected: true }])
  assert.equal(view.valueOf({ label: 'web' }), true)
  assert.equal(view.find({ role: 'status' })?.text, '2 selected')
  assert.ok(view.find({ text: 'Selected · 2' }))
  assert.ok(view.find({ text: 'All projects are selected.' }))

  await view.type({ label: 'Search projects' }, 'ap')
  assert.ok(view.find({ label: 'api' }))
  assert.equal(view.find({ label: 'web' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('agrupa en carpetas plegables, de más reciente a más antiguo', async () => {
  const host = mockHost({ requests: { 'state.get': () => panelState({ projects: NESTED }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'In D:/Trabajo, most recent first' }))

  const folders = view.findAll({ type: 'Collapsible' }).map((element) => element.label)
  assert.deepEqual(folders, ['Empresa/Repositorios', 'Proyectos'])
  assert.ok(view.find({ label: 'intranet' }))
  assert.equal(view.find({ label: 'blog' }), null, 'Proyectos empieza cerrada')

  await view.toggle({ type: 'Collapsible', label: 'Proyectos' })
  await view.toggle({ type: 'Collapsible', label: 'Astro' })
  assert.ok(view.find({ label: 'blog' }))
  assert.deepEqual([...(view.persisted.plugin.expanded as string[])].sort(), [
    'dir:d:/trabajo/empresa/repositorios',
    'dir:d:/trabajo/proyectos',
    'dir:d:/trabajo/proyectos/astro'
  ])

  await view.toggle({ type: 'Collapsible', label: 'Empresa/Repositorios' })
  assert.equal(view.find({ label: 'intranet' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('al marcar un proyecto sale del árbol y pasa a la lista de marcados', async () => {
  let projects = NESTED
  const host = mockHost({
    requests: {
      'state.get': () => panelState({ projects }),
      'selection.set': (input) => {
        projects = projects.map((project) =>
          project.id === input.projectId ? { ...project, selected: input.selected } : project
        )
        return panelState({ projects })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: /^Selected/ }), null, 'sin marcados no hay lista aparte')
  assert.equal(view.findAll({ type: 'Separator' }).length, 1, 'sin marcados no hay raya entre listas')

  await view.toggle({ label: 'intranet' })
  assert.ok(view.find({ text: 'Selected · 1' }))
  const marked = view.find({ label: 'intranet' })
  assert.equal(marked?.props.description, 'Empresa/Repositorios · Used today', 'dice de qué carpeta es')
  assert.equal(view.findAll({ label: 'intranet' }).length, 1, 'ya no está en el árbol')
  assert.ok(view.find({ label: 'tienda' }))

  await view.toggle({ label: 'intranet' })
  assert.equal(view.find({ text: /^Selected/ }), null, 'al desmarcarlo vuelve al árbol')
  assert.ok(view.find({ label: 'intranet' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('una carpeta se marca entera de una vez', async () => {
  const many: { projectIds: string[]; selected: boolean }[] = []
  const host = mockHost({
    requests: {
      'state.get': () => panelState({ projects: NESTED }),
      'selection.setMany': (input) => {
        many.push(input)
        return panelState({ projects: NESTED })
      }
    }
  })
  const view = await mount(panel, { host })
  await view.toggle({ type: 'Collapsible', label: 'Proyectos' })
  await view.press({ text: 'Select all 3' })
  // Astro (con blog, la más reciente) y luego forge, que no se ha usado.
  assert.deepEqual(many, [{ projectIds: ['blog', 'portfolio', 'forge'], selected: true }])
  await view.unmount()
})

test('al buscar abre las carpetas con coincidencias y recargar las enseña todas', async () => {
  let loads = 0
  const host = mockHost({
    requests: {
      'state.get': () => {
        loads++
        return panelState({ projects: NESTED })
      }
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Search projects' }, 'portf')
  assert.ok(view.find({ label: 'portfolio' }))
  assert.equal(view.find({ label: 'intranet' }), null)

  await view.press({ label: 'Reload projects' })
  assert.equal(loads, 2, 'vuelve a pedir los proyectos')
  assert.equal(view.valueOf({ label: 'Search projects' }), '', 'quita la búsqueda')
  assert.ok(view.find({ label: 'intranet' }))
  await view.unmount()
})

// ——— Perfiles ———

test('el selector cambia de perfil y + crea uno y abre sus ajustes', async () => {
  const asked: string[] = []
  const trabajo: Profile = { ...PRINCIPAL, id: 'trabajo', name: 'Trabajo', days: [1, 2, 3, 4, 5] }
  const host = mockHost({
    requests: {
      'state.get': () => panelState({ profiles: [PRINCIPAL, trabajo] }),
      'profile.select': (input) => {
        asked.push(`select:${input.profileId}`)
        return panelState({ profiles: [PRINCIPAL, trabajo], activeProfileId: input.profileId })
      },
      'profile.create': (input) => {
        asked.push(`create:${input.name}`)
        const nuevo = { ...PRINCIPAL, id: 'perfil-3', name: input.name, selection: [] }
        return panelState({ profiles: [PRINCIPAL, trabajo, nuevo], activeProfileId: 'perfil-3' })
      }
    }
  })
  const view = await mount(panel, { host })
  const options = (view.find({ label: 'Profile' })?.props.options as { label: string }[]).map((option) => option.label)
  assert.deepEqual(options, ['Principal', 'Trabajo · Monday to Friday'])

  await view.select({ label: 'Profile' }, 'trabajo')
  await view.press({ label: 'New profile' })
  assert.deepEqual(asked, ['select:trabajo', 'create:Profile 3'])
  assert.equal(view.valueOf({ label: 'Which settings you are editing' }), 'profile', 'abre los ajustes del perfil nuevo')
  assert.ok(view.find({ type: 'Card', label: 'Profile “Profile 3”' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('los ajustes de un perfil heredan de los de todos y se guardan en el perfil', async () => {
  const patches: unknown[] = []
  let profile: Profile = { ...PRINCIPAL }
  const host = mockHost({
    requests: {
      'state.get': () => panelState({ profiles: [profile] }),
      'profile.update': (input) => {
        patches.push(input.patch)
        profile = { ...profile, ...input.patch } as Profile
        return panelState({ profiles: [profile] })
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })
  await view.select({ label: 'Which settings you are editing' }, 'profile')

  await view.toggle({ label: 'Monday' })
  await view.toggle({ label: 'Friday' })
  await view.select({ label: 'When startup finishes, show' }, '__recent')
  await view.select({ label: 'Settings groups' }, 'Agent')
  assert.equal(view.valueOf({ label: 'What the agent does' }), '__inherit', 'sin tocar, hereda')
  await view.select({ label: 'What the agent does' }, 'resume')
  await view.select({ label: 'What the agent does' }, '__inherit')

  assert.deepEqual(patches, [
    { days: [1] },
    { days: [1, 5] },
    { openAtEnd: '__recent' },
    { settings: { mode: 'resume' } },
    { settings: {} }
  ])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('eliminar un perfil pide confirmación', async () => {
  const deleted: string[] = []
  const otro: Profile = { ...PRINCIPAL, id: 'otro', name: 'Otro' }
  const host = mockHost({
    requests: {
      'state.get': () => panelState({ profiles: [PRINCIPAL, otro] }),
      'profile.delete': (input) => {
        deleted.push(input.profileId)
        return panelState({ profiles: [otro], activeProfileId: 'otro' })
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })
  await view.select({ label: 'Which settings you are editing' }, 'profile')
  await view.press({ text: 'Delete profile' })
  assert.deepEqual(deleted, [], 'la primera pulsación solo pregunta')
  await view.press({ text: 'Click again to delete “Principal”' })
  assert.deepEqual(deleted, ['principal'])
  await view.unmount()
})

// ——— Ajustes ———

test('el engranaje junto al buscador cambia la lista por los ajustes', async () => {
  const host = mockHost({ requests: { 'state.get': () => panelState() } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'api' }))

  await view.press({ label: 'Settings' })
  assert.ok(view.find({ text: 'Settings', type: 'Heading' }))
  assert.equal(view.find({ label: 'api' }), null, 'la lista se esconde')
  assert.equal(view.valueOf({ label: 'Settings groups' }), 'Startup')

  await view.press({ label: 'Close settings' })
  assert.ok(view.find({ label: 'api' }))

  await view.press({ label: 'Settings' })
  await view.type({ label: 'Search projects' }, 'ap')
  assert.ok(view.find({ label: 'api' }), 'buscar vuelve a la lista')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('los ajustes de todos los perfiles van por pestañas y se guardan en Settings', async () => {
  const host = mockHost({ requests: { 'state.get': () => panelState() } })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })

  await view.select({ label: 'Check for new commits every' }, '15')
  assert.equal(view.find({ label: 'What to do with git' }), null, 'solo se ve la pestaña elegida')
  await view.select({ label: 'Settings groups' }, 'Git')
  await view.select({ label: 'What to do with git' }, 'fetch')
  await view.toggle({ label: 'Skip if there are uncommitted changes' })
  await view.select({ label: 'Settings groups' }, 'Agent')
  await view.type({ label: 'Startup prompt' }, 'Review {project}')
  await view.press({ text: 'Save startup prompt' })
  assert.equal(view.persisted.plugin.globalTab, 'Agent', 'recuerda la pestaña')

  const data = host.data().settings
  assert.equal(data.gitMode, 'fetch')
  assert.equal(data.skipIfDirty, true)
  assert.equal(data.recheckMinutes, 15)
  assert.equal(data.prompt, 'Review {project}')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('el modelo se elige de la lista de Claude, o se escribe', async () => {
  const host = mockHost({ requests: { 'state.get': () => panelState() } })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })
  await view.select({ label: 'Settings groups' }, 'Agent')

  const options = (view.find({ label: 'Model' })?.props.options as { value: string }[]).map((option) => option.value)
  assert.deepEqual(options, [
    '__empty', 'opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', '__custom'
  ])
  await view.select({ label: 'Model' }, 'opus')
  await view.select({ label: 'Reasoning effort' }, 'xhigh')
  assert.equal(host.data().settings.model, 'opus')
  assert.equal(host.data().settings.effort, 'xhigh')

  await view.select({ label: 'Model' }, '__custom')
  await view.type({ label: 'Model id' }, 'claude-opus-4-8')
  await view.press({ text: 'Save model' })
  assert.equal(host.data().settings.model, 'claude-opus-4-8')
  assert.equal(view.valueOf({ label: 'Model' }), '__custom', 'un id que no está en la lista se ve como escrito')

  await view.select({ label: 'Model' }, '__empty')
  assert.equal(host.data().settings.model, '')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('cambiar de agente quita el modelo, y Copilot no deja elegirlo', async () => {
  const host = mockHost({
    settings: { model: 'opus', effort: 'high' },
    requests: { 'state.get': () => panelState({ baseSettings: { ...DEFAULT_SETTINGS, model: 'opus', effort: 'high' } }) }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })
  await view.select({ label: 'Settings groups' }, 'Agent')
  await view.select({ label: 'Agent' }, 'copilot')
  assert.equal(host.data().settings.agent, 'copilot')
  assert.equal(host.data().settings.model, '')
  assert.equal(host.data().settings.effort, '')

  await view.post('state.changed', panelState({ baseSettings: { ...DEFAULT_SETTINGS, agent: 'copilot' } }))
  assert.equal(view.find({ label: 'Model' }), null)
  assert.equal(view.find({ label: 'Reasoning effort' }), null)
  assert.ok(view.find({ text: "GitHub Copilot uses the model from its own configuration: it can't be chosen here." }))
  await view.unmount()
})

test('un proyecto puede usar otro modelo que el del perfil', async () => {
  const saved: (ProjectOverride | null)[] = []
  const host = mockHost({
    requests: {
      'state.get': () => panelState({ settings: { ...DEFAULT_SETTINGS, model: 'opus' } }),
      'override.set': (input) => {
        saved.push(input.override)
        return panelState()
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings for web' })
  await view.select({ label: 'Project settings groups' }, 'Agent')
  const inherit = (view.find({ label: 'Model' })?.props.options as { label: string }[])[0]
  assert.equal(inherit.label, 'As in the profile (Opus (latest))')

  await view.select({ label: 'Model' }, 'haiku')
  await view.select({ label: 'Reasoning effort' }, 'low')
  await view.press({ text: 'Save' })
  assert.deepEqual(saved, [{ model: 'haiku', effort: 'low' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('cada proyecto puede tener sus propios ajustes y sus comandos', async () => {
  const saved: { projectId: string; override: ProjectOverride | null }[] = []
  const savedCommands: { projectId: string; commands: CommandDef[] }[] = []
  let state = panelState()
  const host = mockHost({
    requests: {
      'state.get': () => state,
      'commands.suggest': () => ({
        suggestions: [
          { name: 'dev', command: 'npm run dev', kind: 'tab', source: 'package.json' },
          { name: 'build', command: 'npm run build', kind: 'prepare', source: 'package.json' }
        ]
      }),
      'override.set': (input) => {
        saved.push(input)
        state = panelState({
          overrides: input.override ? { [input.projectId]: input.override } : {},
          projects: panelState().projects.map((project) =>
            project.id === input.projectId ? { ...project, customized: input.override !== null } : project
          )
        })
        return state
      },
      'commands.set': (input) => {
        savedCommands.push(input)
        state = { ...state, commands: { [input.projectId]: input.commands } }
        return state
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings for web' })
  assert.ok(view.find({ type: 'Card', label: 'Settings for web' }))

  assert.equal(view.valueOf({ label: 'Project settings groups' }), 'Git')
  await view.select({ label: 'Project settings groups' }, 'Agent')
  await view.select({ label: 'What the agent does' }, 'resume')
  await view.select({ label: 'Project settings groups' }, 'Commands')
  await view.select({ label: 'Install dependencies when they change' }, 'off')

  // Uno sugerido, con un clic; otro escrito a mano.
  await view.press({ text: 'npm run dev' })
  assert.equal(view.find({ text: 'npm run dev', type: 'Button' }), null, 'la sugerencia ya añadida desaparece')
  await view.press({ text: 'Add command' })
  await view.type({ label: 'Command' }, 'php artisan migrate --force')
  await view.select({ label: 'Type' }, 'prepare')
  await view.select({ label: 'When' }, 'files')
  await view.type({ label: 'Files' }, 'database/migrations/, ')
  assert.equal(view.valueOf({ label: 'Files' }), 'database/migrations/, ', 'se puede seguir escribiendo tras la coma')
  await view.press({ text: 'Save' })

  assert.deepEqual(saved, [{ projectId: 'web', override: { mode: 'resume', installDeps: false } }])
  assert.deepEqual(
    savedCommands[0].commands.map((item) => [item.command, item.kind, item.when, item.files]),
    [
      ['npm run dev', 'tab', 'always', []],
      ['php artisan migrate --force', 'prepare', 'files', ['database/migrations/']]
    ]
  )
  assert.equal(view.find({ type: 'Card', label: 'Settings for web' }), null, 'se cierra al guardar')
  assert.ok(view.find({ text: 'custom' }))

  await view.press({ label: 'Settings for web' })
  await view.select({ label: 'Project settings groups' }, 'Agent')
  assert.equal(view.valueOf({ label: 'What the agent does' }), 'resume', 'abre con lo guardado')
  await view.press({ text: 'Remove custom settings' })
  assert.deepEqual(saved.at(-1), { projectId: 'web', override: null })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('exporta a un archivo, importa lo pegado y deja deshacerlo', async () => {
  const imported: string[] = []
  const host = mockHost({
    results: { 'files.saveAs': { status: 'saved' } },
    requests: {
      'state.get': () => panelState(),
      'config.export': () => ({ fileName: 'arranque-orca-2026-11-26.json', text: '{"format":"orca-arranque"}' }),
      'config.import': (input) => {
        imported.push(input.text)
        return { state: panelState({ canUndoImport: true }), report: { profiles: 2, matched: 5, missing: ['viejo'] } }
      },
      'config.undoImport': () => panelState()
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })
  await view.toggle({ type: 'Collapsible', label: 'Export or import' })

  await view.press({ text: 'Export to a file' })
  assert.deepEqual(host.callsOf('files.saveAs'), [
    { suggestedName: 'arranque-orca-2026-11-26.json', mimeType: 'application/json', data: '{"format":"orca-arranque"}' }
  ])
  assert.ok(view.find({ text: 'Saved as arranque-orca-2026-11-26.json.' }))

  await view.type({ label: 'Import' }, '{"format":"orca-arranque"}')
  await view.press({ text: 'Import' })
  assert.deepEqual(imported, ['{"format":"orca-arranque"}'])
  assert.ok(view.find({ text: /2 profiles, 5 projects found\. Not on this computer: viejo\./ }))
  await view.press({ text: 'Undo the last import' })
  assert.equal(view.find({ text: 'Undo the last import' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

// ——— Ejecutar, avance e historial ———

test('ejecuta, revisa, detiene y enseña el avance', async () => {
  const asked: string[] = []
  const host = mockHost({
    requests: {
      'state.get': () => panelState(),
      'run.start': () => {
        asked.push('run')
        return panelState({ running: true })
      },
      'check.start': () => {
        asked.push('check')
        return panelState({ checking: true })
      },
      'run.stop': () => {
        asked.push('stop')
        return panelState({ running: true })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Stop' }), null, 'sin nada en marcha no hay Stop')
  await view.press({ text: 'Check commits' })
  assert.equal(view.find({ text: 'Run now' })?.disabled, true, 'no deja ejecutar mientras revisa')
  await view.post('state.changed', panelState())
  await view.press({ text: 'Run now' })

  await view.post('progress.changed', {
    progress: {
      kind: 'run',
      total: 4,
      done: 1,
      stopping: false,
      active: [
        { projectId: 'api', name: 'api', step: 'deps' },
        { projectId: 'web', name: 'web', step: 'git' }
      ]
    }
  })
  assert.equal(view.find({ label: 'Starting: 1 of 4 projects' })?.props.value, 25)
  assert.ok(view.find({ text: 'api: installing dependencies' }))
  assert.ok(view.find({ text: 'web: pulling changes' }))

  await view.press({ text: 'Stop' })
  assert.deepEqual(asked, ['check', 'run', 'stop'])
  await view.post('progress.changed', { progress: null })
  await view.post('state.changed', panelState())
  assert.equal(view.find({ text: 'Stop' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('enseña la última ejecución, el historial y los commits sin aplicar', async () => {
  const host = mockHost({
    requests: {
      'state.get': () => {
        const last = runRecord({ finishedAt: Date.now() })
        const older = runRecord({
          trigger: 'manual',
          startedAt: 0,
          finishedAt: new Date(2026, 10, 24, 9, 5).getTime(),
          stopped: true
        })
        return panelState({
          history: [last, older],
          lastRun: last,
          pending: { checkedAt: Date.now(), failed: 0, projects: [{ projectId: 'web', name: 'web', upstream: 'origin/main', count: 4 }] }
        })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'web: 4 in origin/main' }))
  assert.ok(view.find({ text: /Run now applies them\./ }))
  assert.ok(view.find({ text: '3 new commits' }))
  assert.ok(view.find({ text: 'Claude opened' }))
  assert.ok(view.find({ text: 'npm install failed' }))
  assert.ok(view.find({ text: 'npm run dev opened' }))
  assert.equal(view.find({ text: 'migrar: skipped' }), null, 'lo que no tocaba no ocupa una etiqueta')
  assert.ok(view.find({ text: /Opened http:\/\/localhost:4321\// }))
  assert.ok(view.find({ text: /Skipped: migrar \(no cambiaron esos archivos\)/ }))
  assert.ok(view.find({ text: /Worktrees: feature\/x 2 behind/ }))

  await view.toggle({ type: 'Collapsible', label: 'Previous runs (1)' })
  const entry = view.findAll({ type: 'Collapsible' }).find((element) => element.label?.startsWith('Manual'))
  assert.ok(entry, 'la ejecución anterior aparece')
  assert.equal(entry?.props.description, 'Principal · 1 project · 1 with problems · stopped')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('los commits sin aplicar de proyectos de solo descarga piden git pull', async () => {
  const projects = [
    { projectId: 'web', name: 'web', upstream: 'origin/main', count: 4 },
    { projectId: 'api', name: 'api', upstream: 'origin/main', count: 2, fetchOnly: true }
  ]
  const host = mockHost({
    requests: { 'state.get': () => panelState({ pending: { checkedAt: Date.now(), failed: 0, projects } }) }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'web: 4 in origin/main' }))
  assert.ok(view.find({ text: 'api: 2 in origin/main · fetch only' }))
  assert.ok(view.find({ text: /Run now applies the rest; the fetch-only ones, with git pull\./ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('cierra de una vez las pestañas que abrió el arranque', async () => {
  let closed = 0
  const host = mockHost({
    requests: {
      'state.get': () => panelState({ openedTerminals: 3 }),
      'terminals.closeAll': () => {
        closed++
        return panelState()
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Close tabs (3)' })
  assert.equal(closed, 1)
  assert.equal(view.find({ text: /^Close tabs/ }), null)
  await view.unmount()
})

test('sin ningún proyecto marcado no deja ejecutar ni revisar', async () => {
  const host = mockHost({
    requests: { 'state.get': () => panelState({ projects: [row('D:/Proyectos/api')] }) }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: 'Run now' })?.disabled, true)
  assert.equal(view.find({ text: 'Check commits' })?.disabled, true)
  await view.unmount()
})
