// Starts the hub binary with HUB_PORT=0: the hub binds a port the system picks and announces it on its first line of
// stdout ({"event":"port","port":N}). Probing a free port here and handing it to the hub would race other tests' hubs
// for it. `env` is the hub's whole environment (HUB_PORT is set here); without HUB_URL the hub takes
// http://127.0.0.1:<port> as its address. Resolves once the port is known; the caller waits for /healthz.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export async function spawnHub(bin, env) {
  const child = spawn(bin, [], { env: { ...env, HUB_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const lines = createInterface({ input: child.stdout })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the hub announced no port: ${stderr.slice(0, 500)}`)), 60_000)
    lines.once('line', line => {
      clearTimeout(timer)
      try {
        const { event, port } = JSON.parse(line)
        if (event === 'port' && port > 0) resolve(port)
        else reject(new Error(`the hub's first line is not its port: ${line}`))
      } catch { reject(new Error(`the hub's first line is not its port: ${line}`)) }
    })
    lines.once('close', () => { clearTimeout(timer); reject(new Error(`the hub exited before it announced its port: ${stderr.slice(0, 500)}`)) })
  })
  // the rest of stdout is read and dropped, so that the hub never writes into a full pipe
  lines.on('line', () => {})
  return { child, port, url: `http://127.0.0.1:${port}`, stderr: () => stderr, exited }
}
