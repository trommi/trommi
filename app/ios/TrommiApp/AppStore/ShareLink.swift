// The Share Extension's executable: its view controller is in the TrommiApp package (Sources/TrommiShare); this target
// links it and names its class once, so the linker keeps it (Info.plist NSExtensionPrincipalClass looks it up by name).
import TrommiShare

public let trommiSharePrincipalClass: AnyClass = TrommiShareViewController.self
