// El panel: perfiles, proyectos marcados y árbol, ajustes (de todos los perfiles, del perfil y de
// cada proyecto), ejecutar, revisar o detener, el avance en vivo y el historial.
// Sin paso de compilación: Orca quita los tipos y compila el JSX al cargarlo.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Collapsible,
  Heading,
  host,
  IconButton,
  Input,
  plugin,
  Progress as ProgressBar,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  settings as pluginSettings,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  update,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { describeWhen, emptyCommand, newCommandId } from './commands'
import {
  describeAgent,
  describeGit,
  describeHistoryEntry,
  describePlan,
  describeProgress,
  describeStep,
  describeWorktrees,
  visibleCommands
} from './describe'
import { DAYS, describeDays } from './profiles'
import {
  OPEN_RECENT,
  type CommandDef,
  type CommandSuggestion,
  type GlobalSettings,
  type ImportReport,
  type PanelState,
  type PendingCheck,
  type Profile,
  type ProfilePatch,
  type ProjectOverride,
  type ProjectResult,
  type ProjectRow,
  type Progress as RunProgress,
  type RunRecord
} from './protocol'
import {
  agentLabel,
  GLOBAL_GROUPS,
  modelLabel,
  modelSupport,
  PROJECT_GROUPS,
  type FieldDef,
  type FieldGroup
} from './settings'
import {
  buildTree,
  defaultExpanded,
  filterTree,
  folderOf,
  matchesQuery,
  sortByRecency,
  usedAgo,
  type FolderNode,
  type TreeNode
} from './tree'

// ——— Estado del panel ———

/** Lo que el worker respondió por última vez; null hasta la primera respuesta. */
const state = atom<PanelState | null>(null)
/** El avance llega por su cuenta, más a menudo que el estado completo. */
const progress = atom<RunProgress | null>(null)
const query = atom('')
const failure = atom<string | null>(null)
/** Carpetas abiertas; null hasta que la persona abre o cierra alguna. Se recuerda entre usos. */
const expanded = atom<string[] | null>('expanded', null, { persist: 'plugin' })
/** Si en lugar de la lista se ven los ajustes. */
const settingsOpen = atom(false)
/** Qué ajustes se editan: los del perfil activo o los de todos los perfiles. */
const settingsScope = atom<'profile' | 'all'>('settingsScope', 'all', { persist: 'plugin' })
/** La pestaña de ajustes elegida, generales y de proyecto. Se recuerda entre usos. */
const globalTab = atom('globalTab', GLOBAL_GROUPS[0].title, { persist: 'plugin' })
const projectTab = atom('projectTab', PROJECT_GROUPS[0].title, { persist: 'plugin' })
/** Textos de ajustes mientras se escriben, antes de guardarlos, por `ámbito:clave`. */
const textDrafts = atom<Record<string, string>>({})
const profileName = atom<string | null>(null)
const confirmDelete = atom<string | null>(null)
/** El proyecto cuyos ajustes se están editando, con los cambios aún sin guardar. */
const editing = atom<{ projectId: string; draft: ProjectOverride; commands: CommandDef[] } | null>(null)
/** El comando desplegado en el editor del proyecto. */
const openCommand = atom<string | null>(null)
/** Lo escrito en «Archivos» de cada comando, tal cual (con sus comas a medio escribir). */
const filesDrafts = atom<Record<string, string>>({})
/** Sugerencias de comandos por proyecto; undefined mientras se buscan. */
const suggestions = atom<Record<string, CommandSuggestion[] | undefined>>({})
/** Dónde se ha elegido «Otro (escribirlo)» para el modelo, por `ámbito`. */
const customModel = atom<Record<string, boolean>>({})
const importText = atom('')
const importResult = atom<ImportReport | null>(null)
const exportNote = atom<string | null>(null)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function setState(next: PanelState): void {
  set(state, next)
  set(progress, next.progress)
}

/** Pide algo al worker y enseña el estado que devuelve, o el error. */
async function ask(request: () => Promise<PanelState>): Promise<boolean> {
  try {
    setState(await request())
    set(failure, null)
    return true
  } catch (error) {
    set(failure, errorText(error))
    return false
  }
}

const load = () => ask(() => plugin.request('state.get'))

/** Vuelve a pedir los proyectos a Orca, quita la búsqueda y enseña la lista, para que salgan todos. */
async function reload(): Promise<void> {
  set(query, '')
  set(settingsOpen, false)
  await load()
}

async function toggle(projectId: string, selected: boolean): Promise<void> {
  update(state, (current) =>
    current && {
      ...current,
      projects: current.projects.map((project) => (project.id === projectId ? { ...project, selected } : project))
    }
  )
  if (!(await ask(() => plugin.request('selection.set', { projectId, selected })))) await load()
}

const markMany = (projectIds: string[], selected: boolean) =>
  ask(() => plugin.request('selection.setMany', { projectIds, selected }))
const runNow = () => ask(() => plugin.request('run.start'))
const checkNow = () => ask(() => plugin.request('check.start'))
const stopNow = () => ask(() => plugin.request('run.stop'))
const selectProfile = (profileId: string) => ask(() => plugin.request('profile.select', { profileId }))

async function createProfile(current: PanelState): Promise<void> {
  const name = `Perfil ${current.profiles.length + 1}`
  if (await ask(() => plugin.request('profile.create', { name }))) {
    // Directo a sus ajustes, para ponerle nombre y días.
    set(settingsScope, 'profile')
    set(settingsOpen, true)
  }
}

const updateProfile = (profileId: string, patch: ProfilePatch) =>
  ask(() => plugin.request('profile.update', { profileId, patch }))

function clearDraft(key: string): void {
  update(textDrafts, (drafts) => {
    const next = { ...drafts }
    delete next[key]
    return next
  })
}

async function saveBase(key: keyof GlobalSettings, value: string | number | boolean): Promise<void> {
  update(state, (current) => current && { ...current, baseSettings: { ...current.baseSettings, [key]: value } })
  try {
    // El worker oye el cambio y manda el estado nuevo a todos los paneles.
    await pluginSettings.set(key, value)
    clearDraft(`all:${key}`)
  } catch (error) {
    set(failure, errorText(error))
  }
}

