import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { buildLaunchArgs, explainCliFailure, findOrcaCli, parsePorts, waitForWeb, type Port } from './cli'

test('lee los puertos de orca ports', () => {
  assert.deepEqual(
    parsePorts({
      ports: [
        { port: 4321, advertisedUrl: 'http://localhost:4321/', kind: 'workspace' },
        { port: '5173' },
        { port: 'no' },
        { port: 8080, advertisedUrl: 'javascript:alert(1)' }
      ]
    }),
    [{ port: 4321, url: 'http://localhost:4321/' }, { port: 5173 }, { port: 8080 }]
  )
  assert.deepEqual(parsePorts(null), [])
})

test('espera a un puerto nuevo y abre su dirección', async () => {
  const scans: Port[][] = [[{ port: 3000 }], [{ port: 3000 }, { port: 5173 }]]
  const opened: string[] = []
  const web = {
    ports: async () => scans.shift() ?? [],
    open: async (_path: string, url: string) => {
      opened.push(url)
    }
  }
  const url = await waitForWeb(web, 'D:/P/web', new Set([3000]), { sleep: async () => undefined })
  assert.equal(url, 'http://localhost:5173')
  assert.deepEqual(opened, ['http://localhost:5173'])
})

test('si no aparece ningún puerto nuevo, se rinde', async () => {
  const web = { ports: async () => [{ port: 3000 }], open: async () => undefined }
  await assert.rejects(
    waitForWeb(web, 'D:/P/web', new Set([3000]), { sleep: async () => undefined, timeoutMs: 6000, intervalMs: 2000 }),
    /did not listen on any new port within 6 s/
  )
})

test('los argumentos de orca agent launch', () => {
  assert.deepEqual(buildLaunchArgs({ path: 'D:/P/web', agent: 'claude', model: 'opus' }), [
    'agent', 'launch', '--agent', 'claude', '--worktree', 'path:D:/P/web', '--model', 'opus', '--surface', 'terminal', '--json'
  ])
  assert.deepEqual(
    buildLaunchArgs({ path: 'D:/P/web', agent: 'codex', model: 'gpt-6-astra', effort: 'high', prompt: 'Hola; adiós' }),
    [
      'agent', 'launch', '--agent', 'codex', '--worktree', 'path:D:/P/web', '--model', 'gpt-6-astra',
      '--effort', 'high', '--prompt', 'Hola; adiós', '--surface', 'terminal', '--json'
    ]
  )
})

test('encuentra la CLI junto al ejecutable de Orca', () => {
  const exe = join('C:', 'Programs', 'orca', 'Orca.exe')
  const name = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const cli = join('C:', 'Programs', 'orca', 'resources', 'bin', name)
  assert.equal(findOrcaCli(exe, {}, (path) => path === cli), cli)
  assert.equal(findOrcaCli(exe, { ORCA_CLI_COMMAND: '/x/orca' }, (path) => path === '/x/orca'), '/x/orca')
  assert.equal(findOrcaCli(exe, {}, () => false), null)
})

test('explica los fallos de la CLI', () => {
  assert.equal(
    explainCliFailure('{"ok":false,"error":{"code":"invalid_argument","message":"Unknown model\\nmore"}}', '', 'x'),
    'Unknown model'
  )
  assert.equal(explainCliFailure('', 'boom\nstack', 'x'), 'boom')
  assert.equal(explainCliFailure('', '', 'x'), 'x')
})
