// DeskGoals.swift: the desk's goals under the Desk's greeting (app/web/public/desk.mjs deskGoals, controller "goals"):
// his own short note, at most five lines, kept in the desk's register (desk/<id>, field goals). A quiet line or a few
// in the text face; empty only a faint "Goals…". A tap writes in place: the field has the words' face and size, Return
// is a new line (none past the fifth); the keyboard going away (a drag down, a tap in the content) keeps what he wrote,
// an emptied field takes the goals away. No control of our own for the keyboard (ios/README "Keyboard and tab bar").
// Not on All desks (the caller leaves it out there).
import SwiftUI
import TrommiClient

struct DeskGoals: View {
  @EnvironmentObject var model: BoardModel
  /** The desk they belong to ("main" while there is no desk yet: the first one is made for them). */
  let desk: String
  /** What the register holds. */
  let text: String
  @State private var draft: String? = nil
  @FocusState private var focused: Bool
  private let face = Face.text(16, .medium)

  var body: some View {
    Group {
      if let d = draft {
        TextEditor(text: Binding(get: { d }, set: { draft = Self.fit($0) }))
          .font(face).foregroundStyle(Ink.fg).lineSpacing(3)
          .scrollContentBackground(.hidden).scrollDisabled(true)
          .focused($focused)
          .fixedSize(horizontal: false, vertical: true)
          .overlay(alignment: .topLeading) {
            if d.isEmpty { Text("Goals for this desk: up to five lines").font(face).foregroundStyle(Ink.faint).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
          }
          .background(PenBox(r: 8).fill(Ink.sunken))
          .overlay(PenBox(r: 8).stroke(Ink.lineStrong, lineWidth: 1.5))
          .padding(.horizontal, -5)
          .accessibilityLabel("This desk’s goals, up to five lines")
          .onChange(of: focused) { _, on in if !on { done() } }
          .onDisappear { done() }
      } else {
        Button { draft = text; focused = true } label: {
          Text(text.isEmpty ? "Goals…" : text)
            .font(face).italic(text.isEmpty).foregroundStyle(text.isEmpty ? Ink.faint : Ink.muted).lineSpacing(3)
            .multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(text.isEmpty ? "This desk’s goals: none yet" : "This desk’s goals: \(text)")
        .accessibilityHint("Writes a few lines")
      }
    }
    .frame(maxWidth: 600, alignment: .leading)
  }

  /** While he writes: never more than GOALS_LINES lines. */
  static func fit(_ s: String) -> String {
    let lines = s.split(separator: "\n", omittingEmptySubsequences: false)
    return lines.count > GOALS_LINES ? lines.prefix(GOALS_LINES).joined(separator: "\n") : s
  }

  private func done() {
    guard let d = draft else { return }
    draft = nil; focused = false
    if cleanGoals(d) != text { model.setGoals(desk, d) }
  }
}
