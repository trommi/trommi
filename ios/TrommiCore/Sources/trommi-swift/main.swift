// trommi-swift: a Trommi device on the command line, built on TrommiCore (the Swift crypto core the iOS app will use).
//
//   trommi-swift join [<invite link> | -]     join as a human device; without a link it reads one line from stdin
//   trommi-swift cards [--json]               sign in, catch up, print the open cards (title, options)
//   trommi-swift answer <card> <option>...    answer an open card (card id or its first characters)
//   trommi-swift login <email>                log in with the account's email and password (read from stdin, never
//                                             an argument); the device adds itself to the account's room
//   trommi-swift rooms                        the rooms this machine holds a key for
//   options: --home <dir> (default ~/.local/share/trommi-swift, or $TROMMI_SWIFT_HOME), --room <room id prefix>,
//            --name <device name> (join, login; what the other devices show), --hub <url> (login; default https://hub.trommi.com)
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
let hubOption = option("--hub")
let linkOut = option("--link-out")
let confirmYes = flag("--yes")
let asJSON = flag("--json")
let command = args.first ?? "help"
let rest = Array(args.dropFirst())

nonisolated(unsafe) var openedRoom: Room?
@MainActor func pickRoom() throws -> Room {
  let rooms = Store.rooms(base: base).filter { roomPrefix == nil || $0.hasPrefix(roomPrefix!) }
  if rooms.isEmpty { die("no room here yet: join one with `trommi-swift join` (\(base.path))") }
  if rooms.count > 1 { die("several rooms: name one with --room (\(rooms.map { String($0.prefix(12)) }.joined(separator: ", ")))") }
  let r = try Room.open(base: base, roomId: rooms[0])
  openedRoom = r
  return r
}

func short(_ id: String) -> String { String(id.prefix(12)) }

@MainActor func printCards(_ room: Room) {
  let cards = room.openCards
  if asJSON {
    let list: [[String: Any]] = cards.map { c in
      ["id": c.objectId, "title": c.title, "card_type": c.cardType, "urgency": c.urgency, "state": c.objectState, "session_id": c.sessionId ?? NSNull(), "creator": c.agentDeviceId,
       "options": c.options.map { ["key": $0.key, "label": $0.label] }]
    }
    print(String(data: try! JSONSerialization.data(withJSONObject: list, options: [.sortedKeys]), encoding: .utf8)!)
    return
  }
  if cards.isEmpty { print("No open cards."); return }
  print("\(cards.count) open card\(cards.count == 1 ? "" : "s"):")
  for c in cards {
    let mark = c.urgency == "high" || c.urgency == "critical" ? "!" : "•"
    print("\(mark) \(c.title.isEmpty ? "(no title)" : c.title)   [\(c.cardType), \(c.urgency), \(short(c.objectId))]")
    for o in c.options { print("    - \(o.label)\(o.label != o.key ? "  (\(o.key))" : "")\(o.final ? "  [settles]" : "")") }
  }
}