async function saveProfileSetting(profile: Profile, key: keyof GlobalSettings, value: unknown): Promise<void> {
  const settings: Record<string, unknown> = { ...profile.settings }
  if (value === undefined) delete settings[key]
  else settings[key] = value
  // El modelo va con su agente: al cambiar de agente, el perfil deja de fijar modelo.
  if (key === 'agent') {
    delete settings.model
    delete settings.effort
  }
  if (await updateProfile(profile.id, { settings: settings as Partial<GlobalSettings> })) clearDraft(`profile:${key}`)
}

/** Cambiar el agente de todos los perfiles vuelve el modelo al de su configuración. */
async function saveBaseAgent(current: PanelState, agent: string): Promise<void> {
  await saveBase('agent', agent)
  if (current.baseSettings.model) await saveBase('model', '')
  if (current.baseSettings.effort) await saveBase('effort', '')
}

function startEditing(projectId: string, state: Pick<PanelState, 'overrides' | 'commands'>): void {
  const current = read(editing)
  if (current?.projectId === projectId) return set(editing, null)
  set(editing, {
    projectId,
    draft: { ...(state.overrides[projectId] ?? {}) },
    commands: (state.commands[projectId] ?? []).map((command) => ({ ...command, files: [...command.files] }))
  })
  set(openCommand, null)
  set(filesDrafts, {})
  void loadSuggestions(projectId)
}

async function loadSuggestions(projectId: string): Promise<void> {
  update(suggestions, (all) => ({ ...all, [projectId]: undefined }))
  try {
    const answer = await plugin.request('commands.suggest', { projectId })
    update(suggestions, (all) => ({ ...all, [projectId]: answer.suggestions }))
  } catch {
    update(suggestions, (all) => ({ ...all, [projectId]: [] }))
  }
}

function changeCommands(change: (commands: CommandDef[]) => CommandDef[]): void {
  update(editing, (current) => current && { ...current, commands: change(current.commands) })
}

function patchCommand(id: string, patch: Partial<CommandDef>): void {
  changeCommands((commands) => commands.map((command) => (command.id === id ? { ...command, ...patch } : command)))
}

function addCommand(suggestion?: CommandSuggestion): void {
  const current = read(editing)
  if (!current) return
  const id = newCommandId(current.commands)
  const command = suggestion
    ? emptyCommand(id, suggestion.command, suggestion.kind, suggestion.name)
    : emptyCommand(id)
  changeCommands((commands) => [...commands, command])
  // Uno nuevo y vacío se abre para escribirlo; uno sugerido ya está listo.
  if (!suggestion) set(openCommand, id)
}

function moveCommand(id: string, by: -1 | 1): void {
  changeCommands((commands) => {
    const from = commands.findIndex((command) => command.id === id)
    const to = from + by
    if (from < 0 || to < 0 || to >= commands.length) return commands
    const next = [...commands]
    ;[next[from], next[to]] = [next[to], next[from]]
    return next
  })
}

function changeDraft(key: keyof ProjectOverride, value: unknown): void {
  update(editing, (current) => {
    if (!current) return current
    const draft: Record<string, unknown> = { ...current.draft }
    if (value === undefined) delete draft[key]
    else draft[key] = value
    // El modelo va con su agente: al cambiar de agente, el proyecto deja de fijar modelo.
    if (key === 'agent') {
      delete draft.model
      delete draft.effort
    }
    return { ...current, draft: draft as ProjectOverride }
  })
}

async function saveOverride(projectId: string, override: ProjectOverride | null): Promise<void> {
  if (await ask(() => plugin.request('override.set', { projectId, override }))) set(editing, null)
}

/** Guardar en el editor del proyecto: sus ajustes propios y su lista de comandos. */
async function saveProject(projectId: string, override: ProjectOverride, commands: CommandDef[]): Promise<void> {
  if (!(await ask(() => plugin.request('override.set', { projectId, override })))) return
  if (await ask(() => plugin.request('commands.set', { projectId, commands }))) set(editing, null)
}

const closeTerminals = () => ask(() => plugin.request('terminals.closeAll'))

async function exportConfig(): Promise<void> {
  try {
    const { fileName, text } = await plugin.request('config.export')
    const saved = await host.call('files.saveAs', { suggestedName: fileName, mimeType: 'application/json', data: text })
    set(exportNote, saved.status === 'saved' ? `Guardado como ${fileName}.` : null)
  } catch (error) {
    set(failure, errorText(error))
  }
}

async function importConfig(): Promise<void> {
  try {
    const { state: next, report } = await plugin.request('config.import', { text: read(importText) })
    setState(next)
    set(importResult, report)
    set(importText, '')
    set(failure, null)
  } catch (error) {
    set(failure, errorText(error))
  }
}

async function undoImport(): Promise<void> {
  if (await ask(() => plugin.request('config.undoImport'))) set(importResult, null)
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('state.changed', (next) => setState(next)))
  ctx.subscriptions.push(plugin.on('progress.changed', (next) => set(progress, next.progress)))
  void load()
}

// ——— Campos de ajustes ———

function choiceLabel(field: FieldDef, value: unknown, agent = 'claude'): string {
  if (field.kind === 'toggle') return value ? 'sí' : 'no'
  if (field.kind === 'choice') return field.options.find((option) => option.value === value)?.label ?? String(value)
  if (field.kind === 'number') return numberLabel(field, Number(value))
  if (field.kind === 'model') return modelLabel(agent, String(value ?? ''))
  return String(value ?? '') || 'vacío'
}

/** Un Select no distingue bien la opción vacía: '' viaja como EMPTY. */
const EMPTY = '__empty'
const encode = (value: string) => (value === '' ? EMPTY : value)
const decode = (value: string) => (value === EMPTY ? '' : value)
const CUSTOM = '__custom'

/**
 * El modelo, según el agente: una lista (para Claude), «el de su configuración» u «Otro»
 * para escribirlo. `value` undefined = hereda (`inheritLabel` dice de qué). Con `draft`, lo escrito
 * se guarda al momento (editor del proyecto); sin él, con su botón.
 */
