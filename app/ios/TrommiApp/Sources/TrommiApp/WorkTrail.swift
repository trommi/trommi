// WorkTrail.swift: a turn's trail in a session's conversation (README "The trail"; app/web/public/session.mjs
// workBlock, workLine): what the agent did between his prompt and its answer, as ONE folded line ("Worked 52 s ·
// 8 steps · 1 helper · 1 with an error"; while it runs, the step it is at). A tap opens the list: the agent's words between
// its steps, one line per step (state, tool, what it is about, how long it took), a helper as one line with its
// step count, "exit code 1" on a shell command that failed. At the level `full` a step opens to its input and output in a monospace box.
//
// Sober on purpose: inside a conversation with an agent nothing is hand-drawn; the system's symbols and the
// conversation's own type, quiet colours. The folding itself is TrommiClient (Work.swift, a port of shared/work.ts).
import SwiftUI
import TrommiClient

/**
 * Which trails and which of their steps he opened. Kept here, outside the rows: the conversation is a lazy stack whose
 * rows are made again when they scroll back in and when a later envelope of the turn arrives, and what he opened
 * stays open through both. In memory only, for this run of the app.
 */
@MainActor final class TrailFolds: ObservableObject {
  static let shared = TrailFolds()
  @Published var open = Set<String>()
  func toggle(_ key: String) { if open.contains(key) { open.remove(key) } else { open.insert(key) } }
}

struct WorkTrailView: View {
  let message: Message
  let block: WorkBlock
  @ObservedObject private var folds = TrailFolds.shared
  private var key: String { "\(message.agent)/\(block.turn)" }

  var body: some View {
    let open = folds.open.contains(key)
    VStack(alignment: .leading, spacing: 0) {
      Button { folds.toggle(key) } label: { head(open) }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(block.line)
        .accessibilityValue(open ? "open" : "folded")
        .accessibilityHint(open ? "Folds the steps away" : "Shows the steps")
      if open {
        Rectangle().fill(Ink.line).frame(height: 1)
        VStack(alignment: .leading, spacing: 7) {
          ForEach(block.items) { x in WorkLineView(line: x, key: "\(key)#\(x.id)") }
          if let rest = block.rest { Text(rest).font(Face.text(13)).foregroundStyle(Ink.faint).padding(.leading, 24) }
          if block.items.isEmpty && block.rest == nil { Text("Nothing listed yet.").font(Face.text(13)).foregroundStyle(Ink.faint) }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
      }
    }
    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Ink.surface2))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Ink.line, lineWidth: 1))
    .padding(.trailing, 24)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func head(_ open: Bool) -> some View {
    let sum = block.summary, now = block.now
    return HStack(alignment: .firstTextBaseline, spacing: 6) {
      WorkSign(state: block.state == "done" ? "ok" : block.state)
      Text(block.head).font(Face.text(14, .semibold)).foregroundStyle(Ink.fg).lineLimit(1).fixedSize()
      if !sum.isEmpty { Text("· \(sum)").font(Face.text(14)).foregroundStyle(Ink.muted).lineLimit(1).layoutPriority(1) }
      if let now = now { Text("· \(now)").font(Face.text(14)).foregroundStyle(Ink.fg).lineLimit(1).truncationMode(.tail) }
      Spacer(minLength: 4)
      Text(clockOf(message.ts)).font(Face.text(11)).foregroundStyle(Ink.faint).lineLimit(1).fixedSize()
      Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Ink.faint).rotationEffect(.degrees(open ? 90 : 0))
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
    .contentShape(Rectangle())
  }
}

/** One line of an open trail. */
private struct WorkLineView: View {
  let line: WorkLine
  let key: String
  @ObservedObject private var folds = TrailFolds.shared

