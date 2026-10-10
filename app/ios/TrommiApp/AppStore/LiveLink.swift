// The Live Activity widget's executable: the widget and its @main WidgetBundle are in the TrommiApp package
// (Sources/TrommiLive); this target links it and names the bundle once, so the linker keeps it.
import TrommiLive

public let trommiLiveBundle: Any.Type = TrommiLiveBundle.self
