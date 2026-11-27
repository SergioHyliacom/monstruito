import path from 'node:path'
import { assert, test } from 'orca/testing'
import type { GitRunner } from './git'
import {
  excludeNotes,
  nextItem,
  notePath,
  openRequests,
  readNextNote,
  readProposedCommands,
  readReady,
  type NoteFiles
} from './notes'

function memoryFiles(initial: Record<string, { text: string; mtime?: number }> = {}) {
  const files = new Map(Object.entries(initial).map(([file, value]) => [file, { text: value.text, mtime: value.mtime ?? 100 }]))
  const notes: NoteFiles = {
    read: async (file) => files.get(file)?.text ?? null,
    mtime: async (file) => files.get(file)?.mtime ?? null,
    append: async (file, text) => {
      files.set(file, { text: (files.get(file)?.text ?? '') + text, mtime: 200 })
    }
  }
  return { notes, files }
}

test('la línea «Next:» se encuentra con o sin adornos de Markdown', () => {
  assert.equal(nextItem('Updated deps.\nNext: the mobile header'), 'the mobile header')
  assert.equal(nextItem('## Summary\n- **Next:** review the PR'), 'review the PR')
  assert.equal(nextItem('**Next item:** pricing page**'), 'pricing page')
  assert.equal(nextItem('next - nothing here'), null)
  assert.equal(nextItem('Nothing to say'), null)
})

test('el resumen del brief solo cuenta si se escribió después de mandarlo', async () => {
  const file = notePath('/web', '.monstruito/ready.md')
  const { notes } = memoryFiles({ [file]: { text: '# Done\nNext: pricing', mtime: 500 } })
  assert.deepEqual(await readReady(notes, '/web', 400), { at: 500, next: 'pricing', text: '# Done\nNext: pricing' })
  assert.equal(await readReady(notes, '/web', 600), null, 'uno de ayer no vale')
  assert.equal(await readReady(notes, '/otro', 0), null)
})

test('la nota de ayer se lee recortada', async () => {
  const { notes } = memoryFiles({ [notePath('/web', '.monstruito/next.md')]: { text: `  ${'a'.repeat(2000)}  ` } })
  const note = await readNextNote(notes, '/web')
  assert.equal(note?.length, 1200)
  assert.equal(await readNextNote(memoryFiles().notes, '/web'), null)
})

test('de los comandos que propone el agente solo valen los de una línea, sin repetir', async () => {
  const file = notePath('/web', '.monstruito/commands.json')
  const { notes } = memoryFiles({
    [file]: {
      text: JSON.stringify([
        { name: 'dev', command: 'npm run dev', kind: 'tab' },
        { command: 'npm run db:migrate' },
        { name: 'again', command: 'npm run dev', kind: 'tab' },
        { command: 'echo a\nrm -rf /' },
        { name: 'x' },
        'nope'
      ])
    }
  })
  assert.deepEqual(await readProposedCommands(notes, '/web'), [
    { name: 'dev', command: 'npm run dev', kind: 'tab', source: 'Claude' },
    { name: '', command: 'npm run db:migrate', kind: 'prepare', source: 'Claude' }
  ])
  const wrapped = memoryFiles({ [file]: { text: '{"commands":[{"command":"make"}]}' } })
  assert.equal((await readProposedCommands(wrapped.notes, '/web')).length, 1)
  const broken = memoryFiles({ [file]: { text: '{oops' } })
  assert.deepEqual(await readProposedCommands(broken.notes, '/web'), [])
})

test('de Requests sale lo abierto del proyecto, primero lo que espera por ti', async () => {
  const { notes } = memoryFiles({
    'requests.json': {
      text: JSON.stringify({
        version: 2,
        threads: [
          { id: 't1', topic: 'Pricing', project: 'Web' },
          { id: 't2', topic: 'Other', project: 'api' }
        ],
        items: [
          { id: 'a', thread: 't1', title: 'Queued thing', status: 'queue' },
          { id: 'b', thread: 't1', title: 'Done thing', status: 'done' },
          { id: 'c', thread: 't1', title: 'Needs you', status: 'need' },
          { id: 'd', thread: 't2', title: 'Other project', status: 'need' },
          { id: 'e', thread: 't1', title: 'Working', status: 'run' }
        ]
      })
    }
  })
  assert.deepEqual(await openRequests(notes, 'requests.json', 'web'), [
    { id: 'c', title: 'Needs you', status: 'need' },
    { id: 'e', title: 'Working', status: 'run' },
    { id: 'a', title: 'Queued thing', status: 'queue' }
  ])
  assert.deepEqual(await openRequests(notes, 'missing.json', 'web'), [])
})

test('la carpeta de notas se excluye de git en local, una sola vez', async () => {
  const git: GitRunner = async () => ({ ok: true, stdout: '.git/info/exclude\n', stderr: '' })
  const exclude = path.resolve('/web', '.git/info/exclude')
  const { notes, files } = memoryFiles({ [exclude]: { text: '# git ls-files --others --exclude-from=.git/info/exclude' } })
  assert.equal(await excludeNotes(git, notes, '/web'), true)
  assert.equal(await excludeNotes(git, notes, '/web'), true)
  const text = files.get(exclude)?.text ?? ''
  assert.equal(text.split('/.monstruito/').length - 1, 1)
  assert.ok(text.includes('\n# Monstruito'), 'en su propia línea')

  const notGit: GitRunner = async () => ({ ok: false, stdout: '', stderr: 'fatal: not a git repository' })
  assert.equal(await excludeNotes(notGit, notes, '/web'), false)
})
