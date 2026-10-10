// The Notification Service Extension's executable: its class is in the TrommiApp package (Sources/TrommiNotify); this
// target links it and names its class once, so the linker keeps it (Info.plist NSExtensionPrincipalClass looks it up).
import TrommiNotify

public let trommiNotifyPrincipalClass: AnyClass = TrommiNotificationService.self
