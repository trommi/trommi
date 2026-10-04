// One yellow note: <div class="memo" data-controller="memo"> (server/views/memo.mjs memoNote()). It is a form that
// works by itself; this adds Enter, keeping what is typed, carrying it by its strip, pictures and files,
// and the tear-off. The work is /t/lib/memo.js, shared with the round button (memos_controller.js).
import { Controller } from '/js/app/stimulus.mjs'
import { stand, fit, front, typed, send, carry, picker, unclip, attach, settle } from '/t/lib/memo.js'

export default class extends Controller {
  connect() {
    stand(this.element); fit(this.element)
    // More than five attachments lie folded as one chip (css/quicksend.css): a click on it opens or shuts the list.
    this.element.addEventListener('click', e => {
      const files = e.target.closest?.('.memo-files')
      if (files && e.target === files && files.querySelector('.memo-file:nth-child(6)')) files.toggleAttribute('data-open')
    })
  }

  typed() { typed(this.element) }
  key(e) {
    // Enter tears it off and sends it, Shift+Enter makes a new line. (Escape puts the note away: memos_controller.js.)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); send(this.element) }
  }
  send(e) { e.preventDefault(); send(this.element) }
  front() { front(this.element) }
  carry(e) { if (!e.target.closest('button, a')) carry(e, this.element, e.currentTarget) }
  pick(e) { e.preventDefault(); picker(this.element).click() }
  unclip(e) { e.preventDefault(); unclip(this.element, e.currentTarget) }
  settle() { settle(this.element) }
  paste(e) { if (e.clipboardData?.files?.length) { e.preventDefault(); attach(this.element, e.clipboardData.files) } }
  over(e) { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); this.slip.classList.add('is-drop') } }
  out() { this.slip.classList.remove('is-drop') }
  drop(e) { this.out(); if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(this.element, e.dataTransfer.files) } }
  get slip() { return this.element.querySelector('.memo-slip') }
}
