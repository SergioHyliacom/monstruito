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
  Markdown,
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
  describeAhead,
  describeGitNow,
  describeHistoryEntry,
  describeReady,
  describeWrapResult,
  describeWrapSummary,
  describePlan,
  describeProgress,
  describeStep,
  describeWorktrees,
  pendingHint,
  timeOf,
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
  type ReadyNote,
  type RunRecord,
  type WrapRecord
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
/** Si la última ejecución se ve desplegada. Se recuerda entre usos. */
const lastRunOpen = atom('lastRunOpen', true, { persist: 'plugin' })
const lastWrapOpen = atom('lastWrapOpen', true, { persist: 'plugin' })
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
  const name = `Profile ${current.profiles.length + 1}`
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
const wrapNow = () => ask(() => plugin.request('wrap.start'))
const answerStartup = (runOnStartup: boolean) => ask(() => plugin.request('startup.answer', { runOnStartup }))

async function exportConfig(): Promise<void> {
  try {
    const { fileName, text } = await plugin.request('config.export')
    const saved = await host.call('files.saveAs', { suggestedName: fileName, mimeType: 'application/json', data: text })
    set(exportNote, saved.status === 'saved' ? `Saved as ${fileName}.` : null)
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
  if (field.kind === 'toggle') return value ? 'yes' : 'no'
  if (field.kind === 'choice') return field.options.find((option) => option.value === value)?.label ?? String(value)
  if (field.kind === 'number') return numberLabel(field, Number(value))
  if (field.kind === 'model') return modelLabel(agent, String(value ?? ''))
  return String(value ?? '') || 'empty'
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
        {`${agentLabel(agent)} uses the model from its own configuration: it can't be chosen here.`}
      </Text>
    )
  }
  const known = support.models.map((option) => option.value)
  const typed = value !== undefined && value !== '' && !known.includes(value)
  const writing = typed || read(customModel)[scope] === true
  const setWriting = (on: boolean) => update(customModel, (all) => ({ ...all, [scope]: on }))
  const options = [
    ...(inheritLabel ? [{ value: INHERIT, label: inheritLabel }] : []),
    { value: EMPTY, label: 'The one from its own configuration' },
    ...support.models,
    { value: CUSTOM, label: 'Other (type it)' }
  ]
  const draftKey = `${scope}:model`
  const shown = read(textDrafts)[draftKey] ?? (typed ? value : '')
  return (
    <Stack gap="xs">
      <Select
        label="Model"
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
              label="Model id"
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
              Save model
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
  const inherit = { value: INHERIT, label: `As in all profiles (${choiceLabel(field, inherited, agent)})` }
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
          options={[inherit, { value: 'on', label: 'Yes' }, { value: 'off', label: 'No' }]}
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
        ? `Empty = as in all profiles${inherited ? `: ${String(inherited).slice(0, 60)}` : ''}`
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
              {`Save ${field.label.toLowerCase()}`}
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
  { value: 'tab', label: 'In its own tab (servers, watchers…)' },
  { value: 'prepare', label: 'Setup: in the background, and waited for' }
]

const WHEN_OPTIONS = [
  { value: 'always', label: 'Always' },
  { value: 'commits', label: 'Only if commits come in' },
  { value: 'files', label: 'Only if certain files change' }
]