function ModelPicker({
  agent,
  value,
  inheritLabel,
  scope,
  draft,
  onSave
}: {
  agent: string
  value: string | undefined
  inheritLabel?: string
  scope: string
  draft?: boolean
  onSave: (value: string | undefined) => void
}) {
  const support = modelSupport(agent)
  if (!support) {
    return (
      <Text muted size="sm">
        {`${agentLabel(agent)} usa el modelo de su propia configuración: aquí no se puede elegir.`}
      </Text>
    )
  }
  const known = support.models.map((option) => option.value)
  const typed = value !== undefined && value !== '' && !known.includes(value)
  const writing = typed || read(customModel)[scope] === true
  const setWriting = (on: boolean) => update(customModel, (all) => ({ ...all, [scope]: on }))
  const options = [
    ...(inheritLabel ? [{ value: INHERIT, label: inheritLabel }] : []),
    { value: EMPTY, label: 'El de su propia configuración' },
    ...support.models,
    { value: CUSTOM, label: 'Otro (escribirlo)' }
  ]
  const draftKey = `${scope}:model`
  const shown = read(textDrafts)[draftKey] ?? (typed ? value : '')
  return (
    <Stack gap="xs">
      <Select
        label="Modelo"
        value={value === undefined && !writing ? INHERIT : writing ? CUSTOM : encode(value ?? '')}
        options={options}
        onChange={(next) => {
          if (next === CUSTOM) return setWriting(true)
          setWriting(false)
          clearDraft(draftKey)
          onSave(next === INHERIT ? undefined : decode(next))
        }}
      />
      {writing ? (
        <Row gap="xs" align="end">
          <Box grow>
            <Input
              label="Id del modelo"
              value={shown}
              placeholder={support.placeholder}
              maxLength={200}
              onChange={(next) => {
                if (draft) onSave(next.trim() || undefined)
                else update(textDrafts, (drafts) => ({ ...drafts, [draftKey]: next }))
              }}
            />
          </Box>
          {draft ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={!shown.trim() || shown.trim() === value}
              onPress={() => {
                clearDraft(draftKey)
                onSave(shown.trim())
              }}
            >
              Guardar modelo
            </Button>
          )}
        </Row>
      ) : null}
    </Stack>
  )
}

function numberLabel(field: Extract<FieldDef, { kind: 'number' }>, value: number): string {
  return value === 0 && field.zero ? field.zero : `${value}${field.unit}`
}

const INHERIT = '__inherit'

/**
 * Un ajuste de todos los perfiles (`inherited` sin dar) o de un perfil, que puede seguir al de
 * todos. Se guarda al momento, salvo los textos, que tienen su botón.
 */
function SettingField({
  field,
  scope,
  value,
  inherited,
  agent,
  onSave
}: {
  field: FieldDef
  scope: string
  value: unknown
  inherited?: unknown
  /** El agente que vale en este sitio: decide qué modelos y razonamiento se ofrecen. */
  agent: string
  onSave: (value: unknown) => void
}) {
  const inheritable = inherited !== undefined
  const inherit = { value: INHERIT, label: `Como en todos los perfiles (${choiceLabel(field, inherited, agent)})` }
  const own = value !== undefined
  if (field.key === 'effort' && !modelSupport(agent)?.effort) return null
  switch (field.kind) {
    case 'model':
      return (
        <ModelPicker
          agent={agent}
          value={own ? String(value) : undefined}
          inheritLabel={inheritable ? inherit.label : undefined}
          scope={scope}
          onSave={onSave}
        />
      )
    case 'toggle':
      return inheritable ? (
        <Select
          label={field.label}
          value={own ? (value ? 'on' : 'off') : INHERIT}
          options={[inherit, { value: 'on', label: 'Sí' }, { value: 'off', label: 'No' }]}
          onChange={(next) => onSave(next === INHERIT ? undefined : next === 'on')}
        />
      ) : (
        <Checkbox
          label={field.label}
          description={field.description}
          checked={value === true}
          onChange={(checked) => onSave(checked)}
        />
      )
    case 'choice': {
      const options = field.options.map((option) => ({ ...option, value: encode(option.value) }))
      return (
        <Stack gap="xs">
          <Select
            label={field.label}
            value={own ? encode(String(value)) : INHERIT}
            options={inheritable ? [inherit, ...options] : options}
            onChange={(next) => onSave(next === INHERIT ? undefined : decode(next))}
          />
          {field.description ? (
            <Text muted size="xs">
              {field.description}
            </Text>
          ) : null}
        </Stack>
      )
    }
    case 'number': {
      const presets = [...new Set([...field.presets, ...(own ? [Number(value)] : [])])].sort((a, b) => a - b)
      const options = presets.map((preset) => ({ value: String(preset), label: numberLabel(field, preset) }))
      return (
        <Select
          label={field.label}
          value={own ? String(value) : INHERIT}
          options={inheritable ? [inherit, ...options] : options}
          onChange={(next) => onSave(next === INHERIT ? undefined : Number(next))}
        />
      )
    }
    case 'text': {
      const draftKey = `${scope}:${field.key}`
      const draft = read(textDrafts)[draftKey]
      const saved = own ? String(value) : ''
      const shown = draft ?? saved
      const dirty = draft !== undefined && draft !== saved
      const placeholder = inheritable
        ? `Vacío = como en todos los perfiles${inherited ? `: ${String(inherited).slice(0, 60)}` : ''}`
        : field.placeholder
      const onChange = (next: string) => update(textDrafts, (drafts) => ({ ...drafts, [draftKey]: next }))
      return (
        <Stack gap="xs">
          {field.multiline ? (
            <Textarea label={field.label} value={shown} placeholder={placeholder} rows={3} maxLength={field.maxLength} onChange={onChange} />
          ) : (
            <Input label={field.label} value={shown} placeholder={placeholder} maxLength={field.maxLength} onChange={onChange} />
          )}
          {field.description ? (
            <Text muted size="xs">
              {field.description}
            </Text>
          ) : null}
          <Row gap="xs">
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty}
              onPress={() => onSave(inheritable && shown.trim() === '' ? undefined : shown)}
            >
              {`Guardar ${field.label.toLowerCase()}`}
            </Button>
          </Row>
        </Stack>
      )
    }
  }
}

