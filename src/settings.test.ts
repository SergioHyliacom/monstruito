import { assert, test } from 'orca/testing'
import {
  DEFAULT_SETTINGS,
  effectiveSettings,
  promptVariables,
  readGlobalSettings,
  renderPrompt,
  resolveSettings,
  sanitizeOverride
} from './settings'

test('los ajustes que faltan o no valen toman el valor por defecto', () => {
  const settings = readGlobalSettings({
    gitMode: 'rebase',
    concurrency: 99,
    startupDelaySeconds: -3,
    mode: 'summarize',
    prompt: 42,
    agent: 'codex'
  })
  assert.equal(settings.gitMode, DEFAULT_SETTINGS.gitMode)
  assert.equal(settings.concurrency, 16, 'se recorta al máximo')
  assert.equal(settings.startupDelaySeconds, 0, 'se recorta al mínimo')
  assert.equal(settings.mode, 'summarize')
  assert.equal(settings.prompt, '')
  assert.equal(settings.agent, 'codex')
})

test('el ajuste pull de la 0.1 apagado equivale a no tocar git', () => {
  assert.equal(readGlobalSettings({ pull: false }).gitMode, 'none')
  assert.equal(readGlobalSettings({ pull: false, gitMode: 'fetch' }).gitMode, 'fetch')
})

test('un proyecto hereda lo que no cambia', () => {
  const global = { ...DEFAULT_SETTINGS, mode: 'wait' as const, installDeps: true }
  const effective = effectiveSettings(global, { mode: 'resume', installDeps: false })
  assert.equal(effective.mode, 'resume')
  assert.equal(effective.installDeps, false)
  assert.equal(effective.gitMode, global.gitMode)
})

test('los ajustes propios descartan claves desconocidas, globales y textos vacíos', () => {
  assert.deepEqual(
    sanitizeOverride({ mode: 'resume', concurrency: 3, gitMode: 'nope', prompt: '  ', startCommand: 'npm run dev', runCommands: false, otra: 1 }),
    { mode: 'resume', runCommands: false }
  )
})

test('el modelo va con su agente en cada capa', () => {
  const base = { ...DEFAULT_SETTINGS, agent: 'claude', model: 'opus', effort: 'high' }
  // Un perfil que cambia de agente sin decir modelo usa el del agente nuevo.
  assert.deepEqual(pick(resolveSettings(base, { agent: 'codex' })), ['codex', '', ''])
  // Si es el mismo agente, hereda el modelo.
  assert.deepEqual(pick(resolveSettings(base, { agent: 'claude' })), ['claude', 'opus', 'high'])
  // Si dice modelo, ese.
  assert.deepEqual(pick(resolveSettings(base, { agent: 'codex', model: 'gpt-6-astra' })), ['codex', 'gpt-6-astra', ''])
  // Lo mismo por proyecto.
  assert.deepEqual(pick(effectiveSettings(base, { agent: 'codex' })), ['codex', '', ''])
  assert.deepEqual(pick(effectiveSettings(base, { model: 'sonnet' })), ['claude', 'sonnet', 'high'])
  // Un modelo con espacios no vale: acabaría como otro argumento.
  assert.equal(readGlobalSettings({ model: 'opus --dangerously' }).model, '')
})

const pick = (settings: { agent: string; model: string; effort: string }) => [settings.agent, settings.model, settings.effort]

test('las variables del prompt', () => {
  const variables = promptVariables('web', 'main', {
    kind: 'updated',
    upstream: 'origin/main',
    count: 2,
    commits: ['a1 Uno', 'b2 Dos']
  })
  assert.equal(
    renderPrompt('{proyecto}@{rama}: {n_commits} de {remota}\n\n  {commits} {otra}', variables),
    'web@main: 2 de origin/main a1 Uno; b2 Dos {otra}'
  )
  const none = promptVariables('web', null, { kind: 'up-to-date', upstream: 'origin/main' })
  assert.equal(renderPrompt('{n_commits} · {commits} · {remota}', none), '0 · ninguno · origin/main')
})
