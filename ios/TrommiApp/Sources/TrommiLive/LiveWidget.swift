// TrommiLive: the Live Activity's widget. "n agents working · m questions waiting" on the lock screen and in the Dynamic
// Island, with the drawing of the crowned session of the desk on screen. The two counts come by push from the hub
// (content-state, nothing else); the drawing from the App Group (NotifyGroup.readLive, sealed: the app writes it). A tap
// opens the app on its Desk.
import Foundation
import PushNotify
#if canImport(ActivityKit) && canImport(WidgetKit) && os(iOS)
import ActivityKit
import SwiftUI
import UIKit
import WidgetKit

@main
public struct TrommiLiveBundle: WidgetBundle {
  public init() {}
  public var body: some Widget { TrommiLiveActivity() }
}

struct TrommiLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: TrommiActivityAttributes.self) { ctx in
      LockScreenLive(counts: ctx.state)
        .activityBackgroundTint(Color(red: 0.98, green: 0.97, blue: 0.94))
        .activitySystemActionForegroundColor(.black)
        .widgetURL(URL(string: "https://app.trommi.com/"))
    } dynamicIsland: { ctx in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Crown(size: 40) }
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 2) {
            Text(working(ctx.state.working)).font(.headline)
            Text(waiting(ctx.state.waiting)).font(.subheadline).foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Crown(size: 22)
      } compactTrailing: {
        HStack(spacing: 3) {
          Text("\(ctx.state.working)").monospacedDigit()
          Image(systemName: "questionmark.bubble").font(.caption2)
          Text("\(ctx.state.waiting)").monospacedDigit()
        }
        .font(.caption.weight(.semibold))
      } minimal: {
        Text("\(ctx.state.waiting)").font(.caption.weight(.bold)).monospacedDigit()
      }
      .widgetURL(URL(string: "https://app.trommi.com/"))
    }
  }
}

func working(_ n: Int) -> String { n == 1 ? "1 agent working" : "\(n) agents working" }
func waiting(_ n: Int) -> String { n == 1 ? "1 question waiting" : "\(n) questions waiting" }

struct LockScreenLive: View {
  let counts: LiveCounts
  var body: some View {
    HStack(spacing: 14) {
      Crown(size: 44)
      VStack(alignment: .leading, spacing: 3) {
        Text(working(counts.working)).font(.headline).foregroundStyle(.black)
        Text(waiting(counts.waiting)).font(.subheadline).foregroundStyle(.black.opacity(0.65))
      }
      Spacer(minLength: 0)
      Text("Trommi").font(.caption.weight(.semibold)).foregroundStyle(.black.opacity(0.45))
    }
    .padding(16)
  }
}

/** The crowned session's drawing (a PNG the app wrote), else a bell. */
struct Crown: View {
  let size: CGFloat
  var body: some View {
    if let p = NotifyGroup.readLive()?.mark, let d = Data(base64Encoded: p), let img = UIImage(data: d) {
      Image(uiImage: img).resizable().scaledToFit().frame(width: size, height: size)
    } else {
      Image(systemName: "bell.fill").resizable().scaledToFit().frame(width: size * 0.7, height: size * 0.7).frame(width: size, height: size)
    }
  }
}
#endif
