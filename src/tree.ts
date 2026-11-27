// El árbol de carpetas del panel, a partir de las rutas de los proyectos. Sin dependencias de
// Node: lo usa el panel.
import type { ProjectRow } from './protocol'

export type ProjectLeaf = {
  kind: 'project'
  key: string
  project: ProjectRow
  lastUsedAt: number | null
}

export type FolderNode = {
  kind: 'folder'
  key: string
  /** Lo que se ve: el nombre de la carpeta, o varias unidas (`Discord/bot`) si solo había un camino. */
  name: string
  path: string
  /** Proyectos que están en esta misma carpeta (una carpeta puede ser proyecto y contener otros). */
  projects: ProjectRow[]
  children: TreeNode[]
  /** La actividad más reciente de todo lo que contiene. */
  lastUsedAt: number | null
  total: number
  selected: number
}

export type TreeNode = ProjectLeaf | FolderNode

/** `base` es la parte de la ruta que comparten todos los proyectos y no se repite en el árbol. */
export type ProjectTree = { base: string; nodes: TreeNode[] }

type Raw = { name: string; path: string; children: Map<string, Raw>; projects: ProjectRow[] }

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function newer(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

function nameOf(node: TreeNode): string {
  return node.kind === 'project' ? node.project.name : node.name
}

/** De más reciente a más antiguo; lo que nunca se usó va al final, por nombre. */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.lastUsedAt !== b.lastUsedAt) {
    if (a.lastUsedAt === null) return 1
    if (b.lastUsedAt === null) return -1
    return b.lastUsedAt - a.lastUsedAt
  }
  return nameOf(a).localeCompare(nameOf(b), 'es', { sensitivity: 'base' })
}

function compareProjects(a: ProjectRow, b: ProjectRow): number {
  return compareNodes(
    { kind: 'project', key: a.id, project: a, lastUsedAt: a.lastUsedAt },
    { kind: 'project', key: b.id, project: b, lastUsedAt: b.lastUsedAt }
  )
}

function leaf(project: ProjectRow): ProjectLeaf {
  return { kind: 'project', key: project.id, project, lastUsedAt: project.lastUsedAt }
}

function convert(raw: Raw): TreeNode[] {
  if (raw.children.size === 0) return raw.projects.map(leaf)

  const children = [...raw.children.values()].flatMap(convert)
  // Una carpeta que solo lleva a un sitio no aporta nada: se junta con lo que contiene.
  if (raw.projects.length === 0 && children.length === 1) {
    const only = children[0]
    return only.kind === 'project' ? [only] : [{ ...only, name: `${raw.name}/${only.name}` }]
  }

  children.sort(compareNodes)
  const projects = [...raw.projects].sort(compareProjects)
  let lastUsedAt: number | null = null
  let total = projects.length
  let selected = projects.filter((project) => project.selected).length
  for (const project of projects) lastUsedAt = newer(lastUsedAt, project.lastUsedAt)
  for (const child of children) {
    lastUsedAt = newer(lastUsedAt, child.lastUsedAt)
    total += child.kind === 'project' ? 1 : child.total
    selected += child.kind === 'project' ? (child.project.selected ? 1 : 0) : child.selected
  }
  return [
    {
      kind: 'folder',
      key: `dir:${raw.path.toLowerCase()}`,
      name: raw.name,
      path: raw.path,
      projects,
      children,
      lastUsedAt,
      total,
      selected
    }
  ]
}

export function buildTree(projects: readonly ProjectRow[]): ProjectTree {
  const root: Raw = { name: '', path: '', children: new Map(), projects: [] }
  for (const project of projects) {
    let node = root
    for (const segment of segments(project.path)) {
      const id = segment.toLowerCase()
      let child = node.children.get(id)
      if (!child) {
        child = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          children: new Map(),
          projects: []
        }
        node.children.set(id, child)
      }
      node = child
    }
    node.projects.push(project)
  }

  // La raíz común (por ejemplo D:/Escritorio) no se repite en cada rama.
  let base = root
  while (base.projects.length === 0 && base.children.size === 1) {
    const [only] = base.children.values()
    if (only.children.size === 0) break
    base = only
  }

  const nodes = [...base.children.values()].flatMap(convert)
  nodes.push(...base.projects.map(leaf))
  return { base: base.path, nodes: nodes.sort(compareNodes) }
}

/** Si el proyecto coincide con la búsqueda, por nombre o por ruta. Sin búsqueda, todos. */
export function matchesQuery(project: ProjectRow, query: string): boolean {
  const text = query.trim().toLowerCase()
  return !text || project.name.toLowerCase().includes(text) || project.path.toLowerCase().includes(text)
}

/** De más reciente a más antiguo; lo nunca usado al final, por nombre. */
export function sortByRecency(projects: readonly ProjectRow[]): ProjectRow[] {
  return [...projects].sort(compareProjects)
}

/** La carpeta del proyecto sin la raíz común: `Proyectos/Claude` para `D:/Escritorio/Proyectos/Claude/x`. */
export function folderOf(path: string, base: string): string {
  const parts = segments(path).slice(0, -1)
  const baseParts = segments(base)
  const sameRoot = baseParts.every((part, index) => parts[index]?.toLowerCase() === part.toLowerCase())
  return (sameRoot ? parts.slice(baseParts.length) : parts).join('/')
}

/** Solo los proyectos que coinciden, con sus carpetas; una carpeta que coincide va entera. */
export function filterTree(nodes: readonly TreeNode[], query: string): TreeNode[] {
  const text = query.trim().toLowerCase()
  if (!text) return [...nodes]
  const matches = (project: ProjectRow) => matchesQuery(project, query)
  return nodes.flatMap((node): TreeNode[] => {
    if (node.kind === 'project') return matches(node.project) ? [node] : []
    if (node.name.toLowerCase().includes(text)) return [node]
    const projects = node.projects.filter(matches)
    const children = filterTree(node.children, query)
    return projects.length > 0 || children.length > 0 ? [{ ...node, projects, children }] : []
  })
}

/**
 * Las carpetas abiertas la primera vez: el camino hasta el proyecto usado más recientemente y
 * las que contienen proyectos marcados.
 */
export function defaultExpanded(nodes: readonly TreeNode[]): string[] {
  const open = new Set<string>()
  let level: readonly TreeNode[] = nodes
  while (level[0]?.kind === 'folder') {
    open.add(level[0].key)
    level = level[0].children
  }
  const walk = (node: TreeNode): boolean => {
    if (node.kind === 'project') return node.project.selected
    const own = node.projects.some((project) => project.selected)
    const inside = node.children.map(walk).some(Boolean)
    if (own || inside) open.add(node.key)
    return own || inside
  }
  nodes.forEach(walk)
  return [...open]
}

const DAY = 24 * 60 * 60 * 1000

/** "hoy", "ayer", "hace 3 días"… para la última actividad. */
export function usedAgo(at: number, now: number): string {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (at >= startOfToday.getTime()) return 'today'
  const days = Math.max(1, Math.ceil((startOfToday.getTime() - at) / DAY))
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 30) {
    const weeks = Math.floor(days / 7)
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
  }
  if (days < 365) {
    const months = Math.floor(days / 30)
    return months === 1 ? '1 month ago' : `${months} months ago`
  }
  const years = Math.floor(days / 365)
  return years === 1 ? '1 year ago' : `${years} years ago`
}
