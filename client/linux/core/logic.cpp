#include "logic.h"

#include <QDateTime>
#include <QLocale>
#include <QRegularExpression>
#include <QSet>
#include <algorithm>
#include <cmath>

namespace trommi {

bool fitsTile(const QString &label)
{
    static const QRegularExpression hyphen(QStringLiteral("-(?=\\S)"));
    static const QRegularExpression space(QStringLiteral("\\s+"));
    const int line = 14;
    int lines = 1, used = 0;
    QString text = label.trimmed();
    text.replace(hyphen, QStringLiteral("- "));
    for (const QString &word : text.split(space)) {
        const int n = int(word.size());
        if (n > line) return false;
        if (used && used + 1 + n > line) {
            lines++;
            used = n;
        } else {
            used += (used ? 1 : 0) + n;
        }
    }
    return lines <= 2;
}

bool isQuick(const Card &card)
{
    if (card.multiple) return false;
    if (card.permission()) return true;
    if (card.options.size() != 2) return false;
    for (const Option &o : card.options)
        if (!fitsTile(o.label)) return false;
    for (const Attachment &a : card.attachments)
        if (a.kind != "image") return false;
    return card.body.size() <= 240;
}

bool needsWindow(const Card &card)
{
    int images = 0;
    for (const Attachment &a : card.attachments) {
        if (a.kind != "image") return true;
        images++;
    }
    return card.body.size() > 480 || card.body.contains("```") || card.options.size() > 6 || images > 1;
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
    static const QRegularExpression re(QStringLiteral("^(yes|no|ok|okay|allow|deny|ja|nein)$"), QRegularExpression::CaseInsensitiveOption);
    if (card.options.isEmpty()) return false;
    for (const Option &o : card.options)
        if (!re.match(o.label.trimmed()).hasMatch()) return false;
    return true;
}

QList<Tile> tiles(const Card &card)
{
    QList<Tile> out;
    if (isQuick(card) && !card.options.isEmpty()) {
        const int yes = yesIndex(card);
        // Thumb down on the left, thumb up on the right, on every card.
        QList<int> order;
        for (int i = 0; i < card.options.size(); i++)
            if (i != yes) order.append(i);
        if (yes >= 0) order.append(yes);
        for (int i : order) {
            const Option &o = card.options[i];
            Tile t;
            t.key = o.key;
            t.label = o.label;
            t.detail = o.detail;
            t.lead = i == yes;
            t.answer = true;
            t.advised = card.advised(o.key);
            t.icon = t.lead ? "yes" : "no";
            out.append(t);
        }
        return out;
    }
    Tile t;
    t.key = "open";
    t.label = "Choose";
    t.icon = "choose";
    t.detail = QStringLiteral("%1 options").arg(card.options.size());
    if (card.multiple) t.detail += QStringLiteral(", several allowed");
    t.lead = true;
    out.append(t);
    return out;
}

QString cardNr(const Card &card) { return QStringLiteral("Nr. %1").arg(card.number); }

QString cardNote(const Card &card)
{
    QStringList parts;
    if (!card.mergedFrom.isEmpty()) parts.append(QStringLiteral("replaces %1 questions").arg(card.mergedFrom.size()));
    if (card.revised > 0) parts.append(QStringLiteral("revised"));
    return parts.join(QStringLiteral(" · "));
}

QString explainText()
{
    return QStringLiteral("Explain this question in more detail and in plain words: what it is about, what each option means for me, and what you would do.");
}

// A link in one line of text: never its long address, never an asset's key.
static QString tidyLinks(const QString &text)
{
    static const QRegularExpression url(QStringLiteral("`?(https?://[^\\s<>)`]+)`?"));
    static const QRegularExpression asset(QStringLiteral("/a/[A-Za-z0-9_-]{16,64}#[A-Za-z0-9_-]{43}$"));
    static const QRegularExpression lead(QStringLiteral("^https?://(www\\.)?"));
    static const QRegularExpression tail(QStringLiteral("[?#].*$"));
    QString out;
    qsizetype last = 0;
    auto it = url.globalMatch(text);
    while (it.hasNext()) {
        const auto m = it.next();
        out += text.mid(last, m.capturedStart() - last);
        QString u = m.captured(1);
        if (asset.match(u).hasMatch()) {
            out += QStringLiteral("[published link]");
        } else {
            u.remove(lead);
            u.remove(tail);
            if (u.endsWith('/')) u.chop(1);
            if (u.size() > 34) u = u.left(33) + QChar(0x2026);
            out += u;
        }
        last = m.capturedEnd();
    }
    return out + text.mid(last);
}

QString plain(const QString &text)
{
    static const QRegularExpression fence(QStringLiteral("```[\\s\\S]*?```"));
    static const QRegularExpression marks(QStringLiteral("[*`#]"));
    static const QRegularExpression space(QStringLiteral("\\s+"));
    QString t = text;
    t.replace(fence, QStringLiteral(" "));
    t = tidyLinks(t);
    t.remove(marks);
    t.replace(space, QStringLiteral(" "));
    return t.trimmed();
}

QList<PutOff> keptLater(const State &state, const QList<PutOff> &later)
{
    QList<PutOff> kept;
    for (const PutOff &e : later) {
        const Card *c = state.card(e.id);
        if (!c || !c->open() || !state.queue.contains(e.id)) continue;
        if (rank(c->urgency) > e.rank) continue; // more urgent since: it is news again
        bool answered = false;
        if (e.asked > 0) {
            if (c->revised > e.asked) answered = true;
            for (const Message &m : state.messages)
                if (m.cardId == e.id && m.from == "agent" && m.ts > e.asked) answered = true;
        }
        if (!answered) kept.append(e);
    }
    return kept;
}

QStringList ids(const QList<PutOff> &later)
{
    QStringList out;
    for (const PutOff &e : later) out.append(e.id);
    return out;
}

QList<Card> openCards(const State &state)
{
    QList<Card> open;
    for (const QString &id : state.queue)
        if (const Card *c = state.card(id); c && c->open()) open.append(*c);
    return open;
}

QList<Group> groups(const State &state, const QStringList &later)
{
    QList<Card> open;
    for (const Card &c : openCards(state))
        if (!later.contains(c.id)) open.append(c);
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
        a.id = a.name = a.given = a.mark = c.agent;
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
    return out;
}

Inbox inboxOf(const State &state, const QList<PutOff> &later)
{
    Inbox in;
    const QList<PutOff> kept = keptLater(state, later);
    // With the agent: the server says so on the card (card.with_agent), every device agrees;
    // what was handed over here counts too, for a server that does not know of it.
    QStringList away = ids(kept);
    for (const Card &c : openCards(state))
        if (c.withAgent > 0 && !away.contains(c.id)) {
            away.append(c.id);
            in.asked.append(c);
        }
    in.groups = groups(state, away);
    for (const Group &g : in.groups) in.fresh += int(g.cards.size());
    for (const PutOff &e : kept)
        if (const Card *c = state.card(e.id)) (e.asked > 0 || c->withAgent > 0 ? in.asked : in.later).append(*c);
    // What was answered, the latest first. A card the agent has closed since
    // is still listed: the server lets it be reopened.
    QSet<QString> gone;
    for (const Agent &a : state.archived) gone.insert(a.id);
    for (const Card &c : state.cards)
        if (!c.open() && !c.permission() && !c.choice.isEmpty() && !gone.contains(c.agent)) in.answered.append(c);
    std::stable_sort(in.answered.begin(), in.answered.end(), [](const Card &a, const Card &b) { return a.decided > b.decided; });
    if (in.answered.size() > answeredMax) in.answered.resize(answeredMax);
    return in;
}

QStringList inboxOrder(const State &state, const QList<PutOff> &later)
{
    const Inbox in = inboxOf(state, later);
    QStringList out;
    for (const Group &g : in.groups)
        for (const Card &c : g.cards) out.append(c.id);
    for (const Card &c : in.later) out.append(c.id);
    return out;
}

QString Unit::badge() const
{
    if (!open && !(online && running)) return {};
    const bool hand = online ? stuck || !running : stuck;
    if (hand) return QStringLiteral("waiting");
    return online ? QStringLiteral("running") : QStringLiteral("open");
}

QList<Unit> units(const State &state)
{
    QList<Unit> out;
    for (const Agent &a : state.agents) {
        const AgentGroup *g = a.group.isEmpty() ? nullptr : state.group(a.group);
        if (!g) {
            out.append(Unit{a.id, {a}});
            continue;
        }
        if (std::any_of(out.begin(), out.end(), [&](const Unit &u) { return u.id == g->id; })) continue;
        Unit u{g->id, {}};
        for (const QString &id : g->members)
            if (const Agent *m = state.agent(id)) u.members.append(*m);
        out.append(u);
    }
    for (Unit &u : out) {
        for (const Agent &a : u.members) {
            if (a.online) u.online = true;
            for (const Task &t : state.tasks)
                if (a.online && t.agent == a.id && t.state == "working") u.running = true;
            for (const Card &c : state.cards) {
                if (c.agent != a.id || !c.open() || !state.queue.contains(c.id)) continue;
                u.open++;
                if (c.permission() || c.urgency == Urgency::Critical) u.stuck = true;
            }
        }
    }
    return out;
}

QHash<QString, QString> tellApart(const QList<Agent> &agents)
{
    QHash<QString, QString> lines;
    QHash<QString, QList<Agent>> byName;
    for (const Agent &a : agents) byName[a.name].append(a);
    auto folder = [](const Agent &a) {
        const QStringList parts = a.cwd.split('/', Qt::SkipEmptyParts);
        return QStringList(parts.mid(qMax(0, parts.size() - 2))).join('/');
    };
    auto host = [](const Agent &a) { return a.host; };
    auto id = [](const Agent &a) { return a.id; };
    for (const QList<Agent> &twins : std::as_const(byName)) {
        if (twins.size() < 2) continue;
        auto differs = [&](auto fn) {
            QSet<QString> seen;
            for (const Agent &a : twins) {
                if (fn(a).isEmpty()) return false;
                seen.insert(fn(a));
            }
            return seen.size() == twins.size();
        };
        for (const Agent &a : twins) lines.insert(a.id, differs(folder) ? folder(a) : differs(host) ? host(a) : id(a));
    }
    return lines;
}

QList<QPair<QString, QString>> pairChanges(const State &state, const QString &agent, const QString &target, const QString &newGroup)
{
    const Agent *a = state.agent(agent), *t = state.agent(target);
    if (!a || !t || a->id == t->id || a->archived || t->archived) return {};
    if (!a->group.isEmpty() && a->group == t->group) return {};
    QList<QPair<QString, QString>> out;
    // Whoever the session leaves behind alone is on its own again.
    if (const AgentGroup *g = state.group(a->group); g && g->members.size() == 2)
        for (const QString &id : g->members)
            if (id != a->id) out.append({id, QString()});
    const QString group = t->group.isEmpty() ? newGroup : t->group;
    out.append({t->id, group});
    out.append({a->id, group});
    return out;
}

QList<QPair<QString, QString>> unpairChanges(const State &state, const QString &agent)
{
    const Agent *a = state.agent(agent);
    const AgentGroup *g = a ? state.group(a->group) : nullptr;
    if (!g) return {};
    QList<QPair<QString, QString>> out;
    // A group of two dissolves.
    for (const QString &id : g->members)
        if (g->members.size() <= 2 || id == agent) out.append({id, QString()});
    return out;
}

int hueOf(const QString &id)
{
    static const int hues[] = {162, 28, 262, 205, 338, 96, 48, 232};
    quint32 h = 0;
    // As JavaScript walks a string: by code point, taking its first UTF-16 unit.
    for (qsizetype i = 0; i < id.size(); i++) {
        h = h * 31u + id[i].unicode();
        if (id[i].isHighSurrogate() && i + 1 < id.size() && id[i + 1].isLowSurrogate()) i++;
    }
    return hues[h % 8];
}

QList<Message> threadOf(const State &state, const QString &cardId)
{
    QList<Message> out;
    for (const Message &m : state.messages)
        if (m.cardId == cardId && m.from != "event") out.append(m);
    return out;
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
    if (kind == "revised") return QStringLiteral("Question revised");
    return QStringLiteral("Board");
}

QString questions(int n) { return n == 1 ? QStringLiteral("1 question") : QStringLiteral("%1 questions").arg(n); }

QString waiting(int n, int off)
{
    if (n == 0)
        return off > 0 ? QStringLiteral("Nothing new. What you put off is below.") : QStringLiteral("Nothing needs you.");
    return n == 1 ? QStringLiteral("question needs you.") : QStringLiteral("questions need you.");
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
    if (isStale(text)) return QStringLiteral("The agent revised this question while you were answering. Nothing was sent: read it again and answer once more.");
    for (const auto &[english, german] : known)
        if (text.startsWith(english)) return german;
    if (text == "forbidden") return QStringLiteral("The server refused the request.");
    return text;
}

bool isStale(const QString &serverError) { return serverError.startsWith(QStringLiteral("the agent revised this question")); }

QJsonObject barStatus(const State &state, bool online)
{
    QJsonObject o;
    if (!online) {
        o["text"] = "";
        o["tooltip"] = "Trommi: not connected";
        o["class"] = "offline";
        return o;
    }
    const QList<Card> open = openCards(state);
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
