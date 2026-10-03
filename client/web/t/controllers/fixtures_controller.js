// The Dev menu's "Create test cards" and "Remove test cards" (server/fixtures.mjs). The form posts with Turbo; the hub
// answers with the toast and puts this browser on the test desk (or back on the main desk). Once it went through, the
// Desk is opened, so the cards are in sight.
//   <form method="post" action="/dev/fixtures" data-controller="fixtures" data-fixtures-desk-value="/"
//         data-action="turbo:submit-end->fixtures#open">
import { Controller } from '@hotwired/stimulus'
import { visit } from '@hotwired/turbo'

export default class extends Controller {
  static values = { desk: String }

  open(event) {
    if (!event.detail?.success) return
    visit(this.deskValue || '/', { action: 'advance' })
  }
}