function CommandRow({ command, index, total }: { command: CommandDef; index: number; total: number }) {
  const kind = command.kind === 'tab' ? 'Tab' : 'Setup'
  const filesText = read(filesDrafts)[command.id] ?? command.files.join(', ')
  return (
    <Collapsible
      title={command.command || 'New command'}
      description={`${kind} · ${describeWhen(command)}${command.enabled ? '' : ' · disabled'}`}
      open={read(openCommand) === command.id}
      onChange={(open) => set(openCommand, open ? command.id : null)}
    >
      <Stack gap="xs">
        <Input
          label="Command"
          value={command.command}
          placeholder="npm run dev"
          maxLength={500}
          onChange={(value) => patchCommand(command.id, { command: value })}
        />
        <Input
          label="Name (optional)"
          value={command.name}
          placeholder="For its tab title"
          maxLength={40}
          onChange={(value) => patchCommand(command.id, { name: value })}
        />
        <Select
          label="Type"
          value={command.kind}
          options={KIND_OPTIONS}
          onChange={(value) =>
            patchCommand(command.id, value === 'prepare' ? { kind: 'prepare', restart: false, openUrl: false } : { kind: 'tab' })
          }
        />
        <Select
          label="When"
          value={command.when}
          options={WHEN_OPTIONS}
          onChange={(value) => patchCommand(command.id, { when: value === 'commits' || value === 'files' ? value : 'always' })}
        />
        {command.when === 'files' ? (
          <Stack gap="xs">
            <Input
              label="Files"
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
              Comma-separated, from the project root. “folder/” is everything inside it; * and ** work.
            </Text>
          </Stack>
        ) : null}
        {command.kind === 'tab' ? (
          <Stack gap="xs">
            <Checkbox
              label="Restart if already open"
              description="Closes its tab and opens it again. Only works with the tabs Monstruito opened."
              checked={command.restart}
              onChange={(checked) => patchCommand(command.id, { restart: checked })}
            />
            <Checkbox
              label="Open the web page when it's ready"
              description="When it listens on a new port, opens its address in Orca's browser, in the background."
              checked={command.openUrl}
              onChange={(checked) => patchCommand(command.id, { openUrl: checked })}
            />
          </Stack>
        ) : null}
        <Checkbox
          label="Enabled"
          checked={command.enabled}
          onChange={(checked) => patchCommand(command.id, { enabled: checked })}
        />
        <Row gap="xs" wrap>
          <Button size="sm" variant="ghost" disabled={index === 0} onPress={() => moveCommand(command.id, -1)}>
            Move up
          </Button>
          <Button size="sm" variant="ghost" disabled={index === total - 1} onPress={() => moveCommand(command.id, 1)}>
            Move down
          </Button>
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            icon="delete"
            onPress={() => changeCommands((commands) => commands.filter((item) => item.id !== command.id))}
          >
            Remove
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
        {`Project commands (${list.length})`}
      </Text>
      <Text muted size="xs">
        Setup commands run before the agent opens, and are waited for; tab commands open at the end.
        They apply in all profiles.
      </Text>
      {list.map((command, index) => (
        <CommandRow key={command.id} command={command} index={index} total={list.length} />
      ))}
      <Row>
        <Button size="sm" variant="outline" icon="add" onPress={() => addCommand()}>
          Add command
        </Button>
      </Row>
      {proposed === undefined ? (
        <Spinner label="Looking for commands to suggest" />
      ) : free.length > 0 ? (
        <Stack gap="xs">
          <Text muted size="xs">{`Suggestions (${sources}):`}</Text>
          <Row gap="xs" wrap>
            {free.map((suggestion) => (
              <Button
                key={suggestion.command}
                size="sm"
                variant="ghost"
                icon="add"
                tooltip={suggestion.kind === 'tab' ? 'In its own tab' : 'Setup'}
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
    { value: 'none', label: 'Nothing' },
    { value: OPEN_RECENT, label: 'The most recently used selected project' },
    ...marked.map((project) => ({ value: project.id, label: project.name }))
  ]
  const days = describeDays(profile.days)
  const deleting = read(confirmDelete) === profile.id
  return (
    <Card title={`Profile “${profile.name}”`} description="Its selected projects, when it is used and the settings it changes.">
      <Stack gap="sm">
        <Row gap="xs" align="end">
          <Box grow>
            <Input label="Profile name" value={shownName} maxLength={60} onChange={(value) => set(profileName, value)} />
          </Box>
          <Button
            size="sm"
            variant="outline"
            disabled={nameDraft === null || !nameDraft.trim() || nameDraft === profile.name}
            onPress={async () => {
              if (await updateProfile(profile.id, { name: shownName })) set(profileName, null)
            }}
          >
            Save name
          </Button>
        </Row>
        <Text weight="medium" size="sm">
          Use it when Orca opens on these days
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
            ? `This profile is used when Orca opens: ${days}. On other days, the one chosen above.`
            : 'No days: it is used when you choose it above. A day can belong to only one profile.'}
        </Text>
        <Select
          label="When startup finishes, show"
          value={profile.openAtEnd || 'none'}
          options={openOptions}
          onChange={(value) => void updateProfile(profile.id, { openAtEnd: value === 'none' ? '' : value })}
        />
        <Row gap="xs" wrap>
          <Button
            size="sm"
            variant="outline"
            icon="copy"
            onPress={() => void ask(() => plugin.request('profile.create', { name: `${profile.name} (copy)`, copyFrom: profile.id }))}
          >
            Duplicate
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
            {deleting ? `Click again to delete “${profile.name}”` : 'Delete profile'}
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
    <Collapsible title="Export or import" description="To take profiles and settings to another computer, or keep a backup.">
      <Stack gap="sm">
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="outline" icon="download" onPress={exportConfig}>
            Export to a file
          </Button>
          {note ? (
            <Text muted size="xs">
              {note}
            </Text>
          ) : null}
        </Row>
        <Textarea
          label="Import"
          value={read(importText)}
          placeholder="Paste the contents of the exported file here"
          rows={4}
          onChange={(value) => set(importText, value)}
        />
        <Text muted size="xs">
          Replaces your profiles, the settings for all profiles and each project's settings. Projects are matched
          by path and, failing that, by name. A backup is saved first so you can undo it.
        </Text>
        <Row gap="xs" wrap>
          <Button size="sm" icon="upload" disabled={!read(importText).trim()} onPress={importConfig}>
            Import
          </Button>
          {current.canUndoImport ? (
            <Button size="sm" variant="ghost" onPress={undoImport}>
              Undo the last import
            </Button>
          ) : null}
        </Row>
        {report ? (
          <Callout tone={report.missing.length > 0 ? 'warning' : 'success'} title="Imported">
            {`${report.profiles} profiles, ${report.matched} projects found` +
              (report.missing.length > 0 ? `. Not on this computer: ${report.missing.join(', ')}.` : '.')}
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
        <Heading level={2}>Settings</Heading>
        <IconButton icon="close" label="Close settings" variant="ghost" size="sm" onPress={() => set(settingsOpen, false)} />
      </Row>
      <Select
        label="Which settings you are editing"
        value={scope}
        options={[
          { value: 'all', label: 'The ones for all profiles' },
          { value: 'profile', label: `Only the ones for profile “${profile.name}”` }
        ]}
        onChange={(value) => set(settingsScope, value === 'profile' ? 'profile' : 'all')}
      />
      {scope === 'profile' ? <ProfileCard current={current} profile={profile} /> : null}
      <Text muted size="xs">
        {scope === 'profile'
          ? 'Whatever you leave as “As in all profiles” follows the settings for all profiles. Each project can also change it with its gear.'
          : 'They apply to all profiles, except what each profile, or each project with its gear, changes.'}
      </Text>
      <SettingsTabs
        label="Settings groups"
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
          Commands: (
            <Text muted size="xs">
              Commands (npm run dev, migrations, docker…) belong to each project: add them in its gear, in the
              Commands tab.
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
  const inherit = { value: OWN_INHERIT, label: `As in the profile (${choiceLabel(field, inherited, agent)})` }
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
          options={[inherit, { value: 'on', label: 'Yes' }, { value: 'off', label: 'No' }]}
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
      const placeholder = `Empty = as in the profile${global[field.key] ? `: ${String(global[field.key]).slice(0, 60)}` : ''}`
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
    <Card title={`Settings for ${project.name}`} description="In all profiles. Whatever you leave as “As in the profile” follows the profile.">
      <Stack gap="sm">
        <SettingsTabs
          label="Project settings groups"
          groups={PROJECT_GROUPS}
          tab={projectTab}
          renderField={(field) => <OverrideField key={field.key} field={field} draft={current.draft} global={global} />}
          extra={{ Commands: <CommandsEditor projectId={project.id} /> }}
        />
        <Row gap="xs" wrap>
          <Button size="sm" onPress={() => void saveProject(project.id, current.draft, current.commands)}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(editing, null)}>
            Cancel
          </Button>
          {project.customized ? (
            <Button size="sm" variant="ghost" tone="danger" onPress={() => void saveOverride(project.id, null)}>
              Remove custom settings
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
  const used = project.lastUsedAt === null ? 'Not used in Orca' : `Used ${usedAgo(project.lastUsedAt, view.now)}`
  const where = here ? 'This folder' : folder
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
        {project.customized ? <Badge tone="accent">custom</Badge> : null}
        {view.commands[project.id]?.length ? (
          <Badge tone="neutral">{`${view.commands[project.id].length} cmd`}</Badge>
        ) : null}
        <IconButton
          icon="settings"
          label={`Settings for ${project.name}`}
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
  const parts = [`${folder.total} ${folder.total === 1 ? 'project' : 'projects'}`]
  if (folder.lastUsedAt !== null) parts.push(`used ${usedAgo(folder.lastUsedAt, now)}`)
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
            {`Select all ${node.total}`}
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
  const unselected = current.projects.length - allSelected.length
  return (
    <Stack gap="md">
      {allSelected.length > 0 ? (
        // Un recuadro con el borde de acento: lo que se va a preparar no se confunde con el árbol.
        <Box border="accent" radius="md" padding="sm" gap="xs">
          <Text weight="semibold">{`Selected · ${allSelected.length}`}</Text>
          {marked.length === 0 ? (
            <Text muted size="sm">
              No selected project matches.
            </Text>
          ) : (
            marked.map((project) => (
              <ProjectItem key={project.id} project={project} folder={folderOf(project.path, base)} view={view} />
            ))
          )}
        </Box>
      ) : (
        <Text muted size="sm">
          Select the projects you want ready when Orca opens: they move to a separate list, at the top.
        </Text>
      )}
      {allSelected.length > 0 ? <Separator /> : null}
      <Stack gap="xs">
        {allSelected.length > 0 ? <Text weight="semibold">{`Not selected · ${unselected}`}</Text> : null}
        {tree.base ? (
          <Text muted size="xs">
            {`In ${tree.base}, most recent first`}
          </Text>
        ) : null}
        {nodes.length === 0 ? (
          <Text muted size="sm">
            {tree.nodes.length === 0 ? 'All projects are selected.' : 'No project matches.'}
          </Text>
        ) : (
          nodes.map((node) => <NodeView key={node.key} node={node} view={view} />)
        )}
      </Stack>
    </Stack>
  )
}

// ——— Resultados, avance e historial ———

/** Lo que solo se ve en la última ejecución: cómo está ahora (ver PanelState). */
type LiveView = { behindNow?: number; ready?: ReadyNote; proposed?: number }

function ResultRow({ result, live = {} }: { result: ProjectResult; live?: LiveView }) {
  const ahead = describeAhead(result.git)
  // En el historial no se sabe cómo acabó el brief: solo en la última ejecución.
  const ready = live.behindNow !== undefined || live.ready || live.proposed !== undefined ? describeReady(result, live.ready) : null
  const badges = [
    ...(ready ? [ready] : []),
    describeGitNow(result.git, live.behindNow),
    ...(ahead ? [ahead] : []),
    describeAgent(result.agent),
    ...result.deps.map(describeStep),
    ...visibleCommands(result)
  ]
  const skipped = (result.commands ?? []).filter((command) => command.result === 'skipped')
  const details = [
    ...badges.map((badge) => badge.detail),
    describeWorktrees(result.worktrees),
    skipped.length > 0
      ? `Skipped: ${skipped.map((command) => `${command.name} (${command.message ?? ''})`).join(', ')}`
      : undefined,
    live.proposed
      ? `The agent proposed ${live.proposed === 1 ? '1 command' : `${live.proposed} commands`}: review them in the project's gear.`
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
      {live.ready?.text ? (
        <Collapsible title="What the agent did" description={`Written ${timeOf(live.ready.at, Date.now())}`}>
          <Markdown content={live.ready.text} />
        </Collapsible>
      ) : null}
    </Stack>
  )
}

/** Solo la última ejecución trae `now`: cómo está ahora cada proyecto. */
type RunNow = { behindNow: Record<string, number>; ready: Record<string, ReadyNote>; proposed: Record<string, number> }

function RunResults({ run, now }: { run: RunRecord; now?: RunNow }) {
  return (
    <Stack gap="sm">
      {run.results.length === 0 ? (
        <Text muted size="sm">
          No projects were selected.
        </Text>
      ) : (
        run.results.map((result) => (
          <ResultRow
            key={result.projectId}
            result={result}
            live={
              now
                ? {
                    behindNow: now.behindNow[result.projectId],
                    ready: now.ready[result.projectId],
                    proposed: now.proposed[result.projectId] ?? 0
                  }
                : undefined
            }
          />
        ))
      )}
      {run.missing.length > 0 ? (
        <Text tone="warning" size="sm">
          {run.missing.length === 1 ? '1 selected project is' : `${run.missing.length} selected projects are`} no longer in Orca.
        </Text>
      ) : null}
      {run.stopped ? (
        <Text tone="warning" size="sm">
          Stopped before finishing.
        </Text>
      ) : null}
      {run.opened ? (
        <Text muted size="sm">
          {`Showed ${run.opened} at the end.`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** Plegada, la última ejecución deja solo su resumen, para que no se confunda con el estado actual. */
function LastRun({ run, now }: { run: RunRecord; now: RunNow }) {
  return (
    <Box border radius="md" padding="xs" background="card">
      <Collapsible
        title="Last run"
        description={describeHistoryEntry(run).summary}
        open={read(lastRunOpen)}
        onChange={(open) => set(lastRunOpen, open)}
      >
        <Stack gap="sm">
          <Text muted size="sm">
            {run.trigger === 'startup' ? 'When Orca opened' : 'Manual'}
            {`${run.profile ? ` · ${run.profile}` : ''} · ${timeOf(run.finishedAt, Date.now())}`}
          </Text>
          <RunResults run={run} now={now} />
        </Stack>
      </Collapsible>
    </Box>
  )
}

/** El último cierre del día: la nota para mañana y lo que quedó sin guardar o sin subir. */
function LastWrap({ record }: { record: WrapRecord }) {
  return (
    <Box border radius="md" padding="xs" background="card">
      <Collapsible
        title="Last wrap-up"
        description={describeWrapSummary(record)}
        open={read(lastWrapOpen)}
        onChange={(open) => set(lastWrapOpen, open)}
      >
        <Stack gap="sm">
          <Text muted size="sm">
            {timeOf(record.finishedAt, Date.now())}
          </Text>
          {record.projects.map((result) => {
            const badges = describeWrapResult(result)
            const details = badges.map((badge) => badge.detail).filter(Boolean)
            return (
              <Stack key={result.projectId} gap="xs">
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
          })}
          {record.stopped ? (
            <Text tone="warning" size="sm">
              Stopped before finishing.
            </Text>
          ) : null}
        </Stack>
      </Collapsible>
    </Box>
  )
}

/** Primera vez: arrancar al abrir Orca, o solo a mano. */
function StartupQuestion() {
  return (
    <Callout tone="accent" title="Start when Orca opens?">
      <Stack gap="sm">
        <Text size="sm">
          Monstruito can get your selected projects ready every time Orca opens, or only when you press Run now. You can
          change it later in Settings.
        </Text>
        <Row gap="xs" wrap>
          <Button size="sm" onPress={() => void answerStartup(true)}>
            When Orca opens
          </Button>
          <Button size="sm" variant="outline" onPress={() => void answerStartup(false)}>
            Only by hand
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function HistoryView({ history }: { history: RunRecord[] }) {
  const older = history.slice(1)
  if (older.length === 0) return null
  return (
    <Collapsible title={`Previous runs (${older.length})`}>
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
    <Callout tone="accent" title="Commits not applied">
      <Stack gap="xs">
        {pending.projects.map((project) => (
          <Text key={project.projectId} size="sm">
            {`${project.name}: ${project.count} in ${project.upstream}${project.fetchOnly ? ' · fetch only' : ''}`}
          </Text>
        ))}
        <Text muted size="xs">
          {`Checked ${timeOf(pending.checkedAt, Date.now())}. ${pendingHint(pending.projects, 'panel')}`}
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
          label="Profile"
          value={current.activeProfileId}
          options={options}
          onChange={(value) => {
            set(profileName, null)
            void selectProfile(value)
          }}
        />
      </Box>
      <IconButton icon="add" label="New profile" variant="ghost" onPress={() => void createProfile(current)} />
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
          <Callout tone="danger" title="Could not load the projects">
            {error}
          </Callout>
        ) : (
          <Spinner label="Loading projects" />
        )}
      </Stack>
    )
  }

  const selectedCount = current.projects.filter((project) => project.selected).length
  const withCommands = current.projects.filter(
    (project) => project.selected && (current.commands[project.id]?.length ?? 0) > 0
  ).length
  const live = read(progress)
  const busy = current.running || current.checking || current.wrapping || live !== null

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Monstruito</Heading>
        <Badge tone={selectedCount > 0 ? 'accent' : 'neutral'}>{`${selectedCount} selected`}</Badge>
      </Row>
      <ProfileBar current={current} />
      <Text muted size="sm">
        {describePlan(current.settings, selectedCount, withCommands)}
      </Text>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {current.askStartup ? <StartupQuestion /> : null}
      <Row gap="xs" align="center" wrap>
        <Button icon="play" disabled={busy || selectedCount === 0} onPress={runNow}>
          Run now
        </Button>
        <Button icon="download" variant="outline" disabled={busy || selectedCount === 0} onPress={checkNow}>
          Check commits
        </Button>
        <Button
          icon="flag"
          variant="outline"
          disabled={busy || selectedCount === 0}
          tooltip="Asks each agent for a note for tomorrow, reports uncommitted and unpushed work, and closes agents and tabs"
          onPress={wrapNow}
        >
          Wrap up
        </Button>
        {busy ? (
          <Button icon="stop" variant="ghost" tone="danger" disabled={live?.stopping === true} onPress={stopNow}>
            Stop
          </Button>
        ) : null}
        {!busy && current.openedTerminals > 0 ? (
          <Button
            icon="close"
            variant="ghost"
            tooltip="Closes the command tabs Monstruito opened"
            onPress={closeTerminals}
          >
            {`Close tabs (${current.openedTerminals})`}
          </Button>
        ) : null}
      </Row>
      {live ? <ProgressView value={live} /> : null}
      {current.pending ? <PendingView pending={current.pending} /> : null}
      {current.lastRun ? (
        <LastRun
          run={current.lastRun}
          now={{ behindNow: current.behindNow ?? {}, ready: current.ready ?? {}, proposed: current.proposed ?? {} }}
        />
      ) : null}
      {current.lastWrap && current.lastWrap.finishedAt > (current.lastRun?.finishedAt ?? 0) ? (
        <LastWrap record={current.lastWrap} />
      ) : null}
      <HistoryView history={current.history} />
      <Separator />
      <Row gap="xs" align="center">
        <Box grow>
          <Input
            type="search"
            label="Search projects"
            labelHidden
            placeholder="Search projects"
            value={read(query)}
            onChange={(value) => {
              set(query, value)
              // Buscar es volver a la lista de proyectos.
              if (value.trim()) set(settingsOpen, false)
            }}
          />
        </Box>
        <IconButton icon="refresh" label="Reload projects" variant="ghost" onPress={reload} />
        <IconButton
          icon="settings"
          label="Settings"
          variant={read(settingsOpen) ? 'solid' : 'ghost'}
          tone={read(settingsOpen) ? 'accent' : 'neutral'}
          onPress={() => update(settingsOpen, (open) => !open)}
        />
      </Row>
      {read(settingsOpen) ? <SettingsView current={current} /> : <ProjectTreeView current={current} />}
    </Stack>
  )
}
