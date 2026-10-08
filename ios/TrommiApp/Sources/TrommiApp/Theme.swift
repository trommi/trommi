// Theme.swift: the web app's design tokens (app/web/public/app.css) as SwiftUI colours and fonts: paper, ink, the
// accent green, urgency, the tones of a session's hue (oklch, as the web turns them), the gold of the crown; the display
// face (Bricolage Grotesque) and the text face (IBM Plex Sans), bundled. Light, dark or the system's choice.
import SwiftUI
#if canImport(UIKit)
import UIKit
import CoreText
#endif

// ---- colours ---------------------------------------------------------------------------------------

extension Color {
  init(hex: UInt32, alpha: Double = 1) {
    self.init(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255, opacity: alpha)
  }
  /** A colour with one value for light and one for dark. */
  static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
    #if canImport(UIKit)
    return Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
    #else
    return Color(hex: light)
    #endif
  }
}
#if canImport(UIKit)
extension UIColor {
  convenience init(rgb: UInt32, alpha: CGFloat = 1) {
    self.init(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: alpha)
  }
}
#endif

enum Ink {
  static let bg = Color.dyn(0xf5f6f2, 0x0e1311)
  static let surface = Color.dyn(0xffffff, 0x171d1a)
  static let surface2 = Color.dyn(0xfafbf8, 0x1c2420)
  static let sunken = Color.dyn(0xeceee8, 0x111715)
  static let fg = Color.dyn(0x141c18, 0xe9eeea)
  static let muted = Color.dyn(0x5c6862, 0x9aa8a0)
  static let faint = Color.dyn(0x8a958f, 0x6c7a73)
  static let line = Color.dyn(0xe1e5df, 0x252f2a)
  static let lineStrong = Color.dyn(0xc9d0c8, 0x35423b)
  static let accent = Color.dyn(0x1b6a57, 0x6fd0b5)
  static let accentSoft = Color.dyn(0xdcefe8, 0x17332b)
  static let accentFg = Color.dyn(0xffffff, 0x08130f)
  static let urgLow = Color.dyn(0x6b7771, 0x8b9891)
  static let urgHigh = Color.dyn(0xb4551b, 0xf2a56c)
  static let urgHighSoft = Color.dyn(0xfbe9dc, 0x3a2415)
  static let urgCritical = Color.dyn(0xb3261e, 0xff8a80)
  static let urgCriticalSoft = Color.dyn(0xfbe0de, 0x41191a)
  static let deny = Color.dyn(0xa8322d, 0xf08a83)
  static let goldPen = Color.dyn(0xa8820f, 0xdcb84e)
  static let crownWash = Color(hex: 0xf2c94c)
  static let stampLater = Color.dyn(0x2b3f9e, 0x9aacf2)
  static let stampDone = Color.dyn(0x1b6a57, 0x6fd0b5)
  static let yellow = Color(hex: 0xf5d64a)
  static let noteYellow = Color.dyn(0xf5d64a, 0xd9c35f)
  static let noteInk = Color(hex: 0x3b300d)
  static let duckYellow = Color(hex: 0xf7d44c)
  static let stDecision = Color.dyn(0xc62f25, 0xff8a80)
  static let stWorking = Color.dyn(0xb07a06, 0xf2c14e)
  static let stDone = Color.dyn(0x1f8a4c, 0x6cd598)
  /** The coral of the Desk's lead answer (desk.css: the filled tile). */
  static let lead = Color.dyn(0xf28b7a, 0xff8a80)
  static let leadFg = Color.dyn(0x1d0f0c, 0x1d0f0c)
  static func urgency(_ u: String) -> Color { u == "critical" ? urgCritical : u == "high" ? urgHigh : u == "low" ? urgLow : accent }
}

/** A session's tones from its hue (app.css: oklch, the hue turned by 10 so 162 is the bell's green). */
enum Tone {
  enum Weight { case wash, edge, mid, pen }
  static func color(hue: Int, _ w: Weight) -> Color {
    #if canImport(UIKit)
    return Color(UIColor { t in
      let dark = t.userInterfaceStyle == .dark
      let (l, c): (Double, Double)
      switch w {
      case .wash: (l, c) = dark ? (0.28, 0.03) : (0.95, 0.022)
      case .edge: (l, c) = dark ? (0.4, 0.05) : (0.88, 0.045)
      case .mid: (l, c) = dark ? (0.62, 0.075) : (0.64, 0.075)
      case .pen: (l, c) = dark ? (0.8, 0.095) : (0.47, 0.085)
      }
      let (r, g, b) = oklch(l, c, Double(hue + 10))
      return UIColor(red: r, green: g, blue: b, alpha: 1)
    })
    #else
    return .gray
    #endif
  }
  /** The mark's colour: hsl(hue 62% 30%) on light, hsl(hue 70% 76%) on dark (ui.mjs drawingHue). */
  static func mark(_ hue: Int) -> Color {
    #if canImport(UIKit)
    return Color(UIColor { t in
      let dark = t.userInterfaceStyle == .dark
      let (r, g, b) = hsl(Double(hue), dark ? 0.70 : 0.62, dark ? 0.76 : 0.30)
      return UIColor(red: r, green: g, blue: b, alpha: 1)
    })
    #else
    return .gray
    #endif
  }
  static func hsl(_ h: Double, _ s: Double, _ l: Double) -> (Double, Double, Double) {
    let c = (1 - abs(2 * l - 1)) * s, hp = (h.truncatingRemainder(dividingBy: 360)) / 60, x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
    let (r1, g1, b1): (Double, Double, Double) = hp < 1 ? (c, x, 0) : hp < 2 ? (x, c, 0) : hp < 3 ? (0, c, x) : hp < 4 ? (0, x, c) : hp < 5 ? (x, 0, c) : (c, 0, x)
    let m = l - c / 2
    return (r1 + m, g1 + m, b1 + m)
  }
  static func oklch(_ L: Double, _ C: Double, _ hDeg: Double) -> (Double, Double, Double) {
    let h = hDeg * .pi / 180, a = C * cos(h), b = C * sin(h)
    let l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b
    let l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
    let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    func gamma(_ x: Double) -> Double { let v = max(0, min(1, x)); return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055 }
    return (gamma(r), gamma(g), gamma(bl))
  }
}

