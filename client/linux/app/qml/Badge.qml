// The badge at the end of a session's row carries its state: a raised hand
// in a loop drawn by hand when it is stopped waiting for the human, a calm
// ring with a drop going round and the number of questions while it works,
// and the number alone, in grey, when the session is disconnected.
import QtQuick

Item {
    id: b
    property string state: ""     // "", waiting, running, open
    property int count: 0
    property bool offline: false
    visible: state !== ""
    width: ui.px(32)
    height: ui.px(32)

    readonly property color ink: offline ? ui.faint : state === "waiting" ? ui.urgCritical : ui.accent

    // waiting: the hand
    Scribble {
        visible: b.state === "waiting"
        anchors.fill: parent
        path: visible ? board.hand()[0] : ""
        color: b.ink
        fill: b.offline ? ui.sunken : ui.urgCriticalSoft
        pen: 1.5
    }
    Scribble {
        visible: b.state === "waiting"
        anchors.fill: parent
        path: visible ? board.hand()[1] : ""
        color: b.ink
        pen: 1.45
    }

    // running: the ring, and the drop that travels through it
    Scribble {
        visible: b.state === "running"
        anchors.fill: parent
        path: visible ? board.ringLoop() : ""
        color: b.ink
        fill: ui.accentSoft
        pen: 1.5
    }
    Scribble {
        id: drop
        visible: b.state === "running"
        anchors.fill: parent
        path: visible ? board.ringDrop() : ""
        color: "transparent"
        fill: b.ink
        pen: 0
        RotationAnimation on rotation { running: drop.visible && win.active; from: 0; to: 360; duration: 4600; loops: Animation.Infinite }
    }

    // open, and nobody there: the number on a grey ground
    Rectangle {
        visible: b.state === "open"
        anchors.fill: parent
        radius: height / 2
        color: ui.sunken
    }
    Text {
        visible: b.state !== "waiting" && b.count > 0
        anchors.centerIn: parent
        text: b.count
        color: b.offline ? ui.faint : ui.fg
        font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.Bold }
    }
}
