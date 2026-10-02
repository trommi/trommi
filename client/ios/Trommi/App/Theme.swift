// The colours of public/css/tokens.css, light and dark. Views never use
// literal colours; everything comes from here. Unlike the web client, which
// stays light until the user picks dark, the app follows the system setting.
import SwiftUI
import UIKit

enum Theme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    // surfaces
    static let bg = dynamic(0xF5F6F2, 0x0E1311)
    static let surface = dynamic(0xFFFFFF, 0x171D1A)
    static let surface2 = dynamic(0xFAFBF8, 0x1C2420)
    static let sunken = dynamic(0xECEEE8, 0x111715)

    // text
    static let fg = dynamic(0x141C18, 0xE9EEEA)
    static let muted = dynamic(0x5C6862, 0x9AA8A0)
    static let faint = dynamic(0x8A958F, 0x6C7A73)

    // lines
    static let line = dynamic(0xE1E5DF, 0x252F2A)
    static let lineStrong = dynamic(0xC9D0C8, 0x35423B)

    // brand
    static let accent = dynamic(0x1B6A57, 0x6FD0B5)
    static let accentSoft = dynamic(0xDCEFE8, 0x17332B)
    static let accentFg = dynamic(0xFFFFFF, 0x08130F)

    static let deny = dynamic(0xA8322D, 0xF08A83)

    static func urgency(_ urgency: Urgency) -> Color {
        switch urgency {
        case .low: return dynamic(0x6B7771, 0x8B9891)
        case .normal: return dynamic(0x1B6A57, 0x6FD0B5)
        case .high: return dynamic(0xB4551B, 0xF2A56C)
        case .critical: return dynamic(0xB3261E, 0xFF8A80)
        }
    }

    static func urgencySoft(_ urgency: Urgency) -> Color {
        switch urgency {
        case .low: return dynamic(0xECEEE8, 0x1C2420)
        case .normal: return dynamic(0xDCEFE8, 0x17332B)
        case .high: return dynamic(0xFBE9DC, 0x3A2415)
        case .critical: return dynamic(0xFBE0DE, 0x41191A)
        }
    }

    /// The traffic light of the status strip.
    static func status(_ state: TaskState) -> Color {
        switch state {
        case .decision: return dynamic(0xC62F25, 0xFF8A80)
        case .working: return dynamic(0xB07A06, 0xF2C14E)
        case .done: return dynamic(0x1F8A4C, 0x6CD598)
        }
    }

    static func statusSoft(_ state: TaskState) -> Color {
        switch state {
        case .decision: return dynamic(0xFBE0DE, 0x41191A)
        case .working: return dynamic(0xFBF0CF, 0x3A2F10)
        case .done: return dynamic(0xDCF2E4, 0x14301F)
        }
    }

    /// The avatar colour of an agent, from its stable hue.
    static func avatar(hue: Int) -> Color {
        Color(uiColor: UIColor { traits in
            let dark = traits.userInterfaceStyle == .dark
            return UIColor(hue: CGFloat(hue) / 360, saturation: dark ? 0.45 : 0.6, brightness: dark ? 0.8 : 0.5, alpha: 1)
        })
    }

    // shape, from --r-sm, --r-md, --r-lg
    static let radiusSmall: CGFloat = 8
    static let radius: CGFloat = 12
    static let radiusLarge: CGFloat = 18
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// A short buzz when something was decided, failed or taken back.
enum Haptics {
    static func decided() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func failed() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