// ---- type -----------------------------------------------------------------------------------------------

enum Face {
  static func registerFonts() {
    #if canImport(UIKit)
    guard let dir = Bundle.module.url(forResource: "Fonts", withExtension: nil),
          let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
    for f in files where f.pathExtension == "ttf" { CTFontManagerRegisterFontsForURL(f as CFURL, .process, nil) }
    #endif
  }
  /** The display face (headings, a card's title): Bricolage Grotesque. */
  static func display(_ size: CGFloat, _ weight: Font.Weight = .bold, relativeTo style: Font.TextStyle = .title) -> Font {
    let name = weight == .heavy || weight == .black ? "BricolageGrotesque-ExtraBold" : weight == .semibold ? "BricolageGrotesque-SemiBold" : "BricolageGrotesque-Bold"
    return .custom(name, size: size, relativeTo: style)
  }
  /** The text face: IBM Plex Sans. */
  static func text(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
    let name = weight == .semibold || weight == .bold ? "IBMPlexSans-SemiBold" : weight == .medium ? "IBMPlexSans-Medium" : "IBMPlexSans-Regular"
    return .custom(name, size: size, relativeTo: style)
  }
  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .custom(weight == .medium || weight == .semibold ? "IBMPlexMono-Medium" : "IBMPlexMono-Regular", size: size, relativeTo: .footnote)
  }
}

// ---- light, dark, system ------------------------------------------------------------------------------

enum ThemeMode: String, CaseIterable, Identifiable {
  case system, light, dark
  var id: String { rawValue }
  var scheme: ColorScheme? { self == .light ? .light : self == .dark ? .dark : nil }
  var word: String { self == .system ? "System" : self == .light ? "Light" : "Dark" }
}

// ---- small shared shapes ---------------------------------------------------------------------------------

/** The hand-drawn rounded rectangle the web uses for tiles and boxes (border radii slightly uneven). */
struct PenBox: Shape {
  var r: CGFloat = 12
  func path(in rect: CGRect) -> Path {
    var p = Path()
    let w = rect.width, h = rect.height, x = rect.minX, y = rect.minY
    let a = min(r, w / 2, h / 2), b = min(r * 1.25, w / 2, h / 2), c = min(r * 0.85, w / 2, h / 2), d = min(r * 1.1, w / 2, h / 2)
    p.move(to: CGPoint(x: x + a, y: y))
    p.addQuadCurve(to: CGPoint(x: x + w - b, y: y + 0.6), control: CGPoint(x: x + w / 2, y: y - 0.8))
    p.addQuadCurve(to: CGPoint(x: x + w, y: y + b), control: CGPoint(x: x + w, y: y))
    p.addQuadCurve(to: CGPoint(x: x + w - 0.5, y: y + h - c), control: CGPoint(x: x + w + 0.7, y: y + h / 2))
    p.addQuadCurve(to: CGPoint(x: x + w - c, y: y + h), control: CGPoint(x: x + w, y: y + h))
    p.addQuadCurve(to: CGPoint(x: x + d, y: y + h - 0.4), control: CGPoint(x: x + w / 2, y: y + h + 0.8))
    p.addQuadCurve(to: CGPoint(x: x, y: y + h - d), control: CGPoint(x: x, y: y + h))
    p.addQuadCurve(to: CGPoint(x: x + 0.4, y: y + a), control: CGPoint(x: x - 0.7, y: y + h / 2))
    p.addQuadCurve(to: CGPoint(x: x + a, y: y), control: CGPoint(x: x, y: y))
    p.closeSubpath()
    return p
  }
}

extension View {
  /** Liquid Glass where the system has it (iOS 26+), a thin material before. */
  @ViewBuilder func glass<S: Shape>(_ shape: S, interactive: Bool = false, tint: Color? = nil) -> some View {
    if #available(iOS 26.0, *) {
      self.glassEffect(interactive ? Glass.regular.tint(tint).interactive() : Glass.regular.tint(tint), in: shape)
    } else {
      self.background(.ultraThinMaterial, in: shape)
    }
  }
}