  var body: some View {
    if line.kind == "text" {
      // the agent's words between two steps: the conversation's own type, in line with the steps' names
      RichText(text: line.text ?? "", size: 14, color: Ink.fg).padding(.leading, 24).padding(.vertical, 2)
    } else if line.opens {
      let open = folds.open.contains(key)
      VStack(alignment: .leading, spacing: 6) {
        Button { folds.toggle(key) } label: { row(chevron: open) }
          .buttonStyle(.plain)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(spoken)
          .accessibilityValue(open ? "open" : "folded")
          .accessibilityHint(open ? "Hides what went in and came out" : "Shows what went in and came out")
        if open {
          if let i = line.input, !i.isEmpty { WorkIO(text: i, color: Ink.fg, says: "Input") }
          if let o = line.output, !o.isEmpty { WorkIO(text: o, color: Ink.muted, says: "Output") }
        }
      }
    } else {
      row(chevron: nil).accessibilityElement(children: .ignore).accessibilityLabel(spoken)
    }
  }

  private func row(chevron: Bool?) -> some View {
    let what = line.what
    return HStack(alignment: .firstTextBaseline, spacing: 6) {
      WorkSign(state: line.shown)
      Text(line.name).font(Face.text(14, .semibold)).foregroundStyle(Ink.fg).lineLimit(1).fixedSize()
      if !what.isEmpty { Text(what).font(Face.text(14)).foregroundStyle(Ink.muted).lineLimit(1).truncationMode(.middle) }
      Spacer(minLength: 4)
      if line.kind == "helper", let n = line.steps, n >= 1 { Text(Work.count(Int(min(n, 1e9)), "step")).font(Face.text(12)).foregroundStyle(Ink.muted).lineLimit(1).fixedSize() }
      if let e = line.exitSays { Text(e).font(Face.text(12)).foregroundStyle(Ink.deny).lineLimit(1).fixedSize() }
      if let ms = line.ms { Text(Work.span(ms)).font(Face.text(12)).monospacedDigit().foregroundStyle(Ink.faint).lineLimit(1).fixedSize() }
      if let open = chevron { Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Ink.faint).rotationEffect(.degrees(open ? 90 : 0)) }
    }
    .contentShape(Rectangle())
  }
  private var spoken: String {
    var parts = [line.name, line.what, line.says]
    if line.kind == "helper", let n = line.steps, n >= 1 { parts.append(Work.count(Int(min(n, 1e9)), "step")) }
    if let ms = line.ms { parts.append(Work.span(ms)) }
    return parts.filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

/** A step's or a turn's state as a small sign: a breathing dot while it runs, a tick, a cross, a stop. */
private struct WorkSign: View {
  let state: String
  @Environment(\.accessibilityReduceMotion) private var still
  @State private var lit = false
  var body: some View {
    Group {
      switch state {
      case "running":
        Circle().fill(Ink.muted).frame(width: 7, height: 7)
          .opacity(still ? 0.7 : (lit ? 1 : 0.25))
          .animation(still ? nil : .easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: lit)
          .onAppear { lit = true }
      case "ok": Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Ink.muted)
      case "failed": Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Ink.deny)
      default: Image(systemName: "stop.fill").font(.system(size: 8)).foregroundStyle(Ink.muted)
      }
    }
    .frame(width: 18, alignment: .center)
    .accessibilityHidden(true)
  }
}

/** A step's input or output (the level `full`): monospace, as the terminal showed it; a long one scrolls in its box. */
private struct WorkIO: View {
  let text: String
  let color: Color
  let says: String
  var body: some View {
    let long = text.utf8.count > 1400 || text.reduce(0) { $1.isNewline ? $0 + 1 : $0 } > 22
    let words = Text(text).font(Face.mono(12)).foregroundStyle(color).textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).padding(.vertical, 8)
    Group {
      if long { ScrollView { words }.frame(maxHeight: 300) } else { words }
    }
    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Ink.sunken))
    .padding(.leading, 24)
    .contextMenu { Button { copyText(text) } label: { Label("Copy", systemImage: "doc.on.doc") } }
    .accessibilityLabel("\(says): \(text)")
  }
}