/** Un grupo de ajustes por pestaña, para no tener una lista interminable. */
function SettingsTabs({
  label,
  groups,
  tab,
  renderField,
  extra = {}
}: {
  label: string
  groups: FieldGroup[]
  tab: typeof globalTab
  renderField: (field: FieldDef) => OrcaNode
  /** Contenido de más al final de una pestaña, por su título. */
  extra?: Record<string, OrcaNode>
}) {
  const current = groups.some((group) => group.title === read(tab)) ? read(tab) : groups[0].title
  return (
    <Tabs label={label} value={current} onChange={(value) => set(tab, value)}>
      {groups.map((group) => (
        <Tab key={group.title} value={group.title} label={group.title}>
          <Stack gap="sm">
            {group.fields.map((field) => renderField(field))}
            {extra[group.title] ?? null}
          </Stack>
        </Tab>
      ))}
    </Tabs>
  )
}

// ——— Comandos de un proyecto ———

const KIND_OPTIONS = [
  { value: 'tab', label: 'En su pestaña (servidores, watchers…)' },
  { value: 'prepare', label: 'Preparación: en segundo plano, y se espera' }
]

const WHEN_OPTIONS = [
  { value: 'always', label: 'Siempre' },
  { value: 'commits', label: 'Solo si entran commits' },
  { value: 'files', label: 'Solo si cambian ciertos archivos' }
]

function CommandRow({ command, index, total }: { command: CommandDef; index: number; total: number }) {
  const kind = command.kind === 'tab' ? 'Pestaña' : 'Preparación'
  const filesText = read(filesDrafts)[command.id] ?? command.files.join(', ')
  return (
    <Collapsible
      title={command.command || 'Comando nuevo'}
      description={`${kind} · ${describeWhen(command)}${command.enabled ? '' : ' · desactivado'}`}
      open={read(openCommand) === command.id}
      onChange={(open) => set(openCommand, open ? command.id : null)}
    >
      <Stack gap="xs">
        <Input
          label="Comando"
          value={command.command}
          placeholder="npm run dev"
          maxLength={500}
          onChange={(value) => patchCommand(command.id, { command: value })}
        />
        <Input
          label="Nombre (opcional)"
          value={command.name}
          placeholder="Para el título de su pestaña"
          maxLength={40}
          onChange={(value) => patchCommand(command.id, { name: value })}
        />
        <Select
          label="Tipo"
          value={command.kind}
          options={KIND_OPTIONS}
          onChange={(value) =>
            patchCommand(command.id, value === 'prepare' ? { kind: 'prepare', restart: false, openUrl: false } : { kind: 'tab' })
          }
        />
        <Select
          label="Cuándo"
          value={command.when}
          options={WHEN_OPTIONS}
          onChange={(value) => patchCommand(command.id, { when: value === 'commits' || value === 'files' ? value : 'always' })}
        />
        {command.when === 'files' ? (
          <Stack gap="xs">
            <Input
              label="Archivos"
              value={filesText}
              placeholder="database/migrations/, package.json"
              onChange={(value) => {
                update(filesDrafts, (drafts) => ({ ...drafts, [command.id]: value }))
                patchCommand(command.id, {
                  files: value
                    .split(',')
                    .map((file) => file.trim())
                    .filter(Boolean)
                })
              }}
            />
            <Text muted size="xs">
              Separados por comas, desde la raíz del proyecto. «carpeta/» es todo lo de dentro; valen * y **.
            </Text>
          </Stack>
        ) : null}
        {command.kind === 'tab' ? (
          <Stack gap="xs">
            <Checkbox
              label="Reiniciar si ya está abierto"
              description="Cierra su pestaña y la abre otra vez. Solo puede con las que abrió Monstruito."
              checked={command.restart}
              onChange={(checked) => patchCommand(command.id, { restart: checked })}
            />
            <Checkbox
              label="Abrir la web cuando esté lista"
              description="Cuando escuche en un puerto nuevo, abre su dirección en el navegador de Orca, por detrás."
              checked={command.openUrl}
              onChange={(checked) => patchCommand(command.id, { openUrl: checked })}
            />
          </Stack>
        ) : null}
        <Checkbox
          label="Activo"
          checked={command.enabled}
          onChange={(checked) => patchCommand(command.id, { enabled: checked })}
        />
        <Row gap="xs" wrap>
          <Button size="sm" variant="ghost" disabled={index === 0} onPress={() => moveCommand(command.id, -1)}>
            Subir
          </Button>
          <Button size="sm" variant="ghost" disabled={index === total - 1} onPress={() => moveCommand(command.id, 1)}>
            Bajar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            icon="delete"
            onPress={() => changeCommands((commands) => commands.filter((item) => item.id !== command.id))}
          >
            Quitar
          </Button>
        </Row>
      </Stack>
    </Collapsible>
  )
}

function CommandsEditor({ projectId }: { projectId: string }) {
  const current = read(editing)
  if (!current) return null
  const list = current.commands
  const proposed = read(suggestions)[projectId]
  const free = (proposed ?? []).filter((suggestion) => !list.some((command) => command.command === suggestion.command))
  const sources = [...new Set(free.map((suggestion) => suggestion.source))].join(', ')
  return (
    <Stack gap="sm">
      <Separator />
      <Text weight="semibold" size="sm">
        {`Comandos del proyecto (${list.length})`}
      </Text>
      <Text muted size="xs">
        Los de preparación se ejecutan antes de abrir el agente y se esperan; los de pestaña se abren al final.
        Valen en todos los perfiles.
      </Text>
      {list.map((command, index) => (
        <CommandRow key={command.id} command={command} index={index} total={list.length} />
      ))}
      <Row>
        <Button size="sm" variant="outline" icon="add" onPress={() => addCommand()}>
          Añadir comando
        </Button>
      </Row>
      {proposed === undefined ? (
        <Spinner label="Buscando comandos que proponer" />
      ) : free.length > 0 ? (
        <Stack gap="xs">
          <Text muted size="xs">{`Sugerencias (${sources}):`}</Text>
          <Row gap="xs" wrap>
            {free.map((suggestion) => (
              <Button
                key={suggestion.command}
                size="sm"
                variant="ghost"
                icon="add"
                tooltip={suggestion.kind === 'tab' ? 'En su pestaña' : 'Preparación'}
                onPress={() => addCommand(suggestion)}
              >
                {suggestion.command}
              </Button>
            ))}
          </Row>
        </Stack>
      ) : null}
    </Stack>
  )
}

