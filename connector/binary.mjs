// binary.mjs: what the connector's tests share: the binary under test, and prompt.md read as the connector reads it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RELEASE_BINARY = path.join(REPO, 'connector-rs/target/release/trommi-connector')

/**
 * The connector the tests run: TROMMI_CONNECTOR_CMD, or connector-rs's release binary, built (or brought up to date:
 * cargo's no-op takes a moment) first. Cargo: CARGO, ~/.cargo/bin/cargo, or cargo on PATH; without one an existing
 * binary is taken as it is.
 */
export function connectorCmd() {
  if (process.env.TROMMI_CONNECTOR_CMD) return process.env.TROMMI_CONNECTOR_CMD
  if (connectorCmd.done) return RELEASE_BINARY
  const home = path.join(os.homedir(), '.cargo/bin/cargo')
  const cargo = process.env.CARGO || (fs.existsSync(home) ? home : 'cargo')
  try {
    execFileSync(cargo, ['build', '--release', '--quiet'], { cwd: path.join(REPO, 'connector-rs'), stdio: ['ignore', 'inherit', 'inherit'] })
  } catch (err) {
    if (err.code !== 'ENOENT' || !fs.existsSync(RELEASE_BINARY)) throw new Error(`the connector could not be built (cargo build --release in connector-rs): ${err.message}`)
  }
  connectorCmd.done = true
  return RELEASE_BINARY
}

/** prompt.md as { '# Heading' | '## tool': text }: a section's lines and paragraphs read as one paragraph. */
export function parsePrompt(md) {
  const out = {}
  let at = null
  for (const line of String(md).split(/\r?\n/)) {
    const h = /^(##?) +(.+?)\s*$/.exec(line)
    if (h) { at = `${h[1]} ${h[2]}`; out[at] = '' } else if (at) out[at] += ` ${line}`
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/\s+/g, ' ').trim()
  return out
}
