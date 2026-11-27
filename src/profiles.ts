// Perfiles: conjuntos de proyectos marcados con sus ajustes. Sin dependencias de Node.
import { OPEN_RECENT, type Profile } from './protocol'
import { sanitizePartialSettings } from './settings'

/** De lunes a domingo, como se leen en España; `value` es el de `Date.getDay()`. */
export const DAYS: { value: number; short: string; long: string }[] = [
  { value: 1, short: 'Mo', long: 'Monday' },
  { value: 2, short: 'Tu', long: 'Tuesday' },
  { value: 3, short: 'We', long: 'Wednesday' },
  { value: 4, short: 'Th', long: 'Thursday' },
  { value: 5, short: 'Fr', long: 'Friday' },
  { value: 6, short: 'Sa', long: 'Saturday' },
  { value: 0, short: 'Su', long: 'Sunday' }
]

export const DEFAULT_PROFILE_ID = 'principal'

export function emptyProfile(id: string, name: string, selection: string[] = []): Profile {
  return { id, name, selection, settings: {}, days: [], openAtEnd: '' }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sanitizeProfile(raw: unknown): Profile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || !value.id) return null
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 60) : 'Untitled'
  const days = Array.isArray(value.days)
    ? [...new Set(value.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))]
    : []
  return {
    id: value.id,
    name,
    selection: [...new Set(asStrings(value.selection))],
    settings: sanitizePartialSettings(value.settings),
    days,
    openAtEnd: typeof value.openAtEnd === 'string' ? value.openAtEnd : ''
  }
}

/**
 * Los perfiles guardados, siempre al menos uno. La primera vez, lo que había marcado (versiones
 * sin perfiles) pasa a un perfil «Principal».
 */
export function sanitizeProfiles(raw: unknown, legacySelection: string[]): Profile[] {
  const profiles = Array.isArray(raw) ? raw.map(sanitizeProfile).filter((p): p is Profile => p !== null) : []
  const unique = profiles.filter((profile, index) => profiles.findIndex((p) => p.id === profile.id) === index)
  return unique.length > 0 ? unique : [emptyProfile(DEFAULT_PROFILE_ID, 'Main', [...new Set(legacySelection)])]
}

export function findProfile(profiles: Profile[], id: string | null | undefined): Profile {
  return profiles.find((profile) => profile.id === id) ?? profiles[0]
}

/** El perfil que se usa al abrir Orca: el primero que tenga ese día, si no el activo. */
export function profileForDay(profiles: Profile[], activeId: string | null | undefined, weekday: number): Profile {
  return profiles.find((profile) => profile.days.includes(weekday)) ?? findProfile(profiles, activeId)
}

export function newProfileId(profiles: Profile[], name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'profile'
  let id = base
  for (let n = 2; profiles.some((profile) => profile.id === id); n++) id = `${base}-${n}`
  return id
}

/** «L M X J V» para mostrar los días de un perfil. */
export function describeDays(days: number[]): string {
  if (days.length === 0) return ''
  if (days.length === 7) return 'every day'
  const workdays = [1, 2, 3, 4, 5]
  if (days.length === 5 && workdays.every((day) => days.includes(day))) return 'Monday to Friday'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'weekends'
  return DAYS.filter((day) => days.includes(day.value))
    .map((day) => day.long)
    .join(', ')
}

/** Qué proyecto mostrar al terminar, o null. `lastUsed` da la actividad de cada proyecto. */
export function projectToOpen(profile: Profile, lastUsed: Map<string, number>): string | null {
  if (!profile.openAtEnd) return null
  if (profile.openAtEnd !== OPEN_RECENT) return profile.openAtEnd
  let best: string | null = null
  let bestAt = -1
  for (const id of profile.selection) {
    const at = lastUsed.get(id) ?? 0
    if (at > bestAt) {
      best = id
      bestAt = at
    }
  }
  return best
}
