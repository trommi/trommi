// LayoutProbe.swift: the in-app half of the iOS layout audit (dev/ios-audit). Debug tool, not part of the app target:
// link it in for a probe build (`ln -s ../../../../dev/ios-audit/LayoutProbe.swift ios/TrommiApp/Sources/TrommiApp/`)
// and call it once from TrommiApp.swift (dev/ios-audit/README section of device.py has the exact hook).
//
// Started with TROMMI_LAYOUT_AUDIT in the process environment (`pymobiledevice3 developer dvt launch --env
// TROMMI_LAYOUT_AUDIT=1 <bundle>` on the phone, `SIMCTL_CHILD_TROMMI_LAYOUT_AUDIT=1 xcrun simctl launch` in a simulator):
//   1      every page the hook names is opened in turn; for each, the live window is captured at rest and with every
//          scroll view scrolled to its end: the accessibility elements with their frames, traits and labels, the floating
//          glass and bars (chrome), the safe-area insets, a screenshot
//   sizes  the same, but the root view is also hosted offscreen at 375x667, 393x852 and 430x932 points (the insets of
//          an SE, a 16/17 and a Pro Max), so one phone checks three sizes
// Everything lands in one file, Documents/layout-audit.json (screenshots as base64 PNG), which `device.py --pull`
// fetches and checks with rules.py (overlap, tap targets, safe areas, content under glass), boxes drawn.
#if canImport(UIKit)
import SwiftUI
import UIKit
import os

@MainActor enum LayoutProbe {
  static let log = Logger(subsystem: "com.trommi.ios", category: "layout-audit")
  static var mode: String? { ProcessInfo.processInfo.environment["TROMMI_LAYOUT_AUDIT"] }

