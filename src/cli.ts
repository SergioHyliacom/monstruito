// Lo que la API de plugins no da y la CLI de Orca sí: abrir un agente con modelo
// (`orca agent launch --model … --effort …`), ver los puertos de un workspace (`orca ports`) y abrir
// una dirección en el navegador de Orca (`orca tab create`).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ModelLaunch = {
  /** Carpeta del workspace donde abrirlo. */
  path: string
  agent: string
  model: string
  effort?: string
  prompt?: string
}

export type ModelLauncher = (launch: ModelLaunch) => Promise<void>

export function buildLaunchArgs(launch: ModelLaunch): string[] {
  const args = ['agent', 'launch', '--agent', launch.agent, '--worktree', `path:${launch.path}`, '--model', launch.model]
  if (launch.effort) args.push('--effort', launch.effort)
  if (launch.prompt) args.push('--prompt', launch.prompt)
  // En una pestaña de terminal, como `agent.launch`, para que se vea igual y se detecte igual.
  args.push('--surface', 'terminal', '--json')
  return args
}

/**
 * La CLI de Orca que viene con esta instalación. El worker corre con el propio ejecutable de
 * Orca, así que la CLI está junto a él: `resources/bin/orca` (o `Resources/bin` en macOS).
 */
export function findOrcaCli(execPath: string, env: Record<string, string | undefined>, exists = existsSync): string | null {
  const fromEnv = env.ORCA_CLI_COMMAND
  if (fromEnv && exists(fromEnv)) return fromEnv
  const name = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const base = dirname(execPath)
  const candidates = [join(base, 'resources', 'bin', name), join(base, '..', 'Resources', 'bin', name)]
  return candidates.find((candidate) => exists(candidate)) ?? null
}

/** Lo que la CLI explica cuando falla: su `error.message` en JSON, o la salida tal cual. */
export function explainCliFailure(stdout: string, stderr: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: { message?: string } }
    if (parsed?.error?.message) return parsed.error.message.split('\n')[0]
  } catch {
    // No era JSON.
  }
  const text = (stderr || stdout).trim().split(/\r?\n/)[0]
  return text || fallback
}

/** Ejecuta la CLI de Orca con `--json` y resuelve con su `result`, o falla con su mensaje. */
export type OrcaCli = (args: string[], timeoutMs?: number) => Promise<unknown>

export function createOrcaCli(execPath = process.execPath): OrcaCli {
  return (args, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const cli = findOrcaCli(execPath, process.env)
      if (!cli) {
        reject(new Error('No encuentro la CLI de Orca.'))
        return
      }
      execFile(cli, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        let parsed: { ok?: boolean; result?: unknown } | null = null
        try {
          parsed = JSON.parse(out)
        } catch {
          // Sin JSON: manda el código de salida.
        }
        if (!error && parsed?.ok !== false) resolve(parsed?.result ?? null)
        else reject(new Error(explainCliFailure(out, String(stderr ?? ''), error?.message ?? 'la CLI de Orca falló')))
      })
    })
}

export function createModelLauncher(cli: OrcaCli): ModelLauncher {
  return async (launch) => {
    await cli(buildLaunchArgs(launch))
  }
}

export type Port = { port: number; url?: string }

/** Ver los puertos de un workspace y abrir una dirección en el navegador de Orca. */
export type WebOpener = {
  ports: (path: string) => Promise<Port[]>
  open: (path: string, url: string) => Promise<void>
}

export function parsePorts(result: unknown): Port[] {
  const ports = (result as { ports?: unknown } | null)?.ports
  if (!Array.isArray(ports)) return []
  return ports.flatMap((item): Port[] => {
    const port = Number((item as { port?: unknown })?.port)
    if (!Number.isInteger(port) || port <= 0) return []
    const url = (item as { advertisedUrl?: unknown }).advertisedUrl
    return [typeof url === 'string' && /^https?:\/\//.test(url) ? { port, url } : { port }]
  })
}

export function createWebOpener(cli: OrcaCli): WebOpener {
  return {
    ports: async (path) => parsePorts(await cli(['ports', '--worktree', `path:${path}`, '--json'])),
    // Sin --focus: la pestaña se abre por detrás, sin moverte de donde estás.
    open: async (path, url) => {
      await cli(['tab', 'create', '--url', url, '--worktree', `path:${path}`, '--json'])
    }
  }
}

/**
 * Espera a que aparezca un puerto que no estaba en `before` y abre su dirección (la que imprimió
 * el servidor, o http://localhost:puerto). Devuelve la dirección.
 */
export async function waitForWeb(
  web: WebOpener,
  path: string,
  before: Set<number>,
  options: { signal?: AbortSignal; sleep: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number }
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 2000
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    if (options.signal?.aborted) throw new Error('detenido')
    const fresh = (await web.ports(path).catch(() => [])).find((item) => !before.has(item.port))
    if (fresh) {
      const url = fresh.url ?? `http://localhost:${fresh.port}`
      await web.open(path, url)
      return url
    }
    await options.sleep(intervalMs)
  }
  throw new Error(`No escuchó en ningún puerto nuevo en ${Math.round(timeoutMs / 1000)} s.`)
}
