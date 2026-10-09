// DeskGoals.swift: the desk's goals under the Desk's greeting (app/web/public/desk.mjs deskGoals, controller "goals"):
// his own note, a checklist of at most GOALS_LINES lines, kept in the desk's register (desk/<id>, field goals). A quiet
// line or a few in the text face; empty only a faint "Goals…". The first GOALS_SHOWN lines are shown; more are folded
// behind "+N more", which opens them in place (kept per desk on this device). A tap on the words writes in place: the
// field has the words' face and size and grows with them to ROWS rows, then it scrolls; Return is a new line (none
// past the last); the keyboard going away (a drag down, a tap in the content) keeps what he wrote, an emptied field
// takes the goals away. No control of our own for the keyboard (ios/README "Keyboard and tab bar").
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
  /** The desks whose goals are unfolded on this device, their ids joined by "," (the web's localStorage trommi-goals-open). */
  @AppStorage("trommi-goals-open") private var opened = ""
  private let face = Face.text(16, .medium)
  /** The field's most rows before it scrolls, and what a row and the field's own inset measure. */
  private static let ROWS = 10, ROW: CGFloat = 23, INSET: CGFloat = 16

  private var isOpen: Bool { opened.split(separator: ",").contains(Substring(desk)) }
  private func setOpen(_ on: Bool) {
    var ids = opened.split(separator: ",").map(String.init).filter { $0 != desk }
    if on { ids.append(desk) }
    opened = ids.suffix(50).joined(separator: ",")
  }

  var body: some View {
    Group {
      if let d = draft {
        let tall = d.split(separator: "\n", omittingEmptySubsequences: false).count > Self.ROWS
        TextEditor(text: Binding(get: { d }, set: { draft = Self.fit($0) }))
          .font(face).foregroundStyle(Ink.fg).lineSpacing(3)
          .scrollContentBackground(.hidden).scrollDisabled(!tall)
          .focused($focused)
          .fixedSize(horizontal: false, vertical: !tall)
          .frame(height: tall ? CGFloat(Self.ROWS) * Self.ROW + Self.INSET : nil)
          .overlay(alignment: .topLeading) {
            if d.isEmpty { Text("Goals for this desk: one a line, up to \(GOALS_LINES)").font(face).foregroundStyle(Ink.faint).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false) }
          }
          .background(PenBox(r: 8).fill(Ink.sunken))
          .overlay(PenBox(r: 8).stroke(Ink.lineStrong, lineWidth: 1.5))
          .padding(.horizontal, -5)
          .accessibilityLabel("This desk’s goals, up to \(GOALS_LINES) lines")
          .onChange(of: focused) { _, on in if !on { done() } }
          .onDisappear { done() }
      } else {
        let fold = goalsFold(text), open = isOpen
        VStack(alignment: .leading, spacing: 0) {
          Button { draft = text; focused = true } label: {
            Text(text.isEmpty ? "Goals…" : (open ? text : fold.shown))
              .font(face).italic(text.isEmpty).foregroundStyle(text.isEmpty ? Ink.faint : Ink.muted).lineSpacing(3)
              .multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
              .padding(.top, 8).padding(.bottom, fold.more > 0 ? 2 : 8).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(text.isEmpty ? "This desk’s goals: none yet" : "This desk’s goals: \(text)")
          .accessibilityHint("Writes a few lines")
          if fold.more > 0 {
            Button { setOpen(!open) } label: {
              Text(open ? "Show less" : "+\(fold.more) more")
                .font(Face.text(14, .semibold)).foregroundStyle(Ink.muted).underline(true, color: Ink.accent)
                .padding(.top, 4).padding(.bottom, 8).padding(.trailing, 16).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(open ? "Show fewer goals" : "Show \(fold.more) more goals")
          }
        }
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
