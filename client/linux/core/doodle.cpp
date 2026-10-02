#include "doodle.h"

#include <QPair>
#include <QPointF>
#include <cmath>
#include <functional>

namespace trommi {

namespace {

struct Stroke {
    bool straight; // keeps its corners; any other is drawn in one curve
    QList<QPointF> points;
};
using Points = QList<QPointF>;

#include "doodle_data.inc"

const double pi = 3.141592653589793;

// Number.prototype.toFixed. Qt prints with the same routine as V8 (double-conversion):
// the exact value, a tie away from zero. Only a negative zero is spelled differently.
QString fx(double v, int digits = 1)
{
    return QString::number(v == 0 ? 0.0 : v, 'f', digits);
}

// A smooth line through points, the way a pen moves: quadratic curves between midpoints.
QString penPath(Points p, bool closed = false)
{
    if (closed) {
        const QPointF first = p[0], second = p[1];
        p.append(first);
        p.append(second);
    }
    QString d = QStringLiteral("M%1 %2").arg(fx(p[0].x()), fx(p[0].y()));
    for (qsizetype i = 1; i < p.size() - 1; i++) {
        const double mx = (p[i].x() + p[i + 1].x()) / 2, my = (p[i].y() + p[i + 1].y()) / 2;
        d += QStringLiteral(" Q%1 %2 %3 %4").arg(fx(p[i].x()), fx(p[i].y()), fx(mx), fx(my));
    }
    if (!closed) d += QStringLiteral(" L%1 %2").arg(fx(p.last().x()), fx(p.last().y()));
    return d;
}

QString linePath(const Points &p)
{
    QStringList parts;
    for (const QPointF &q : p) parts.append(fx(q.x()) + ' ' + fx(q.y()));
    return 'M' + parts.join(QStringLiteral(" L"));
}

// The eight kinds of scribble, in the order of DOODLES in ui.js. Every
// r() is a statement of its own: the web calls them left to right.
QStringList burst(Pen &r)
{
    const int n = 6 + int(std::floor(r() * 4));
    const double turn = r() * pi;
    QStringList out;
    for (int i = 0; i < n; i++) {
        const double a = turn + (double(i) / n) * pi * 2 + (r() - .5) * .25;
        const double len = 7 + r() * 6;
        const double from = 1.5 + r() * 2;
        out.append(QStringLiteral("M%1 %2 L%3 %4").arg(fx(16 + std::cos(a) * from), fx(16 + std::sin(a) * from), fx(16 + std::cos(a) * len), fx(16 + std::sin(a) * len)));
    }
    return out;
}

QStringList spiral(Pen &r)
{
    const double turns = 2.2 + r() * 1.2;
    const double start = r() * 6;
    Points p;
    for (int i = 0; i < 34; i++) {
        const double t = i / 33.0, a = start + t * turns * pi * 2;
        const double rad = 1.5 + t * 11 + (r() - .5) * 1.1;
        p.append({16 + std::cos(a) * rad, 16 + std::sin(a) * rad});
    }
    return {penPath(p)};
}

QStringList blob(Pen &r)
{
    QStringList out;
    for (int pass = 0; pass < 2; pass++) {
        Points p;
        for (int i = 0; i < 9; i++) {
            const double a = (i / 9.0) * pi * 2 + pass * .4;
            const double rad = 9.5 + (r() - .5) * 4 - pass * 1.5;
            p.append({16 + std::cos(a) * rad, 16 + std::sin(a) * rad * .9});
        }
        out.append(penPath(p, true));
    }
    return out;
}

QStringList flower(Pen &r)
{
    const int n = 4 + int(std::floor(r() * 3));
    const double turn = r() * pi;
    QStringList out;
    for (int i = 0; i < n; i++) {
        const double a = turn + (double(i) / n) * pi * 2;
        const double w = .42 + r() * .12;
        const double len = 10.5 + r() * 2.5;
        const QPointF tip(16 + std::cos(a) * len, 16 + std::sin(a) * len);
        const QPointF l(16 + std::cos(a - w) * len * .72, 16 + std::sin(a - w) * len * .72);
        const QPointF rr(16 + std::cos(a + w) * len * .72, 16 + std::sin(a + w) * len * .72);
        out.append(penPath({{16, 16}, l, tip, rr, {16, 16}}));
    }
    return out;
}

QStringList waves(Pen &r)
{
    QStringList out;
    for (double y : {9.0, 16.0, 23.0}) {
        Points p;
        for (int i = 0; i < 7; i++) p.append({4.0 + i * 4, y + (i % 2 ? -2.6 : 2.6) + (r() - .5) * 1.6});
        out.append(penPath(p));
    }
    return out;
}

QStringList knot(Pen &r)
{
    const int a = 2 + int(std::floor(r() * 2)), b = 3;
    const double phase = r() * 3;
    Points p;
    for (int i = 0; i < 40; i++) {
        const double t = (i / 39.0) * pi * 2;
        const double x = 16 + std::sin(a * t + phase) * 11 + (r() - .5) * .8;
        const double y = 16 + std::sin(b * t) * 10 + (r() - .5) * .8;
        p.append({x, y});
    }
    return {penPath(p)};
}

QStringList bolt(Pen &r)
{
    Points p;
    for (int i = 0; i < 6; i++) p.append({8 + (i % 2) * 12 + (r() - .5) * 5, 4 + i * 4.8});
    const double left = 6 + r() * 3;
    const double right = 26 - r() * 3;
    return {penPath(p), penPath({{left, 27}, {right, 27.5}})};
}

QStringList hatch(Pen &r)
{
    QStringList out;
    for (int i = 0; i < 6; i++) {
        const double x1 = 5 + i * 3.6 + r();
        const double y1 = 25 + r() * 2;
        const double x2 = 11 + i * 3.6 + r();
        const double y2 = 6 + r() * 2;
        out.append(QStringLiteral("M%1 %2 L%3 %4").arg(fx(x1), fx(y1), fx(x2), fx(y2)));
    }
    return out;
}

using Kind = QStringList (*)(Pen &);
const Kind KINDS[] = {burst, spiral, blob, flower, waves, knot, bolt, hatch};
const char *const KIND_NAMES[] = {"burst", "spiral", "blob", "flower", "waves", "knot", "bolt", "hatch"};

const QList<Stroke> *strokesOf(const QList<QPair<QString, QList<Stroke>>> &table, const QString &name)
{
    for (const auto &entry : table)
        if (entry.first == name) return &entry.second;
    return nullptr;
}

Points wobble(const Points &points, Pen &r, double by, double dx = 0, double dy = 0)
{
    Points out;
    for (const QPointF &p : points) {
        const double x = p.x() + dx + (r() - .5) * by;
        const double y = p.y() + dy + (r() - .5) * by;
        out.append({x, y});
    }
    return out;
}

double bend(double v, double power) { return (v > 0 ? 1 : v < 0 ? -1 : 0) * std::pow(std::fabs(v), power); }

} // namespace

Pen::Pen(const QString &seed) : h(2166136261u)
{
    // As JavaScript walks a string: by code point, taking its first UTF-16 unit.
    for (qsizetype i = 0; i < seed.size(); i++) {
        h = (h ^ seed[i].unicode()) * 16777619u;
        if (seed[i].isHighSurrogate() && i + 1 < seed.size() && seed[i + 1].isLowSurrogate()) i++;
    }
}

double Pen::operator()()
{
    h = (h ^ (h >> 15)) * 2246822507u;
    h = (h ^ (h >> 13)) * 3266489909u;
    h ^= h >> 16;
    return h / 4294967296.0;
}

QStringList drawings()
{
    QStringList out;
    for (const char *name : KIND_NAMES) out.append(QString::fromLatin1(name));
    for (const auto &entry : NAMED) out.append(entry.first);
    return out;
}

QStringList sketches()
{
    QStringList out;
    for (const auto &entry : SKETCH) out.append(entry.first);
    return out;
}

Drawing doodle(const QString &seed)
{
    Pen r(seed);
    Drawing out;
    // /^draw:(.+)$/ : a name of at least one letter, on one line.
    const QString name = seed.startsWith(QStringLiteral("draw:")) && seed.size() > 5 && !seed.contains('\n') ? seed.mid(5) : QString();
    int kind = -1;
    for (int i = 0; i < 8; i++)
        if (!name.isEmpty() && name == QLatin1String(KIND_NAMES[i])) kind = i;
    if (kind >= 0) {
        out.paths = KINDS[kind](r);
    } else if (const QList<Stroke> *strokes = name.isEmpty() ? nullptr : strokesOf(NAMED, name)) {
        for (const Stroke &s : *strokes) {
            const Points p = wobble(s.points, r, 1.1);
            out.paths.append(s.straight ? linePath(p) : penPath(p));
        }
    } else {
        const int pick = int(std::floor(r() * 8));
        out.paths = KINDS[pick](r);
    }
    // Math.round: a half goes up; and no minus on a zero.
    out.rotate = std::floor((r() - .5) * 16 + .5) + 0.0;
    return out;
}

Drawing sketch(const QString &name)
{
    Pen r(QStringLiteral("sketch:") + name);
    Drawing out;
    out.rotate = fx((r() - .5) * 9).toDouble();
    if (const QList<Stroke> *strokes = strokesOf(SKETCH, name))
        for (const Stroke &s : *strokes) out.paths.append(penPath(wobble(s.points, r, .7)));
    return out;
}

PairDrawing pairDoodle(const QList<PairMember> &members)
{
    QStringList idList;
    for (const PairMember &m : members) idList.append(m.id);
    Pen r(idList.join('+'));
    PairDrawing out;
    const int n = int(members.size());
    const double size = n > 2 ? .56 : .68;
    for (int i = 0; i < n; i++) {
        PairDrawing::Member m;
        m.drawing = doodle(members[i].mark.isEmpty() ? members[i].id : members[i].mark);
        m.x = 4.5 + (n > 1 ? i * ((37 - 32 * size) / (n - 1)) : 0);
        m.y = (34 - 32 * size) / 2 + (i % 2 ? 2.4 : -2.2);
        m.size = size;
        m.turn = m.drawing.rotate + (i % 2 ? 9 : -7);
        m.transform = QStringLiteral("translate(%1 %2) scale(%3) rotate(%4 16 16)").arg(fx(m.x), fx(m.y), QString::number(size), QString::number(m.turn));
        out.members.append(m);
    }
    // The loop: one and a bit turns round all of them, starting and ending apart.
    const double start = r() * 6;
    const int steps = 15;
    Points p;
    for (int i = 0; i < steps; i++) {
        const double a = start + (double(i) / (steps - 2)) * pi * 2, drift = double(i) / steps * 1.6;
        const double x = 23 + std::cos(a) * (20.5 - drift + (r() - .5) * 1.4);
        const double y = 17 + std::sin(a) * (14.5 - drift + (r() - .5) * 1.4);
        p.append({x, y});
    }
    out.loop = penPath(p);
    return out;
}

QString crown() { return QString::fromLatin1(CROWN); }

QString loopPath(Pen &r, double rad, double drift, double jitter, double start)
{
    const int steps = 17;
    Points p;
    for (int i = 0; i < steps; i++) {
        const double a = start + (double(i) / (steps - 2)) * pi * 2;
        const double at = rad - (double(i) / steps) * drift + (r() - .5) * jitter;
        p.append({16 + std::cos(a) * at, 16 + std::sin(a) * at * .97});
    }
    return penPath(p);
}

QStringList raisedHand()
{
    Pen r(QStringLiteral("raised hand"));
    const QString loop = loopPath(r);
    return {loop, penPath(wobble(HAND, r, .8, 2.9, 1.9))};
}

QString ringLoop()
{
    Pen r(QStringLiteral("working ring"));
    return loopPath(r, 14.55, .5, .6, 1.1);
}

// DROP_PATH in agents.js: a bulge of liquid, round where it leads, drawn out
// into a tail behind, a little uneven on both edges.
QString ringDrop()
{
    const double c = 16, ring = 14.3, swell = 3.1, lead = 34, trail = 104, power = 1.2, tail = 2.1;
    Pen r(QStringLiteral("working drop"));
    double phase[4];
    for (double &p : phase) p = r() * 6;
    auto uneven = [&](double t, int k) { return 1 + .06 * (std::sin(3.1 * t + phase[k]) * .6 + std::sin(7.3 * t + phase[k + 1]) * .4); };
    const int steps = 96;
    auto edge = [&](int side) {
        QStringList out;
        for (int i = 0; i <= steps; i++) {
            const double deg = -trail + (trail + lead) * i / steps;
            const double t = deg * pi / 180;
            const double wave = std::pow((1 + std::cos(pi * deg / (deg < 0 ? trail : lead))) / 2, deg < 0 ? tail : power);
            const double rad = ring + side * swell * wave * (side > 0 ? 1 : .72) * uneven(t, side > 0 ? 0 : 2);
            out.append(fx(c + std::sin(t) * rad, 3) + ' ' + fx(c - std::cos(t) * rad, 3));
        }
        return out;
    };
    QStringList inner = edge(-1);
    std::reverse(inner.begin(), inner.end());
    return 'M' + edge(1).join(QStringLiteral(" L")) + QStringLiteral(" L") + inner.join(QStringLiteral(" L")) + QStringLiteral(" Z");
}

QString adviceLoop()
{
    Pen r(QStringLiteral("advice"));
    const int steps = 26;
    Points p;
    for (int i = 0; i < steps; i++) {
        const double a = 3.5 + (double(i) / (steps - 1)) * pi * 2 * 1.06;
        const double rad = 49 - (double(i) / steps) * 2.5 + (r() - .5) * 2;
        p.append({50 + bend(std::cos(a), .6) * rad, 50 + bend(std::sin(a), .6) * rad});
    }
    return penPath(p);
}

QString groupLoop(const QString &seed)
{
    Pen r(QStringLiteral("group loop:") + seed);
    const int steps = 30;
    const double start = 2.7 + r() * .5;
    Points p;
    for (int i = 0; i < steps; i++) {
        const double a = start + (double(i) / (steps - 1)) * pi * 2 * 1.07;
        const double rad = 49 - (double(i) / steps) * 3 + (r() - .5) * 1.6;
        p.append({50 + bend(std::cos(a), .42) * rad, 50 + bend(std::sin(a), .42) * rad});
    }
    return penPath(p);
}

QStringList railMark(const QString &state, bool front, const QString &seed)
{
    Pen r(QStringLiteral("rail:") + seed);
    QStringList out;
    auto j = [&r] { return (r() - .5) * 1.6; };
    if (state == QLatin1String("done")) {
        const double x1 = 9 + j();
        const double y1 = 16.5 + j();
        const double x2 = 14 + j();
        const double y2 = 22.5 + j();
        const double x3 = 24 + j();
        const double y3 = 9 + j();
        out.append(QStringLiteral("M%1 %2 L%3 %4 L%5 %6").arg(fx(x1), fx(y1), fx(x2), fx(y2), fx(x3), fx(y3)));
    } else {
        out.append(loopPath(r, state == QLatin1String("later") ? 6.6 : 5.8, .5, 1));
    }
    if (front) out.append(loopPath(r, 13.6, 1.4, 1.1));
    return out;
}

} // namespace trommi
