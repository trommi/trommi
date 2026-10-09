// What the generated records would print of themselves, taken back for the ones that hold keys or decrypted
// content. Swift prints any struct field by field (print, string interpolation, a debugger, a crash log with a
// dumped value); these records answer with their name instead. Hand-written, beside the file UniFFI generates;
// the facade's own `Debug` in Rust does the same (the records declared `secret` in core/swift/src).
import Foundation

/// A record that prints its name and nothing of what it holds.
protocol Redacted: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {}

extension Redacted {
  public var description: String { "\(Self.self)(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: []) }
}

extension StoreEntry: Redacted {}
extension StoredState: Redacted {}
extension StoreWrite: Redacted {}
extension AccountKeys: Redacted {}
extension FileRef: Redacted {}
extension FileEnd: Redacted {}
extension ShareLink: Redacted {}
extension ReceivedMessage: Redacted {}
extension Processed: Redacted {}
extension PushNote: Redacted {}
