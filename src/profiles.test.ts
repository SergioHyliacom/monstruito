import { assert, test } from 'orca/testing'
import { describeDays, newProfileId, profileForDay, projectToOpen, sanitizeProfiles } from './profiles'
import type { Profile } from './protocol'

const make = (id: string, extra: Partial<Profile> = {}): Profile => ({
  id,
  name: id,
  selection: [],
  settings: {},
  days: [],
  openAtEnd: '',
  ...extra
})

test('sin perfiles guardados crea «Principal» con lo que hubiera marcado', () => {
  assert.deepEqual(sanitizeProfiles(null, ['a', 'b', 'a']), [make('principal', { name: 'Main', selection: ['a', 'b'] })])
})

test('limpia perfiles guardados a medias', () => {
  const profiles = sanitizeProfiles(
    [
      { id: 'x', name: '  Trabajo  ', selection: ['a', 3], days: [1, 1, 9, 'lunes'], settings: { mode: 'nope', agent: 'codex' } },
      { id: 'x', name: 'duplicado' },
      { name: 'sin id' },
      'basura'
    ],
    []
  )
  assert.deepEqual(profiles, [make('x', { name: 'Trabajo', selection: ['a'], days: [1], settings: { agent: 'codex' } })])
})

test('el perfil del día manda; si no hay, el activo', () => {
  const profiles = [make('casa', { days: [0, 6] }), make('trabajo', { days: [1, 2, 3, 4, 5] }), make('otro')]
  assert.equal(profileForDay(profiles, 'otro', 6).id, 'casa')
  assert.equal(profileForDay(profiles, 'otro', 3).id, 'trabajo')
  assert.equal(profileForDay([make('a'), make('b')], 'b', 3).id, 'b')
  assert.equal(profileForDay([make('a'), make('b')], 'borrado', 3).id, 'a')
})

test('ids legibles y sin repetir', () => {
  assert.equal(newProfileId([], 'Fin de Semana'), 'fin-de-semana')
  assert.equal(newProfileId([make('diseno')], 'Diseño'), 'diseno-2')
  assert.equal(newProfileId([], '¡¿?!'), 'profile')
})

test('los días en palabras', () => {
  assert.equal(describeDays([]), '')
  assert.equal(describeDays([1, 2, 3, 4, 5]), 'Monday to Friday')
  assert.equal(describeDays([6, 0]), 'weekends')
  assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6]), 'every day')
  assert.equal(describeDays([0, 3]), 'Wednesday, Sunday')
})

test('qué proyecto mostrar al terminar', () => {
  const lastUsed = new Map([
    ['a', 100],
    ['b', 300],
    ['c', 200]
  ])
  assert.equal(projectToOpen(make('p', { selection: ['a', 'b'], openAtEnd: '' }), lastUsed), null)
  assert.equal(projectToOpen(make('p', { selection: ['a', 'c'], openAtEnd: '__recent' }), lastUsed), 'c')
  assert.equal(projectToOpen(make('p', { selection: ['a'], openAtEnd: 'b' }), lastUsed), 'b')
})
