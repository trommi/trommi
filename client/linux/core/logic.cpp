#include "logic.h"

#include <QDateTime>
#include <QLocale>
#include <QRegularExpression>
#include <QSet>
#include <algorithm>
#include <cmath>

namespace trommi {

bool isQuick(const Card &card)
{
    if (card.permission()) return true;
    if (card.options.size() != 2) return false;
    for (const Option &o : card.options)
        if (o.label.size() > 18) return false;
    for (const Attachment &a : card.attachments)
        if (a.kind != "image") return false;
    return card.body.size() <= 240;
}

int yesIndex(const Card &card)
{
    if (card.options.isEmpty()) return -1;
    if (card.permission()) {
        for (int i = 0; i < card.options.size(); i++)
            if (card.options[i].key == "allow") return i;
        return -1; // an approval without "allow" has no yes
    }
    return 0;
}

bool isNegative(const QString &label)
{
    static const QRegularExpression re(
        QStringLiteral("^(no\\b|not\\b|don.t|never|later|deny|decline|reject|skip|keep|leave|cancel|only |stay|nein|nicht|noch nicht|später|ablehnen|lassen|weglassen|behalten|nur |abbrechen|bei .* bleiben)"),
        QRegularExpression::CaseInsensitiveOption | QRegularExpression::UseUnicodePropertiesOption);
    return re.match(label).hasMatch();
}

bool isBare(const Card &card)
{
    static const QRegularExpression re(QStringLiteral("^(ja|nein|yes|no|ok|okay)$"), QRegularExpression::CaseInsensitiveOption);
    if (card.options.isEmpty()) return false;
    for (const Option &o : card.options)
        if (!re.match(o.label.trimmed()).hasMatch()) return false;
    return true;
}

QList<Tile> tiles(const Card &card, bool off)
{
    QList<Tile> out;
    if (isQuick(card) && !card.options.isEmpty()) {
        const int yes = yesIndex(card);
        // No on the left, yes on the right, on every card.
        QList<int> order;
        for (int i = 0; i < card.options.size(); i++)
            if (i != yes) order.append(i);
        if (yes >= 0) order.append(yes);
        for (int i : order) {
            const Option &o = card.options[i];
            Tile t;
            t.key = o.key;
            t.label = o.label;
            t.lead = i == yes;
            t.answer = true;
            t.advised = !card.recommended.isEmpty() && o.key == card.recommended;
            t.icon = t.lead ? "yes" : (isNegative(o.label) || o.key == "deny") ? "no" : "other";
            out.append(t);
        }
        return out;
    }
    if (off) out.append({QStringLiteral("back"), QStringLiteral("Bring back"), QStringLiteral("back"), false, false, false});
    else out.append({QStringLiteral("later"), QStringLiteral("Later"), QStringLiteral("later"), false, false, false});
    out.append({QStringLiteral("open"), QStringLiteral("Choose"), QStringLiteral("open"), true, false, false});
    return out;
}

QString plain(const QString &text)
{
    static const QRegularExpression fence(QStringLiteral("```[\\s\\S]*?```"));
    static const QRegularExpression marks(QStringLiteral("[*`#]"));
    static const QRegularExpression space(QStringLiteral("\\s+"));
    QString t = text;
    t.replace(fence, QStringLiteral(" "));
    t.remove(marks);
    t.replace(space, QStringLiteral(" "));
    return t.trimmed();
}

QList<Card> openCards(const State &state, const QStringList &later)
{
    QList<Card> open;
    for (const QString &id : state.queue)
        if (const Card *c = state.card(id); c && c->open()) open.append(*c);
    // indexOf is -1 for a card not put off, so those stay in front.
    std::stable_sort(open.begin(), open.end(), [&](const Card &a, const Card &b) {
        return later.indexOf(a.id) < later.indexOf(b.id);
    });
    return open;
}

QList<Group> groups(const State &state, const QStringList &later)
{
    // What was put off stands at the end of openCards, in the order it was put off.
    QList<Card> open, off;
    for (const Card &c : openCards(state, later)) (later.contains(c.id) ? off : open).append(c);
    QList<Group> out;
    QSet<QString> known;
    for (const Agent &a : state.agents) {
        known.insert(a.id);
        Group g{a, {}};
        for (const Card &c : open)
            if (c.agent == a.id) g.cards.append(c);
        if (!g.cards.isEmpty()) out.append(g);
    }
    // A card whose sender is not in the list is still a question: it gets a
    // group under the sender's id rather than vanishing (the web client drops it).
    for (const Card &c : open) {
        if (known.contains(c.agent)) continue;
        known.insert(c.agent);
        Agent a;
        a.id = a.name = a.given = c.agent;
        Group g{a, {}};
        for (const Card &d : open)
            if (d.agent == c.agent) g.cards.append(d);
        out.append(g);
    }
    auto top = [](const Group &g) {
        int best = 0;
        for (const Card &c : g.cards) best = std::max(best, rank(c.urgency));
        return best;
    };
    std::stable_sort(out.begin(), out.end(), [&](const Group &a, const Group &b) {
        if (a.agent.starred != b.agent.starred) return a.agent.starred;
        return top(a) > top(b);
    });
    if (!off.isEmpty()) {
        Agent a;
        a.id = QStringLiteral("later");
        a.name = a.given = QStringLiteral("Later");
        out.append(Group{a, off, true});
    }
    return out;
}

QStringList inboxOrder(const State &state, const QStringList &later)
{
    QStringList ids;
    for (const Group &g : groups(state, later))
        for (const Card &c : g.cards) ids.append(c.id);
    return ids;
}

QString nextCard(const QString &current, const QStringList &before, const QStringList &after)
{
    const int at = before.indexOf(current);
    if (at < 0) return after.isEmpty() ? QString() : after.first();
    for (int i = at + 1; i < before.size(); i++)
        if (after.contains(before[i])) return before[i];
    for (int i = at - 1; i >= 0; i--)
        if (after.contains(before[i])) return before[i];
    for (const QString &id : after)
        if (id != current) return id;
    return {};
}

QList<Card> newlyUrgent(const State &prev, const State &next)
{
    QList<Card> out;
    for (const Card &c : next.cards) {
        if (!c.open() || rank(c.urgency) < rank(Urgency::High)) continue;
        const Card *was = prev.card(c.id);
        if (was && was->open() && rank(was->urgency) >= rank(Urgency::High)) continue;
        out.append(c);
    }
    return out;
}

int openCount(const State &state, const QString &agent)
{
    int n = 0;
    for (const Card &c : state.cards)
        if (c.open() && c.agent == agent) n++;
    return n;
}

QString ago(double ts, double now)
{
    const qint64 minutes = std::llround((now - ts) / 60000.0);
    if (minutes < 1) return QStringLiteral("just now");
    if (minutes < 60) return QStringLiteral("%1 min ago").arg(minutes);
    if (minutes < 1440) return QStringLiteral("%1 h ago").arg(std::llround(minutes / 60.0));
    return QLocale(QLocale::English, QLocale::UnitedKingdom).toString(QDateTime::fromMSecsSinceEpoch(qint64(ts)).date(), QStringLiteral("d MMM"));
}

QString clock(double ts)
{
    return QDateTime::fromMSecsSinceEpoch(qint64(ts)).toString(QStringLiteral("HH:mm"));
}

QString eventLabel(const QString &kind)
{
    if (kind == "asked") return QStringLiteral("New question");
    if (kind == "decided") return QStringLiteral("Answered");
    if (kind == "done") return QStringLiteral("Done");
    if (kind == "urgency") return QStringLiteral("Urgency");
    if (kind == "reopened") return QStringLiteral("Taken back");
    return QStringLiteral("Board");
}

QString questions(int n) { return n == 1 ? QStringLiteral("1 question") : QStringLiteral("%1 questions").arg(n); }

QString waiting(int n, int off)
{
    if (n == 0)
        return off > 0 ? QStringLiteral("Nothing new. What you put off is below.") : QStringLiteral("Nothing is waiting for you.");
    return n == 1 ? QStringLiteral("question is waiting for you.") : QStringLiteral("questions are waiting for you.");
}

QString translateError(const QString &text)
{
    static const QList<QPair<QString, QString>> known = {
        {"unknown card", "This question is no longer there."},
        {"card already decided", "This question is already answered."},
        {"unknown option", "There is no such answer."},
        {"only decisions can be reopened", "Only answers to questions can be taken back."},
        {"card is already open", "This question is already open."},
        {"the agent withdrew this card", "The agent withdrew this question."},
        {"empty message", "The message is empty."},
        {"no agent ", "There is no such session."},
        {"agent is required", "Pick a session first."},
    };
    for (const auto &[english, german] : known)
        if (text.startsWith(english)) return german;
    if (text == "forbidden") return QStringLiteral("The server refused the request.");
    return text;
}

QJsonObject barStatus(const State &state, bool online)
{
    QJsonObject o;
    if (!online) {
        o["text"] = "";
        o["tooltip"] = "Trommi: not connected";
        o["class"] = "offline";
        return o;
    }
    const QList<Card> open = openCards(state, {});
    int top = -1;
    QStringList lines;
    for (const Card &c : open) {
        top = std::max(top, rank(c.urgency));
        const QString label = c.permission() ? QStringLiteral("Approval") : urgencyLabel(c.urgency);
        lines.append(label.isEmpty() ? c.title : label + ": " + c.title);
    }
    o["text"] = open.isEmpty() ? QString() : QString::number(open.size());
    o["tooltip"] = open.isEmpty() ? QStringLiteral("Trommi: nothing is waiting for you") : lines.join('\n');
    o["class"] = open.isEmpty() ? QStringLiteral("empty") : urgencyName(Urgency(top));
    return o;
}

} // namespace trommi