  /// The hook: `LayoutProbe.runIfAsked(model, root: { RootView() }, pages: [("desk", { model.tab = .desk }), ...])`.
  static func runIfAsked<M: ObservableObject, V: View>(_ model: M, root: @escaping () -> V, pages: [(String, () -> Void)]) {
    guard let mode = mode, !mode.isEmpty, mode != "0" else { return }
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 8_000_000_000)            // the board settles (catch-up, first render)
      var dumps: [[String: Any]] = []
      for (name, open) in pages.isEmpty ? [("live", {})] : pages {
        open()
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard let w = keyWindow() else { continue }
        dumps.append(capture(window: w, name: name, state: "rest"))
        let saved = scrollToEnds(in: w)
        try? await Task.sleep(nanoseconds: 900_000_000)
        dumps.append(capture(window: w, name: name, state: "end"))
        for (s, o) in saved { s.setContentOffset(o, animated: false) }
        if mode == "sizes" {
          for size in SIZES { dumps.append(await hosted(root().environmentObject(model), name: name, size: size)) }
        }
      }
      write(dumps)
    }
  }

  struct Size { let w: CGFloat; let h: CGFloat; let top: CGFloat; let bottom: CGFloat; let tag: String }
  static let SIZES = [Size(w: 375, h: 667, top: 20, bottom: 0, tag: "375x667"),
                      Size(w: 393, h: 852, top: 59, bottom: 34, tag: "393x852"),
                      Size(w: 430, h: 932, top: 59, bottom: 34, tag: "430x932")]

  static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }.first { $0.isKeyWindow }
  }

  // ---- one capture --------------------------------------------------------------------------------------------

  static func capture(window: UIWindow, name: String, state: String, tag: String? = nil) -> [String: Any] {
    window.layoutIfNeeded()
    let chrome = chromeRects(in: window)
    var elements: [[String: Any]] = chrome.map { ["label": "glass: \($0.1)", "rect": arr($0.0), "chrome": true, "interactive": false, "text": false, "state": state] }
    var seen = Set<String>()
    walk(window, depth: 0) { obj in
      let f = window.screen.coordinateSpace.convert(obj.accessibilityFrame, to: window)   // accessibilityFrame is in screen points
      guard f.width > 0, f.height > 0, f.intersects(window.bounds) else { return }
      let key = "\(Int(f.minX)),\(Int(f.minY)),\(Int(f.width)),\(Int(f.height)),\(obj.accessibilityLabel ?? "")"
      guard seen.insert(key).inserted else { return }
      let t = obj.accessibilityTraits
      let interactive = t.contains(.button) || t.contains(.link) || t.contains(.adjustable) || t.contains(.searchField)
        || t.contains(.keyboardKey) || (obj as? UIControl) != nil || (obj.accessibilityRespondsToUserInteraction && !t.contains(.staticText) && !t.contains(.header))
      let inChrome = chrome.contains { inside(f, $0.0) }
      var e: [String: Any] = ["label": obj.accessibilityLabel ?? "", "rect": arr(f), "interactive": interactive, "chrome": inChrome,
                              "text": t.contains(.staticText) || t.contains(.header), "traits": traitNames(t), "state": state]
      if let v = obj.accessibilityValue, !v.isEmpty { e["value"] = v }
      if let id = (obj as? UIAccessibilityIdentification)?.accessibilityIdentifier, !id.isEmpty { e["id"] = id; if id.hasPrefix("chrome") { e["chrome"] = true } }
      if let l = obj as? UILabel, l.numberOfLines == 1, l.intrinsicContentSize.width > l.bounds.width + 0.5 { e["truncated"] = true }
      elements.append(e)
    }
    let s = window.safeAreaInsets
    return ["name": tag.map { "\(name)-\(state)-\($0)" } ?? "\(name)-\(state)", "source": tag == nil ? "in-app" : "in-app hosted \(tag!)",
            "screen": ["w": window.bounds.width, "h": window.bounds.height, "scale": window.screen.scale],
            "safe": ["top": s.top, "bottom": s.bottom, "left": s.left, "right": s.right],
            "elements": elements, "png": png(of: window)]
  }

  /** Depth-first over the accessibility tree: an element is recorded; a container's elements, else a view's subviews. */
  static func walk(_ obj: NSObject, depth: Int, _ visit: (NSObject) -> Void) {
    guard depth < 60 else { return }
    if let v = obj as? UIView, v.isHidden || v.alpha < 0.01 { return }
    if obj.isAccessibilityElement { visit(obj) }
    if let list = obj.accessibilityElements as? [NSObject], !list.isEmpty {
      for c in list { walk(c, depth: depth + 1, visit) }
      return
    }
    let n = obj.accessibilityElementCount()
    if n != NSNotFound && n > 0 {
      for i in 0..<n { if let c = obj.accessibilityElement(at: i) as? NSObject { walk(c, depth: depth + 1, visit) } }
      return
    }
    if let v = obj as? UIView, !obj.isAccessibilityElement { for c in v.subviews { walk(c, depth: depth + 1, visit) } }
  }

  /** Floating chrome: the system bars and every glass or backdrop view (iOS 26 renders Liquid Glass in such views). */
  static func chromeRects(in window: UIWindow) -> [(CGRect, String)] {
    var out: [(CGRect, String)] = []
    func go(_ v: UIView) {
      if v.isHidden || v.alpha < 0.01 { return }
      let cls = String(describing: type(of: v))
      let isBar = v is UINavigationBar || v is UITabBar || v is UIToolbar
      let isGlass = cls.localizedCaseInsensitiveContains("glass") || cls.contains("Backdrop") || (v is UIVisualEffectView && v.bounds.height < 140)
      if isBar || isGlass {
        let r = v.convert(v.bounds, to: window)
        if r.width > 20 && r.height > 20 && r.width < window.bounds.width * 0.98 + (isBar ? 100 : 0) && r.intersects(window.bounds) {
          out.append((r, cls)); return
        }
      }
      for c in v.subviews { go(c) }
    }
    go(window)
    // nested glass inside one chrome region counts once
    return out.filter { a in !out.contains { b in b.0 != a.0 && inside(a.0, b.0) } }
  }

  static func scrollToEnds(in window: UIWindow) -> [(UIScrollView, CGPoint)] {
    var saved: [(UIScrollView, CGPoint)] = []
    func go(_ v: UIView) {
      if v.isHidden { return }
      if let s = v as? UIScrollView, s.contentSize.height > s.bounds.height + 1 {
        saved.append((s, s.contentOffset))
        let maxY = s.contentSize.height - s.bounds.height + s.adjustedContentInset.bottom
        s.setContentOffset(CGPoint(x: s.contentOffset.x, y: maxY), animated: false)
      }
      for c in v.subviews { go(c) }
    }
    go(window)
    return saved
  }

  // ---- the same screen at other sizes, offscreen ---------------------------------------------------------------

  static func hosted<V: View>(_ view: V, name: String, size: Size) async -> [String: Any] {
    let scene = keyWindow()?.windowScene
    let w = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    w.frame = CGRect(x: 0, y: 0, width: size.w, height: size.h)
    w.windowLevel = .normal - 1
    let host = UIHostingController(rootView: view)
    w.rootViewController = host
    w.isHidden = false
    w.layoutIfNeeded()
    // make the insets the device's of that size (the window's own come from the phone it runs on)
    let have = w.safeAreaInsets
    host.additionalSafeAreaInsets = UIEdgeInsets(top: size.top - have.top, left: 0, bottom: size.bottom - have.bottom, right: 0)
    try? await Task.sleep(nanoseconds: 1_200_000_000)
    var d = capture(window: w, name: name, state: "rest", tag: size.tag)
    d["safe"] = ["top": size.top, "bottom": size.bottom, "left": 0, "right": 0]
    w.isHidden = true
    w.rootViewController = nil
    return d
  }

  // ---- out ----------------------------------------------------------------------------------------------------

  static func write(_ dumps: [[String: Any]]) {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("layout-audit.json")
    let doc: [String: Any] = ["made": ISO8601DateFormatter().string(from: Date()), "device": UIDevice.current.model,
                              "system": UIDevice.current.systemVersion, "dumps": dumps]
    if let data = try? JSONSerialization.data(withJSONObject: doc) {
      try? data.write(to: url)
      log.notice("layout audit: \(dumps.count, privacy: .public) captures written to \(url.path, privacy: .public)")
    }
  }

  static func png(of window: UIWindow) -> String {
    let f = UIGraphicsImageRendererFormat()
    f.scale = window.screen.scale
    let img = UIGraphicsImageRenderer(bounds: window.bounds, format: f).image { _ in
      if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: UIGraphicsGetCurrentContext()!) }
    }
    return img.pngData()?.base64EncodedString() ?? ""
  }
  static func arr(_ r: CGRect) -> [Double] { [Double(r.minX), Double(r.minY), Double(r.width), Double(r.height)] }
  static func inside(_ a: CGRect, _ b: CGRect) -> Bool {
    let i = a.intersection(b)
    return !i.isNull && i.width * i.height >= 0.8 * a.width * a.height
  }
  static func traitNames(_ t: UIAccessibilityTraits) -> [String] {
    let all: [(UIAccessibilityTraits, String)] = [(.button, "button"), (.link, "link"), (.header, "header"), (.staticText, "text"), (.image, "image"),
                                                  (.selected, "selected"), (.adjustable, "adjustable"), (.searchField, "search"), (.notEnabled, "disabled"), (.tabBar, "tabbar")]
    return all.filter { t.contains($0.0) }.map { $0.1 }
  }
}
#endif
