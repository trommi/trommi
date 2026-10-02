// The hand-drawn marks: a scribble per session, the drawings a session can
// be given by name, the sketched icons, the crown, the raised hand and the
// loops. A port of doodle(), pairDoodle(), sketch() and their kin in
// client/web/js/ui.js: the same seed gives the same strokes here as on the
// web and on iOS (tests/fixtures/doodles.json holds what the web draws).
// Everything is an SVG path in a small box, drawn by whoever has a pen.
#pragma once

#include <QList>
#include <QRectF>
#include <QString>
#include <QStringList>

namespace trommi {

// The seeded generator of ui.js: the same text, the same numbers.
class Pen {
public:
    explicit Pen(const QString &seed);
    double operator()();

private:
    quint32 h;
};

struct Drawing {
    double rotate = 0;  // degrees, about the middle of the box
    QStringList paths;  // SVG path data
};

// A session's mark in a 32 box. "draw:<name>" gives that named drawing.
Drawing doodle(const QString &seed);
// The names a session's mark can be given: forty drawings.
QStringList drawings();

// An icon drawn like the marks, in a 24 box: yes, no, later, back, choose,
// explain, send, reverse, go, unfold, whenever, archive, key, …
Drawing sketch(const QString &name);
QStringList sketches();

// Several sessions scribbled together as one mark, in a 46 by 34 box.
struct PairMember {
    QString id, mark;
};
struct PairDrawing {
    struct Member {
        Drawing drawing;      // in its own 32 box
        double x = 0, y = 0;  // where that box stands
        double size = 1;      // and how large
        double turn = 0;      // degrees about (16, 16), instead of drawing.rotate
        QString transform;    // the same as the web writes it
    };
    QList<Member> members;
    QString loop; // circled by hand round all of them
};
PairDrawing pairDoodle(const QList<PairMember> &members);

// The crown of a session that matters most, in a 26 by 19 box.
QString crown();
// A session that waits for the human: [0] the loop, [1] the hand, 32 box.
QStringList raisedHand();
// A circle drawn by hand in a 32 box: one and a bit turns, it does not close.
QString loopPath(Pen &pen, double rad = 14.9, double drift = 1.1, double jitter = .9, double start = 3.6);
// The loop of the working ring, and the drop that travels through it.
QString ringLoop();
QString ringDrop();
// The mark of the agent's advice: a swipe of a highlighter behind the words
// of the option it would pick, one pass per line of the label, a little
// uneven. lines: the box of each line of words, in pixels; the strokes come
// back in the same pixels, each with the width of its pen.
struct MarkerStroke {
    QString path;
    double width = 0;
};
QList<MarkerStroke> adviceMarker(const QList<QRectF> &lines);
// A squarish loop drawn by hand, in a 100 box to be stretched round
// something (the web's advice mark before the highlighter; here it circles
// the count of the inbox).
QString adviceLoop();
// The loop round a group of sessions, in a 100 box to be stretched.
QString groupLoop(const QString &seed);
// A mark of the Focus rail in a 32 box: "done" a tick, "later" a hollow
// dot, else a dot; front adds the ring round it.
QStringList railMark(const QString &state, bool front, const QString &seed);

} // namespace trommi