@MainActor func run() async throws {
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
    openedRoom = room
    let host = ProcessInfo.processInfo.hostName
    try await room.sendDeviceRegister(name: deviceName ?? "trommi-swift (\(host))", platform: "trommi-swift")
    let report = try await room.sync()
    for w in report.warnings { print("warning: \(w)") }
    print("room \(short(room.record.roomId)) at \(room.record.hubURL), device \(short(room.record.myDeviceId)); key in \(room.store.dir.path)/device.key")
    printCards(room)
  case "login":
    guard let email = rest.first else { die("usage: trommi-swift login <email>  (the password is read from stdin)") }
    FileHandle.standardError.write(Data("Password for \(email), then Enter:\n".utf8))
    let password = readLine(strippingNewline: true) ?? ""
    if password.isEmpty { die("no password") }
    let room = try await Room.loginWithPassword(hubURL: hubOption ?? "https://hub.trommi.com", email: email, password: password, base: base)
    openedRoom = room
    print("Logged in. This device is a member of the room now.")
    try await room.sendDeviceRegister(name: deviceName ?? "trommi-swift (\(ProcessInfo.processInfo.hostName))", platform: "trommi-swift")
    let report = try await room.sync()
    for w in report.warnings { print("warning: \(w)") }
    print("room \(short(room.record.roomId)) at \(room.record.hubURL), device \(short(room.record.myDeviceId))")
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
    let prefix = rest[0]
    guard let id = room.board.cards.keys.first(where: { $0.hasPrefix(prefix) }) else { die("no such card") }
    try await room.answer(cardId: id, choices: Array(rest.dropFirst()))
    let r = try await room.flush()
    print(asJSON ? "{\"envelope_number\":\(r.number),\"envelope_hash\":\"\(r.hash)\"}" : "answered (envelope \(r.number))")
  case "dump":
    // The board as the app reads it (Desk.swift), for the parity check against the JS core's model.
    let room = try pickRoom()
    try await room.sync()
    let d = DeskModel(board: room.board)
    let cards: [[String: Any]] = d.cards.map { c in
      ["id": c.id, "number": c.number, "kind": c.kind, "status": c.status, "title": c.title, "choices": c.choices, "agent": c.agent, "urgency": c.urgency]
    }
    let agents: [[String: Any]] = d.agents.map { a in ["id": a.id, "name": a.name, "archived": a.archived, "starred": a.starred, "hue": a.hue] }
    let notes: [[String: Any]] = d.notes.map { ["id": $0.id, "text": $0.text] }
    var messages: [String: Int] = [:]
    for a in d.agents { messages[a.id] = d.messagesOf(agent: a.id).filter { $0.from != "event" }.count }
    let out: [String: Any] = ["cards": cards, "agents": agents, "notes": notes, "stack": room.board.stack, "messages": messages,
                              "registers": room.board.human.raw.keys.sorted()]
    print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
  case "say":
    // A message to a session (the first, or --to <board id>); the text from stdin.
    guard let text = readLine(strippingNewline: true), !text.isEmpty else { die("no text") }
    let room = try pickRoom()
    try await room.sync()
    let d = DeskModel(board: room.board)
    guard let a = (rest.first.flatMap { id in d.agents.first { $0.id == id } }) ?? d.agents.first, let key = d.sessionKey(of: a.id) else { die("no session") }
    try await room.sendMessage(sessionId: key, text: text)
    let r = try await room.flush()
    print("sent (envelope \(r.number))")
  case "note":
    guard let text = readLine(strippingNewline: true), !text.isEmpty else { die("no text") }
    let room = try pickRoom()
    try await room.sync()
    let id = try await room.saveNote(fields: ["text": .str(text), "created_at": .n(nowMs())])
    try await room.flush()
    print("note \(id)")
  case "register":
    // trommi-swift register <key> <json value>
    guard rest.count >= 2, let v = JV.parse(Array(rest[1].utf8)) else { die("usage: trommi-swift register <key> <json>") }
    let room = try pickRoom()
    try await room.sync()
    try await room.setRegisters([rest[0]: v])
    try await room.flush()
    print("set \(rest[0])")
  case "pair":
    // Pair a device from here: the link goes to the file named by --link-out (never to stdout), the check code is printed,
    // and --yes confirms it once it is there (tests; a person compares the emoji in the app).
    guard let out = linkOut else { die("usage: trommi-swift pair --link-out <file> [--yes]") }
    let room = try pickRoom()
    try await room.sync()
    var p = try await room.createPairing(app: "http://127.0.0.1/join")
    try Data(p.link.utf8).write(to: URL(fileURLWithPath: out))
    while !(try await room.checkPairing(&p)) { try await Task.sleep(nanoseconds: 200_000_000) }
    let e = checkEmoji(p.code ?? "")
    print("check code \(e.map { $0.emoji }.joined(separator: " ")) (\(e.map { $0.word }.joined(separator: ", ")))")
    try await room.confirmPairing(p, matches: confirmYes)
    print("Added. The new device is a member now.")
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
      trommi-swift login <email>                log in with email and password (password from stdin)
      trommi-swift cards [--json]               catch up and print the open cards
      trommi-swift answer <card> <option>...    answer an open card
      trommi-swift rooms | whoami
      options: --home <dir>, --room <id prefix>, --name <device name>, --hub <url>
      """)
  }
}

do { try await run(); if let r = openedRoom { try await r.flush() } }
catch let e as ZError { die(e.description) }
catch let e as HubError { die("hub: \(e.description)") }
catch { die("\(error)") }
exit(0)
