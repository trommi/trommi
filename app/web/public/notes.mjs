// ---- note ----
// The note: the one yellow note the human writes to the crowned session (the corner note, sidebar.mjs cornerNote and
// its controller). The notes are the app core's (vm.notes): what is written, sent (held for the core's Undo toast) or
// thrown away goes to it as an action. Here are the note's routes, posted by the corner note's controller:
//
//   POST /notes                    { text, files? }  a new note (WriteNote without an id)
//   POST /notes/<id>/keep          { text, files? }  the words as they stand (WriteNote)
//   POST /notes/<id>/bin           DeleteNote
//   POST /notes/<id>/send          { to? }           SendNote (none: the crown's); the core holds it and toasts its Undo
//   POST /notes/<id>/unsend        UnsendNote
// `files`: the local ids of files attached on this page (t.attach), comma-separated.

const field = (form, json, k) => (json ? json[k] : form?.get(k)) ?? null

export function register(t) {
  t.post(/^\/notes(?:\/([\w-]+)\/(keep|bin|send|unsend))?$/, ({ res, match, form, json }) => {
    const note_id = match[1] ?? null, what = match[2] ?? 'create'
    const text = String(field(form, json, 'text') ?? ''), files = String(field(form, json, 'files') ?? '').split(',').filter(Boolean)
    // (attachments: the core's WriteNote takes none yet; sent along for when it does)
    if (what === 'create' || what === 'keep') t.act({ do: 'write_note', ...(note_id ? { note_id } : {}), text, ...(files.length ? { attachments: files } : {}) })
    else if (what === 'bin') t.act({ do: 'delete_note', note_id })
    else if (what === 'send') { const to = field(form, json, 'to'); t.act({ do: 'send_note', note_id, ...(to ? { to: String(to) } : {}) }) }
    else t.act({ do: 'unsend_note', note_id })
    t.done(res)
  })
}
