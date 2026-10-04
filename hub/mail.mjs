// mail.mjs: how the hub sends mail (today: only the code that confirms an account's email). One interface,
// send({ to, subject, text }) -> Promise, and a transport chosen by HUB_MAIL_TRANSPORT:
//   log      (default) one line in the hub log with the recipient and the text (the code is readable there: dev only)
//   outbox   each mail as a JSON file in HUB_MAIL_OUTBOX (tests and e2e read the code from there)
//   off      nothing is sent
// TODO(mail provider): a real transport (SMTP or an HTTP mail API) before launch; until then codes reach nobody
// outside the hub log, and accounts whose email is not confirmed within 24 h are released (hub/accounts.mjs).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function createMailer({ env = process.env, log = () => {} } = {}) {
  const transport = env.HUB_MAIL_TRANSPORT || (env.HUB_MAIL_OUTBOX ? 'outbox' : 'log')
  const outbox = env.HUB_MAIL_OUTBOX
  if (transport === 'outbox' && !outbox) throw new Error('HUB_MAIL_TRANSPORT=outbox needs HUB_MAIL_OUTBOX')
  if (outbox) fs.mkdirSync(outbox, { recursive: true })
  return {
    transport,
    async send({ to, subject, text }) {
      if (transport === 'off') return
      if (transport === 'outbox') {
        const file = path.join(outbox, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`)
        fs.writeFileSync(file, JSON.stringify({ to, subject, text, at: Date.now() }), { mode: 0o600 })
        return
      }
      log(`mail (log transport) to ${to}: ${subject} | ${text.replace(/\s+/g, ' ')}`)
    },
  }
}
