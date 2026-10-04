// env.mjs: numbers from the environment, and the hub's limits made configurable in one place.

/** A non-negative number from env[name], or `fallback` when unset or not a number. */
export function envNumber(env, name, fallback) {
  const v = env[name]
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const snake = key => key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()

/** Every key of `defaults` can be overridden by HUB_LIMIT_<KEY_IN_SNAKE_CASE>: envelopesPerSecond -> HUB_LIMIT_ENVELOPES_PER_SECOND. */
export const limitsFromEnv = (defaults, env = process.env) =>
  Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, envNumber(env, `HUB_LIMIT_${snake(k)}`, v)]))
