import { assert, test } from 'orca/testing'
import type { ProjectRow } from './protocol'
import { buildTree, defaultExpanded, filterTree, folderOf, usedAgo, type TreeNode } from './tree'

const NOW = new Date(2026, 10, 26, 15, 0).getTime()
const HOURS = 60 * 60 * 1000

function project(path: string, lastUsedAt: number | null = null, selected = false): ProjectRow {
  const name = path.split(/[\\/]/).pop() ?? path
  return { id: `id:${path}`, name, path, selected, customized: false, lastUsedAt }
}

/** Una vista compacta del árbol: carpetas con `/` final y su contenido. */
function outline(nodes: readonly TreeNode[]): unknown[] {
  return nodes.map((node) =>
    node.kind === 'project'
      ? node.project.name
      : { [`${node.name}/`]: [...node.projects.map((p) => `(${p.name})`), ...outline(node.children)] }
  )
}

test('agrupa por carpetas, quita la raíz común y junta los caminos de un solo hijo', () => {
  const tree = buildTree([
    project('D:/Trabajo/Proyectos/Astro/blog'),
    project('D:/Trabajo/Proyectos/Astro/portfolio'),
    project('D:/Trabajo/Proyectos/Discord/servidor/bot'),
    project('D:/Trabajo/Proyectos/Flutter/agenda app/agenda_app'),
    project('D:/Trabajo/Proyectos/Flutter/forge'),
    project('D:/Trabajo/Empresa/Repositorios/Apps/app-tpv'),
    project('D:/Trabajo/Empresa/Repositorios/Apps/app-citas'),
    project('D:\\Trabajo\\apuntes')
  ])
  assert.equal(tree.base, 'D:/Trabajo')
  // Sin fechas de uso, por nombre.
  assert.deepEqual(outline(tree.nodes), [
    'apuntes',
    {
      'Empresa/Repositorios/Apps/': ['app-citas', 'app-tpv']
    },
    {
      'Proyectos/': [
        { 'Astro/': ['blog', 'portfolio'] },
        'bot',
        { 'Flutter/': ['agenda_app', 'forge'] }
      ]
    }
  ])
})

test('una carpeta que es proyecto y contiene otros los muestra a ambos', () => {
  const tree = buildTree([
    project('D:/P/pruebas', NOW - 2 * HOURS),
    project('D:/P/pruebas/equipo-frontend', NOW - 1 * HOURS),
    project('D:/P/pruebas/equipo-backend'),
    project('D:/P/otro', NOW - 30 * HOURS)
  ])
  assert.deepEqual(outline(tree.nodes), [
    { 'pruebas/': ['(pruebas)', 'equipo-frontend', 'equipo-backend'] },
    'otro'
  ])
  const folder = tree.nodes[0]
  assert.equal(folder.kind, 'folder')
  if (folder.kind === 'folder') {
    assert.equal(folder.total, 3)
    assert.equal(folder.lastUsedAt, NOW - 1 * HOURS)
  }
})

test('ordena de más reciente a más antiguo y deja lo nunca usado al final', () => {
  const tree = buildTree([
    project('D:/P/viejo/a', NOW - 100 * HOURS),
    project('D:/P/viejo/b'),
    project('D:/P/nuevo/c', NOW - 1 * HOURS),
    project('D:/P/nuevo/d', NOW - 50 * HOURS),
    project('D:/P/zeta'),
    project('D:/P/alfa')
  ])
  assert.deepEqual(outline(tree.nodes), [
    { 'nuevo/': ['c', 'd'] },
    { 'viejo/': ['a', 'b'] },
    'alfa',
    'zeta'
  ])
})

test('abre el camino al proyecto más reciente y las carpetas con proyectos marcados', () => {
  const tree = buildTree([
    project('D:/P/nuevo/sub/c', NOW - 1 * HOURS),
    project('D:/P/nuevo/sub/d'),
    project('D:/P/nuevo/e'),
    project('D:/P/viejo/a', null, true),
    project('D:/P/viejo/b'),
    project('D:/P/otro/f'),
    project('D:/P/otro/g')
  ])
  assert.deepEqual(defaultExpanded(tree.nodes).sort(), [
    'dir:d:/p/nuevo',
    'dir:d:/p/nuevo/sub',
    'dir:d:/p/viejo'
  ])
})

test('al buscar deja solo lo que coincide con sus carpetas', () => {
  const tree = buildTree([
    project('D:/P/Astro/blog'),
    project('D:/P/Astro/portfolio'),
    project('D:/P/Flutter/forge'),
    project('D:/P/Flutter/gapscan')
  ])
  assert.deepEqual(outline(filterTree(tree.nodes, 'forge')), [{ 'Flutter/': ['forge'] }])
  assert.deepEqual(outline(filterTree(tree.nodes, 'astro')), [
    { 'Astro/': ['blog', 'portfolio'] }
  ])
  assert.deepEqual(filterTree(tree.nodes, 'nada-parecido'), [])
  assert.equal(filterTree(tree.nodes, '  ').length, 2)
})

test('la carpeta de un proyecto sin la raíz común', () => {
  assert.equal(folderOf('D:/Trabajo/Proyectos/Claude/orca-arranque', 'D:/Trabajo'), 'Proyectos/Claude')
  assert.equal(folderOf('D:\\Trabajo\\apuntes', 'D:/Trabajo'), '')
  assert.equal(folderOf('C:/otro/sitio/app', 'D:/Trabajo'), 'C:/otro/sitio')
})

test('dice cuándo se usó en palabras', () => {
  assert.equal(usedAgo(NOW - 1 * HOURS, NOW), 'hoy')
  assert.equal(usedAgo(NOW - 20 * HOURS, NOW), 'ayer')
  assert.equal(usedAgo(NOW - 3 * 24 * HOURS, NOW), 'hace 3 días')
  assert.equal(usedAgo(NOW - 9 * 24 * HOURS, NOW), 'hace 1 semana')
  assert.equal(usedAgo(NOW - 20 * 24 * HOURS, NOW), 'hace 2 semanas')
  assert.equal(usedAgo(NOW - 70 * 24 * HOURS, NOW), 'hace 2 meses')
  assert.equal(usedAgo(NOW - 400 * 24 * HOURS, NOW), 'hace 1 año')
})
