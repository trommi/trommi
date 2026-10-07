// attachments.mjs: encrypted attachment bytes as files, HUB_DATA/attachments/<room_id>/<attachment_id>.
// Four methods (put, get with a range, size, delete), so the store can move to object storage later.
// The hub never sees inside: the bytes are encryptAsset's STREAM chunks.
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

const HEX = /^[0-9a-f]+$/
const fileOf = (dir, roomId, id) => {
  if (!HEX.test(roomId) || !HEX.test(id)) throw new Error('bad id')
  return path.join(dir, roomId, id)
}

export function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return {
    /**
     * Write once from a readable stream; refuses more than `maxBytes` (throws { code: 'too-large' }) and an
     * existing file (throws { code: 'replay' }). Resolves with the size written.
     */
    async put(roomId, id, readable, maxBytes) {
      const file = fileOf(dir, roomId, id)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (fs.existsSync(file)) throw Object.assign(new Error('this attachment is already stored'), { code: 'replay' })
      const tmp = `${file}.part-${process.pid}-${Math.random().toString(36).slice(2)}`
      let size = 0
      const count = new Transform({
        transform(chunk, _enc, done) {
          size += chunk.length
          if (size > maxBytes) done(Object.assign(new Error(`an attachment is at most ${maxBytes} bytes`), { code: 'too-large' }))
          else done(null, chunk)
        },
      })
      try {
        await pipeline(readable, count, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }))
        fs.linkSync(tmp, file)     // fails if someone else stored it meanwhile
      } catch (err) {
        if (err.code === 'EEXIST') throw Object.assign(new Error('this attachment is already stored'), { code: 'replay' })
        throw err
      } finally {
        fs.rmSync(tmp, { force: true })
      }
      return size
    },
    /** A readable stream of bytes start..end (inclusive), or of the whole file. */
    get: (roomId, id, { start, end } = {}) => fs.createReadStream(fileOf(dir, roomId, id), { start, end }),
    /**
     * Open for serving: { size, read({ start, end }) -> readable that owns the file and closes it, close() } or null
     * if there is no such file. Opened before the answer starts, so a file deleted or unreadable in between is a 404
     * or a refusal, never an 'error' event nobody listens to. Call read() once, or close().
     */
    open(roomId, id) {
      let fd
      try { fd = fs.openSync(fileOf(dir, roomId, id), 'r') } catch (err) { if (err.code === 'ENOENT') return null; throw err }
      try {
        const size = fs.fstatSync(fd).size
        return { size, read: ({ start, end } = {}) => fs.createReadStream(null, { fd, start, end, autoClose: true }), close: () => fs.closeSync(fd) }
      } catch (err) { fs.closeSync(fd); throw err }
    },
    /** Size in bytes, or null if there is no such attachment. */
    size(roomId, id) {
      try { return fs.statSync(fileOf(dir, roomId, id)).size } catch { return null }
    },
    delete(roomId, id) { fs.rmSync(fileOf(dir, roomId, id), { force: true }) },
  }
}
