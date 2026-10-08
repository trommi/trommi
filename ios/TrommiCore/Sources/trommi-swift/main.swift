// trommi-swift: a Trommi device on the command line, built on TrommiCore (the Swift crypto core the iOS app will use).
//
//   trommi-swift join [<invite link> | -]     join as a human device; without a link it reads one line from stdin
//   trommi-swift cards [--json]               sign in, catch up, print the open cards (title, options)
//   trommi-swift answer <card> <option>...    answer an open card (card id or its first characters)
//   trommi-swift rooms                        the rooms this machine holds a key for
//   options: --home <dir> (default ~/.local/share/trommi-swift, or $TROMMI_SWIFT_HOME), --room <room id prefix>,
//            --name <device name> (join; what the other devices show)
//
// Joining is the human's act: run `join` only with a link you made yourself in the app ("add a device"). The terminal
// shows six emoji; nothing is added before you tap "They match" in the app. The link and the key are never printed.
import Foundation
import TrommiClient
import TrommiCore

setvbuf(stdout, nil, _IOLBF, 0)

func die(_ msg: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data("trommi-swift: \(msg)\n".utf8))
  exit(code)
}

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  let v = args[i + 1]
  args.removeSubrange(i...(i + 1))
  return v
}
func flag(_ name: String) -> Bool { if let i = args.firstIndex(of: name) { args.remove(at: i); return true }; return false }

let base = option("--home").map { URL(fileURLWithPath: $0, isDirectory: true) } ?? Store.defaultBase()
let roomPrefix = option("--room")
let deviceName = option("--name")
let asJSON = flag("--json")
let command = args.first ?? "help"
let rest = Array(args.dropFirst())

func pickRoom() throws -> Room {
  let rooms = Store.rooms(base: base).filter { roomPrefix == nil || $0.hasPrefix(roomPrefix!) }
  if rooms.isEmpty { die("no room here yet: join one with `trommi-swift join` (\(base.path))") }
  if rooms.count > 1 { die("several rooms: name one with --room (\(rooms.map { String($0.prefix(12)) }.joined(separator: ", ")))") }
  return try Room.open(base: base, roomId: rooms[0])
}

func short(_ id: String) -> String { String(id.prefix(12)) }

func printCards(_ room: Room) {
  let cards = room.openCards
  if asJSON {
    let list: [[String: Any]] = cards.map { c in
      ["id": c.id, "title": c.title, "card_type": c.cardType, "urgency": c.urgencyName, "state": c.stateName, "session_id": c.sessionId ?? NSNull(), "creator": c.creator,
       "options": c.options.map { ["key": $0.key, "label": $0.label] }]
    }
    print(String(data: try! JSONSerialization.data(withJSONObject: list, options: [.sortedKeys]), encoding: .utf8)!)
    return
  }
  if cards.isEmpty { print("No open cards."); return }
  print("\(cards.count) open card\(cards.count == 1 ? "" : "s"):")
  for c in cards {
    let mark = c.urgency >= 2 ? "!" : "•"
    print("\(mark) \(c.title.isEmpty ? "(no title)" : c.title)   [\(c.cardType), \(c.urgencyName), \(short(c.id))]")
    for o in c.options { print("    - \(o.label)\(o.label != o.key ? "  (\(o.key))" : "")\(o.final ? "  [settles]" : "")") }
  }
}

func run() async throws {
  switch command {
  case "join":
    var link = rest.first ?? "-"
    if link == "-" {
      FileHandle.standardError.write(Data("Paste the invite link from the Trommi app (\"add a device\"), then press Enter:\n".utf8))
      link = readLine(strippingNewline: true)?.trimmingCharacters(in: .whitespaces) ?? ""
    }
    if link.isEmpty { die("no link") }
    let room = try await Room.join(link: link, base: base) { ev in
      switch ev {
      case .requested: print("Asked to join. Waiting for the app to answer…")
      case .checkCode(let code):
        let e = checkEmoji(code)
        print("check code \(e.map { $0.emoji }.joined(separator: " ")) (\(e.map { $0.word }.joined(separator: ", ")))")
        print("The Trommi app shows six emoji on its invite page. Tap \"They match\" there only if they are these six, in this order.")
      case .joined: print("Joined. This device is a member of the room now.")
      }
    }
    let host = ProcessInfo.processInfo.hostName
    try await room.sendDeviceRegister(name: deviceName ?? "trommi-swift (\(host))", platform: "trommi-swift")
    let report = try await room.sync()
    for w in report.warnings { print("warning: \(w)") }
    print("room \(short(room.record.roomId)) at \(room.record.hubURL), device \(short(room.record.myDeviceId)); key in \(room.store.dir.path)/device.key")
    printCards(room)
  case "cards":
    let room = try pickRoom()
    let report = try await room.sync()
    for w in report.warnings { FileHandle.standardError.write(Data("warning: \(w)\n".utf8)) }
    if !asJSON { print("caught up: \(report.envelopes) envelopes verified (\(report.opened) opened, \(report.headerOnly) header only, \(report.undecryptable) without key, \(report.voids) void\(report.refused > 0 ? ", \(report.refused) REFUSED" : ""))") }
    printCards(room)
  case "answer":
    guard rest.count >= 2 else { die("usage: trommi-swift answer <card> <option>...") }
    let room = try pickRoom()
    try await room.sync()
    let r = try await room.answer(cardId: rest[0], choices: Array(rest.dropFirst()))
    print(asJSON ? "{\"envelope_number\":\(r.number),\"envelope_hash\":\"\(r.hash)\"}" : "answered (envelope \(r.number))")
  case "rooms":
    for id in Store.rooms(base: base) {
      let r = try Room.open(base: base, roomId: id)
      print("\(id)  \(r.record.hubURL)  device \(short(r.record.myDeviceId))")
    }
  case "whoami":
    let room = try pickRoom()
    print("room \(room.record.roomId)\nhub \(room.record.hubURL)\ndevice \(room.record.myDeviceId)")
  default:
    print("""
      trommi-swift join [<invite link> | -]     join as a human device (the link from the app's "add a device"; - or nothing: read it from stdin)
      trommi-swift cards [--json]               catch up and print the open cards
      trommi-swift answer <card> <option>...    answer an open card
      trommi-swift rooms | whoami
      options: --home <dir>, --room <id prefix>, --name <device name>
      """)
  }
}

let done = DispatchSemaphore(value: 0)
Task {
  do { try await run() }
  catch let e as ZError { die(e.description) }
  catch let e as HubError { die("hub: \(e.description)") }
  catch { die("\(error)") }
  done.signal()
}
done.wait()