// ——— Vista de ajustes ———

function ProfileCard({ current, profile }: { current: PanelState; profile: Profile }) {
  const nameDraft = read(profileName)
  const shownName = nameDraft ?? profile.name
  const marked = sortByRecency(current.projects.filter((project) => project.selected))
  const openOptions = [
    { value: 'none', label: 'Nada' },
    { value: OPEN_RECENT, label: 'El marcado usado más recientemente' },
    ...marked.map((project) => ({ value: project.id, label: project.name }))
  ]
  const days = describeDays(profile.days)
  const deleting = read(confirmDelete) === profile.id
  return (
    <Card title={`Perfil «${profile.name}»`} description="Sus proyectos marcados, cuándo se usa y lo que cambie de los ajustes.">
      <Stack gap="sm">
        <Row gap="xs" align="end">
          <Box grow>
            <Input label="Nombre del perfil" value={shownName} maxLength={60} onChange={(value) => set(profileName, value)} />
          </Box>
          <Button
            size="sm"
            variant="outline"
            disabled={nameDraft === null || !nameDraft.trim() || nameDraft === profile.name}
            onPress={async () => {
              if (await updateProfile(profile.id, { name: shownName })) set(profileName, null)
            }}
          >
            Guardar nombre
          </Button>
        </Row>
        <Text weight="medium" size="sm">
          Usarlo al abrir Orca estos días
        </Text>
        <Row gap="sm" wrap>
          {DAYS.map((day) => (
            <Checkbox
              key={day.value}
              label={day.long}
              checked={profile.days.includes(day.value)}
              onChange={(checked) =>
                void updateProfile(profile.id, {
                  days: checked ? [...profile.days, day.value] : profile.days.filter((value) => value !== day.value)
                })
              }
            />
          ))}
        </Row>
        <Text muted size="xs">
          {days
            ? `Al abrir Orca ${days} se usa este perfil. Los demás días, el que esté elegido arriba.`
            : 'Sin días: se usa cuando lo eliges arriba. Un día solo puede ser de un perfil.'}
        </Text>
        <Select
          label="Al terminar el arranque, mostrar"
          value={profile.openAtEnd || 'none'}
          options={openOptions}
          onChange={(value) => void updateProfile(profile.id, { openAtEnd: value === 'none' ? '' : value })}
        />
        <Row gap="xs" wrap>
          <Button
            size="sm"
            variant="outline"
            icon="copy"
            onPress={() => void ask(() => plugin.request('profile.create', { name: `${profile.name} (copia)`, copyFrom: profile.id }))}
          >
            Duplicar
          </Button>
          <Button
            size="sm"
            variant={deleting ? 'solid' : 'ghost'}
            tone="danger"
            icon="delete"
            disabled={current.profiles.length <= 1}
            onPress={async () => {
              if (!deleting) return set(confirmDelete, profile.id)
              set(confirmDelete, null)
              await ask(() => plugin.request('profile.delete', { profileId: profile.id }))
            }}
          >
            {deleting ? `Pulsa otra vez para eliminar «${profile.name}»` : 'Eliminar perfil'}
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

function TransferView({ current }: { current: PanelState }) {
  const report = read(importResult)
  const note = read(exportNote)
  return (
    <Collapsible title="Exportar o importar" description="Para llevar perfiles y ajustes a otro equipo, o guardar una copia.">
      <Stack gap="sm">
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="outline" icon="download" onPress={exportConfig}>
            Exportar a un archivo
          </Button>
          {note ? (
            <Text muted size="xs">
              {note}
            </Text>
          ) : null}
        </Row>
        <Textarea
          label="Importar"
          value={read(importText)}
          placeholder="Pega aquí el contenido del archivo exportado"
          rows={4}
          onChange={(value) => set(importText, value)}
        />
        <Text muted size="xs">
          Sustituye tus perfiles, los ajustes de todos los perfiles y los de cada proyecto. Los proyectos se buscan
          por ruta y, si no, por nombre. Antes se guarda una copia para poder deshacerlo.
        </Text>
        <Row gap="xs" wrap>
          <Button size="sm" icon="upload" disabled={!read(importText).trim()} onPress={importConfig}>
            Importar
          </Button>
          {current.canUndoImport ? (
            <Button size="sm" variant="ghost" onPress={undoImport}>
              Deshacer la última importación
            </Button>
          ) : null}
        </Row>
        {report ? (
          <Callout tone={report.missing.length > 0 ? 'warning' : 'success'} title="Importado">
            {`${report.profiles} perfiles, ${report.matched} proyectos encontrados` +
              (report.missing.length > 0 ? `. No están en este equipo: ${report.missing.join(', ')}.` : '.')}
          </Callout>
        ) : null}
      </Stack>
    </Collapsible>
  )
}

/**
 * Lo que un perfil hereda de todos los perfiles. El modelo y el razonamiento de todos solo se
 * heredan si el perfil usa el mismo agente; con otro, lo heredado es «el de su configuración».
 */
function inheritedFor(current: PanelState, profile: Profile, key: keyof GlobalSettings): unknown {
  const ownAgent = profile.settings.agent
  if ((key === 'model' || key === 'effort') && ownAgent !== undefined && ownAgent !== current.baseSettings.agent) {
    return ''
  }
  return current.baseSettings[key]
}

function SettingsView({ current }: { current: PanelState }) {
  const profile = current.profiles.find((item) => item.id === current.activeProfileId) ?? current.profiles[0]
  const scope = read(settingsScope)
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={2}>Ajustes</Heading>
        <IconButton icon="close" label="Cerrar ajustes" variant="ghost" size="sm" onPress={() => set(settingsOpen, false)} />
      </Row>
      <Select
        label="Qué ajustes editas"
        value={scope}
        options={[
          { value: 'all', label: 'Los de todos los perfiles' },
          { value: 'profile', label: `Solo los del perfil «${profile.name}»` }
        ]}
        onChange={(value) => set(settingsScope, value === 'profile' ? 'profile' : 'all')}
      />
      {scope === 'profile' ? <ProfileCard current={current} profile={profile} /> : null}
      <Text muted size="xs">
        {scope === 'profile'
          ? 'Lo que dejes «Como en todos los perfiles» sigue los ajustes de todos. Cada proyecto puede cambiarlo también con su engranaje.'
          : 'Valen para todos los perfiles, salvo lo que cambie cada perfil o cada proyecto con su engranaje.'}
      </Text>
      <SettingsTabs
        label="Grupos de ajustes"
        groups={GLOBAL_GROUPS}
        tab={globalTab}
        renderField={(field) =>
          scope === 'profile' ? (
            <SettingField
              key={field.key}
              field={field}
              scope="profile"
              value={profile.settings[field.key]}
              inherited={inheritedFor(current, profile, field.key)}
              agent={profile.settings.agent ?? current.baseSettings.agent}
              onSave={(value) => void saveProfileSetting(profile, field.key, value)}
            />
          ) : (
            <SettingField
              key={field.key}
              field={field}
              scope="all"
              value={current.baseSettings[field.key]}
              agent={current.baseSettings.agent}
              onSave={(value) =>
                void (field.key === 'agent'
                  ? saveBaseAgent(current, String(value))
                  : saveBase(field.key, value as string | number | boolean))
              }
            />
          )
        }
        extra={{
          Comandos: (
            <Text muted size="xs">
              Los comandos (npm run dev, migraciones, docker…) son de cada proyecto: se añaden en su engranaje, en la
              pestaña Comandos.
            </Text>
          )
        }}
      />
      <TransferView current={current} />
    </Stack>
  )
}

// ——— Ajustes de un proyecto ———

const OWN_INHERIT = '__global'

function OverrideField({ field, draft, global }: { field: FieldDef; draft: ProjectOverride; global: GlobalSettings }) {
  const key = field.key as keyof ProjectOverride
  const current = draft[key]
  const agent = draft.agent ?? global.agent
  // El modelo del perfil solo se hereda si el proyecto usa el mismo agente.
  const otherAgent = draft.agent !== undefined && draft.agent !== global.agent
  const inherited = (key === 'model' || key === 'effort') && otherAgent ? '' : global[field.key]
  const inherit = { value: OWN_INHERIT, label: `Como el perfil (${choiceLabel(field, inherited, agent)})` }
  if (key === 'effort' && !modelSupport(agent)?.effort) return null
  switch (field.kind) {
    case 'model':
      return (
        <ModelPicker
          agent={agent}
          value={current === undefined ? undefined : String(current)}
          inheritLabel={inherit.label}
          scope="project"
          draft
          onSave={(value) => changeDraft('model', value)}
        />
      )
    case 'toggle':
      return (
        <Select
          label={field.label}
          value={current === undefined ? OWN_INHERIT : current ? 'on' : 'off'}
          options={[inherit, { value: 'on', label: 'Sí' }, { value: 'off', label: 'No' }]}
          onChange={(next) => changeDraft(key, next === OWN_INHERIT ? undefined : next === 'on')}
        />
      )
    case 'choice':
      return (
        <Select
          label={field.label}
          value={current === undefined ? OWN_INHERIT : encode(String(current))}
          options={[inherit, ...field.options.map((option) => ({ ...option, value: encode(option.value) }))]}
          onChange={(next) => changeDraft(key, next === OWN_INHERIT ? undefined : decode(next))}
        />
      )
    case 'text': {
      const placeholder = `Vacío = como el perfil${global[field.key] ? `: ${String(global[field.key]).slice(0, 60)}` : ''}`
      const onChange = (next: string) => changeDraft(key, next.trim() === '' ? undefined : next)
      return field.multiline ? (
        <Textarea label={field.label} value={String(current ?? '')} placeholder={placeholder} rows={3} maxLength={field.maxLength} onChange={onChange} />
      ) : (
        <Input label={field.label} value={String(current ?? '')} placeholder={placeholder} maxLength={field.maxLength} onChange={onChange} />
      )
    }
    case 'number':
      return null
  }
}

function ProjectEditor({ project, global }: { project: ProjectRow; global: GlobalSettings }) {
  const current = read(editing)
  if (!current) return null
  return (
    <Card title={`Ajustes de ${project.name}`} description="En todos los perfiles. Lo que dejes «Como el perfil» sigue los del perfil.">
      <Stack gap="sm">
        <SettingsTabs
          label="Grupos de ajustes del proyecto"
          groups={PROJECT_GROUPS}
          tab={projectTab}
          renderField={(field) => <OverrideField key={field.key} field={field} draft={current.draft} global={global} />}
          extra={{ Comandos: <CommandsEditor projectId={project.id} /> }}
        />
        <Row gap="xs" wrap>
          <Button size="sm" onPress={() => void saveProject(project.id, current.draft, current.commands)}>
            Guardar
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(editing, null)}>
            Cancelar
          </Button>
          {project.customized ? (
            <Button size="sm" variant="ghost" tone="danger" onPress={() => void saveOverride(project.id, null)}>
              Quitar ajustes propios
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Card>
  )
}

// ——— Lista de proyectos ———

/** Al buscar se ve todo lo que coincide y abrir o cerrar no cambia lo recordado. */
type TreeView = {
  isOpen: (key: string) => boolean
  setOpen: (key: string, open: boolean) => void
  now: number
  settings: GlobalSettings
  overrides: Record<string, ProjectOverride>
  commands: Record<string, CommandDef[]>
}

function ProjectItem({
  project,
  here,
  folder,
  view
}: {
  project: ProjectRow
  /** Es la carpeta que se está viendo, no un proyecto dentro de ella. */
  here?: boolean
  /** En la lista de marcados, dónde está, ya que ahí no se ve el árbol. */
  folder?: string
  view: TreeView
}) {
  const used = project.lastUsedAt === null ? 'Sin uso en Orca' : `Usado ${usedAgo(project.lastUsedAt, view.now)}`
  const where = here ? 'Esta carpeta' : folder
  const isEditing = read(editing)?.projectId === project.id
  return (
    <Stack gap="xs">
      <Row gap="xs" align="center">
        <Box grow>
          <Checkbox
            label={project.name}
            description={where ? `${where} · ${used}` : used}
            checked={project.selected}
            onChange={(checked) => void toggle(project.id, checked)}
          />
        </Box>
        {project.customized ? <Badge tone="accent">propio</Badge> : null}
        {view.commands[project.id]?.length ? (
          <Badge tone="neutral">{`${view.commands[project.id].length} cmd`}</Badge>
        ) : null}
        <IconButton
          icon="settings"
          label={`Ajustes de ${project.name}`}
          variant="ghost"
          size="sm"
          tone={isEditing ? 'accent' : 'neutral'}
          onPress={() => startEditing(project.id, view)}
        />
      </Row>
      {isEditing ? <ProjectEditor project={project} global={view.settings} /> : null}
    </Stack>
  )
}

function folderSummary(folder: FolderNode, now: number): string {
  const parts = [`${folder.total} ${folder.total === 1 ? 'proyecto' : 'proyectos'}`]
  if (folder.lastUsedAt !== null) parts.push(`usado ${usedAgo(folder.lastUsedAt, now)}`)
  return parts.join(' · ')
}

/** Todos los proyectos de una carpeta, también los de sus subcarpetas. */
function projectIdsIn(folder: FolderNode): string[] {
  return [
    ...folder.projects.map((project) => project.id),
    ...folder.children.flatMap((child) => (child.kind === 'project' ? [child.project.id] : projectIdsIn(child)))
  ]
}

function NodeView({ node, view }: { node: TreeNode; view: TreeView }) {
  if (node.kind === 'project') return <ProjectItem project={node.project} view={view} />
  return (
    <Collapsible
      title={node.name}
      description={folderSummary(node, view.now)}
      open={view.isOpen(node.key)}
      onChange={(open) => view.setOpen(node.key, open)}
    >
      <Box paddingX="sm" gap="xs">
        <Row>
          <Button size="sm" variant="ghost" icon="check" onPress={() => void markMany(projectIdsIn(node), true)}>
            {`Marcar los ${node.total}`}
          </Button>
        </Row>
        {node.projects.map((project) => (
          <ProjectItem key={project.id} project={project} here view={view} />
        ))}
        {node.children.map((child) => (
          <NodeView key={child.key} node={child} view={view} />
        ))}
      </Box>
    </Collapsible>
  )
}

/** Arriba los marcados, en una lista; debajo el resto, en el árbol de carpetas. */
function ProjectTreeView({ current }: { current: PanelState }) {
  const search = read(query)
  const searching = search.trim().length > 0
  const allSelected = current.projects.filter((project) => project.selected)
  const marked = sortByRecency(allSelected.filter((project) => matchesQuery(project, search)))
  const base = buildTree(current.projects).base
  const tree = buildTree(current.projects.filter((project) => !project.selected))
  const nodes = filterTree(tree.nodes, search)
  const open = new Set(read(expanded) ?? defaultExpanded(tree.nodes))
  const view: TreeView = {
    now: Date.now(),
    settings: current.settings,
    overrides: current.overrides,
    commands: current.commands,
    isOpen: (key) => searching || open.has(key),
    setOpen: (key, isOpen) => {
      if (searching) return
      const next = new Set(open)
      if (isOpen) next.add(key)
      else next.delete(key)
      set(expanded, [...next])
    }
  }
  return (
    <Stack gap="md">
      {allSelected.length > 0 ? (
        <Stack gap="xs">
          <Text weight="semibold">{`Marcados · ${allSelected.length}`}</Text>
          {marked.length === 0 ? (
            <Text muted size="sm">
              Ningún proyecto marcado coincide.
            </Text>
          ) : (
            marked.map((project) => (
              <ProjectItem key={project.id} project={project} folder={folderOf(project.path, base)} view={view} />
            ))
          )}
        </Stack>
      ) : (
        <Text muted size="sm">
          Marca los proyectos que quieres preparar al abrir Orca: pasarán a una lista aparte, arriba.
        </Text>
      )}
      <Stack gap="xs">
        {allSelected.length > 0 ? <Text weight="semibold">Sin marcar</Text> : null}
        {tree.base ? (
          <Text muted size="xs">
            {`En ${tree.base}, de más reciente a más antiguo`}
          </Text>
        ) : null}
        {nodes.length === 0 ? (
          <Text muted size="sm">
            {tree.nodes.length === 0 ? 'Están todos marcados.' : 'Ningún proyecto coincide.'}
          </Text>
        ) : (
          nodes.map((node) => <NodeView key={node.key} node={node} view={view} />)
        )}
      </Stack>
    </Stack>
  )
}

// ——— Resultados, avance e historial ———

function ResultRow({ result }: { result: ProjectResult }) {
  const badges = [
    describeGit(result.git),
    describeAgent(result.agent),
    ...result.deps.map(describeStep),
    ...visibleCommands(result)
  ]
  const skipped = (result.commands ?? []).filter((command) => command.result === 'skipped')
  const details = [
    ...badges.map((badge) => badge.detail),
    describeWorktrees(result.worktrees),
    skipped.length > 0
      ? `No tocaban: ${skipped.map((command) => `${command.name} (${command.message ?? ''})`).join(', ')}`
      : undefined
  ].filter(Boolean)
  return (
    <Stack gap="xs">
      <Text weight="medium">{result.name}</Text>
      <Row gap="xs" wrap>
        {badges.map((badge, index) => (
          <Badge key={index} tone={badge.tone}>
            {badge.text}
          </Badge>
        ))}
      </Row>
      {details.length > 0 ? (
        <Text muted size="xs">
          {details.join(' · ')}
        </Text>
      ) : null}
    </Stack>
  )
}

function RunResults({ run }: { run: RunRecord }) {
  return (
    <Stack gap="sm">
      {run.results.length === 0 ? (
        <Text muted size="sm">
          No había proyectos marcados.
        </Text>
      ) : (
        run.results.map((result) => <ResultRow key={result.projectId} result={result} />)
      )}
      {run.missing.length > 0 ? (
        <Text tone="warning" size="sm">
          {run.missing.length} proyecto(s) marcado(s) ya no están en Orca.
        </Text>
      ) : null}
      {run.stopped ? (
        <Text tone="warning" size="sm">
          Se detuvo antes de terminar.
        </Text>
      ) : null}
      {run.opened ? (
        <Text muted size="sm">
          {`Al terminar se mostró ${run.opened}.`}
        </Text>
      ) : null}
    </Stack>
  )
}

function LastRun({ run }: { run: RunRecord }) {
  return (
    <Card title="Última ejecución">
      <Stack gap="sm">
        <Text muted size="sm">
          {run.trigger === 'startup' ? 'Al abrir Orca' : 'A mano'}
          {run.profile ? ` · ${run.profile}` : ''}, <RelativeTime at={run.finishedAt} />
        </Text>
        <RunResults run={run} />
      </Stack>
    </Card>
  )
}

function HistoryView({ history }: { history: RunRecord[] }) {
  const older = history.slice(1)
  if (older.length === 0) return null
  return (
    <Collapsible title={`Ejecuciones anteriores (${older.length})`}>
      <Stack gap="xs">
        {older.map((run) => {
          const entry = describeHistoryEntry(run)
          return (
            <Collapsible key={`${run.startedAt}`} title={entry.title} description={entry.summary}>
              <RunResults run={run} />
            </Collapsible>
          )
        })}
      </Stack>
    </Collapsible>
  )
}

function ProgressView({ value }: { value: RunProgress }) {
  const shown = describeProgress(value)
  return (
    <Stack gap="xs">
      <ProgressBar label={shown.title} value={shown.percent} />
      {shown.lines.map((line) => (
        <Text key={line} muted size="xs">
          {line}
        </Text>
      ))}
    </Stack>
  )
}

function PendingView({ pending }: { pending: PendingCheck }) {
  if (pending.projects.length === 0) return null
  return (
    <Callout tone="accent" title="Commits por traer">
      <Stack gap="xs">
        {pending.projects.map((project) => (
          <Text key={project.projectId} size="sm">
            {`${project.name}: ${project.count} en ${project.upstream}`}
          </Text>
        ))}
        <Text muted size="xs">
          Revisado <RelativeTime at={pending.checkedAt} />. Ejecutar ahora los trae.
        </Text>
      </Stack>
    </Callout>
  )
}

function ProfileBar({ current }: { current: PanelState }) {
  const options = current.profiles.map((profile) => {
    const days = describeDays(profile.days)
    return { value: profile.id, label: days ? `${profile.name} · ${days}` : profile.name }
  })
  return (
    <Row gap="xs" align="end">
      <Box grow>
        <Select
          label="Perfil"
          value={current.activeProfileId}
          options={options}
          onChange={(value) => {
            set(profileName, null)
            void selectProfile(value)
          }}
        />
      </Box>
      <IconButton icon="add" label="Nuevo perfil" variant="ghost" onPress={() => void createProfile(current)} />
    </Row>
  )
}

// ——— Panel ———

export default function Panel() {
  const current = read(state)
  const error = read(failure)
  if (!current) {
    return (
      <Stack gap="md">
        <Heading>Monstruito</Heading>
        {error ? (
          <Callout tone="danger" title="No he podido cargar los proyectos">
            {error}
          </Callout>
        ) : (
          <Spinner label="Cargando proyectos" />
        )}
      </Stack>
    )
  }

  const selectedCount = current.projects.filter((project) => project.selected).length
  const withCommands = current.projects.filter(
    (project) => project.selected && (current.commands[project.id]?.length ?? 0) > 0
  ).length
  const live = read(progress)
  const busy = current.running || current.checking || live !== null

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Monstruito</Heading>
        <Badge tone={selectedCount > 0 ? 'accent' : 'neutral'}>{`${selectedCount} marcados`}</Badge>
      </Row>
      <ProfileBar current={current} />
      <Text muted size="sm">
        {describePlan(current.settings, selectedCount, withCommands)}
      </Text>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <Row gap="xs" align="center" wrap>
        <Button icon="play" disabled={busy || selectedCount === 0} onPress={runNow}>
          Ejecutar ahora
        </Button>
        <Button icon="download" variant="outline" disabled={busy || selectedCount === 0} onPress={checkNow}>
          Revisar commits
        </Button>
        {busy ? (
          <Button icon="stop" variant="ghost" tone="danger" disabled={live?.stopping === true} onPress={stopNow}>
            Detener
          </Button>
        ) : null}
        {!busy && current.openedTerminals > 0 ? (
          <Button
            icon="close"
            variant="ghost"
            tooltip="Cierra las pestañas de comandos que abrió Monstruito"
            onPress={closeTerminals}
          >
            {`Cerrar pestañas (${current.openedTerminals})`}
          </Button>
        ) : null}
      </Row>
      {live ? <ProgressView value={live} /> : null}
      {current.pending ? <PendingView pending={current.pending} /> : null}
      {current.lastRun ? <LastRun run={current.lastRun} /> : null}
      <HistoryView history={current.history} />
      <Separator />
      <Row gap="xs" align="center">
        <Box grow>
          <Input
            type="search"
            label="Buscar proyecto"
            labelHidden
            placeholder="Buscar proyecto"
            value={read(query)}
            onChange={(value) => {
              set(query, value)
              // Buscar es volver a la lista de proyectos.
              if (value.trim()) set(settingsOpen, false)
            }}
          />
        </Box>
        <IconButton icon="refresh" label="Recargar proyectos" variant="ghost" onPress={reload} />
        <IconButton
          icon="settings"
          label="Ajustes"
          variant={read(settingsOpen) ? 'solid' : 'ghost'}
          tone={read(settingsOpen) ? 'accent' : 'neutral'}
          onPress={() => update(settingsOpen, (open) => !open)}
        />
      </Row>
      {read(settingsOpen) ? <SettingsView current={current} /> : <ProjectTreeView current={current} />}
    </Stack>
  )
}
