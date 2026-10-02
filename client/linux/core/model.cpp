#include "model.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <algorithm>

namespace trommi {

int rank(Urgency u) { return int(u); }

QString urgencyLabel(Urgency u)
{
    switch (u) {
    case Urgency::Low: return QStringLiteral("whenever");
    case Urgency::Normal: return {}; // the usual case needs no word
    case Urgency::High: return QStringLiteral("Urgent");
    case Urgency::Critical: return QStringLiteral("Blocking");
    }
    return {};
}

QString urgencyName(Urgency u)
{
    switch (u) {
    case Urgency::Low: return QStringLiteral("low");
    case Urgency::Normal: return QStringLiteral("normal");
    case Urgency::High: return QStringLiteral("high");
    case Urgency::Critical: return QStringLiteral("critical");
    }
    return {};
}

Urgency urgencyFrom(const QString &name, Urgency fallback)
{
    if (name == "low") return Urgency::Low;
    if (name == "normal") return Urgency::Normal;
    if (name == "high") return Urgency::High;
    if (name == "critical") return Urgency::Critical;
    return fallback;
}

// A field as text, whatever the server made of it: a number or a boolean
// is spelled out, anything else is the fallback.
static QString str(const QJsonObject &o, const char *key, const QString &fallback = {})
{
    const QJsonValue v = o.value(QLatin1String(key));
    if (v.isString()) return v.toString();
    if (v.isDouble()) {
        const double d = v.toDouble();
        return d == qint64(d) ? QString::number(qint64(d)) : QString::number(d);
    }
    if (v.isBool()) return v.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    return fallback;
}

static double num(const QJsonObject &o, const char *key, double fallback = 0)
{
    const QJsonValue v = o.value(QLatin1String(key));
    if (v.isDouble()) return v.toDouble();
    if (v.isString()) {
        bool ok = false;
        const double d = v.toString().toDouble(&ok);
        if (ok) return d;
    }
    return fallback;
}

static bool flag(const QJsonObject &o, const char *key)
{
    const QJsonValue v = o.value(QLatin1String(key));
    if (v.isBool()) return v.toBool();
    if (v.isDouble()) return v.toDouble() != 0;
    if (v.isString()) return v.toString() == "true";
    return false;
}

static QList<Attachment> attachments(const QJsonValue &v)
{
    QList<Attachment> out;
    for (const QJsonValue &item : v.toArray()) {
        const QJsonObject o = item.toObject();
        Attachment a;
        a.url = str(o, "url");
        if (a.url.isEmpty()) continue;
        a.name = str(o, "name", a.url.section('/', -1));
        // Older servers only say image yes/no; newer ones name the kind.
        a.kind = str(o, "kind", flag(o, "image") ? QStringLiteral("image") : QStringLiteral("file"));
        out.append(a);
    }
    return out;
}

bool State::decode(const QByteArray &json, State *out, QString *error)
{
    QJsonParseError pe;
    const QJsonDocument doc = QJsonDocument::fromJson(json, &pe);
    if (!doc.isObject()) {
        if (error) *error = pe.error != QJsonParseError::NoError ? pe.errorString() : QStringLiteral("not a JSON object");
        return false;
    }
    const QJsonObject root = doc.object();
    State s;

    QSet<QString> seen;
    for (const QJsonValue &item : root.value("agents").toArray()) {
        const QJsonObject o = item.toObject();
        Agent a;
        a.id = str(o, "id");
        if (a.id.isEmpty() || seen.contains(a.id)) continue;
        seen.insert(a.id);
        a.given = str(o, "name", a.id);
        // The human may have renamed the session; views only see the result.
        const QString label = str(o, "label");
        a.name = label.isEmpty() ? a.given : label;
        a.cwd = str(o, "cwd");
        a.model = str(o, "model");
        a.task = str(o, "task");
        a.online = flag(o, "online");
        a.starred = flag(o, "starred");
        s.agents.append(a);
    }
    // Older servers send no agents.
    if (s.agents.isEmpty()) {
        Agent a;
        a.id = "main";
        a.name = a.given = "Agent";
        a.online = true;
        s.agents.append(a);
    }
    const QString fallback = s.agents.first().id;

    seen.clear();
    int index = 0;
    for (const QJsonValue &item : root.value("cards").toArray()) {
        index++;
        const QJsonObject o = item.toObject();
        Card c;
        c.id = str(o, "id");
        if (c.id.isEmpty() || seen.contains(c.id)) continue;
        seen.insert(c.id);
        c.agent = str(o, "agent", fallback);
        if (c.agent.isEmpty()) c.agent = fallback;
        c.number = int(num(o, "number", index));
        c.kind = str(o, "kind") == "permission" ? QStringLiteral("permission") : QStringLiteral("decision");
        c.status = str(o, "status", "open");
        c.urgency = urgencyFrom(str(o, "urgency"), c.permission() ? Urgency::Critical : Urgency::Normal);
        c.urgencyReason = str(o, "urgency_reason");
        c.title = str(o, "title");
        c.body = str(o, "body");
        for (const QJsonValue &ov : o.value("options").toArray()) {
            const QJsonObject oo = ov.toObject();
            Option opt;
            opt.key = str(oo, "key");
            if (opt.key.isEmpty()) continue;
            opt.label = str(oo, "label", opt.key);
            if (opt.label.isEmpty()) opt.label = opt.key;
            opt.detail = str(oo, "detail");
            c.options.append(opt);
        }
        // Advice for an option that is not there is no advice.
        const QString advised = str(o, "recommended");
        for (const Option &opt : c.options)
            if (opt.key == advised) c.recommended = advised;
        c.attachments = attachments(o.value("attachments"));
        c.choice = str(o, "choice");
        c.note = str(o, "note");
        c.summary = str(o, "summary");
        c.created = num(o, "created");
        c.decided = num(o, "decided");
        s.cards.append(c);
    }

    for (const QJsonValue &item : root.value("messages").toArray()) {
        const QJsonObject o = item.toObject();
        Message m;
        m.id = str(o, "id");
        m.agent = str(o, "agent", fallback);
        if (m.agent.isEmpty()) m.agent = fallback;
        m.from = str(o, "from", "agent");
        if (m.from != "user" && m.from != "event") m.from = "agent";
        m.kind = str(o, "kind");
        m.text = str(o, "text");
        m.details = str(o, "details");
        m.cardId = str(o, "card_id");
        m.attachments = attachments(o.value("attachments"));
        m.ts = num(o, "ts");
        s.messages.append(m);
    }

    for (const QJsonValue &item : root.value("tasks").toArray()) {
        const QJsonObject o = item.toObject();
        Task t;
        t.agent = str(o, "agent", fallback);
        t.id = str(o, "id");
        t.label = str(o, "label");
        t.state = str(o, "state", "working");
        t.detail = str(o, "detail");
        t.cardId = str(o, "card_id");
        t.updated = num(o, "updated");
        s.tasks.append(t);
    }

    if (root.value("queue").isArray()) {
        QStringList given;
        for (const QJsonValue &v : root.value("queue").toArray())
            if (v.isString()) given.append(v.toString());
        s.queue = repairedQueue(&given, s.cards);
    } else {
        s.queue = repairedQueue(nullptr, s.cards);
    }

    *out = s;
    return true;
}

const Card *State::card(const QString &id) const
{
    for (const Card &c : cards)
        if (c.id == id) return &c;
    return nullptr;
}

const Agent *State::agent(const QString &id) const
{
    for (const Agent &a : agents)
        if (a.id == id) return &a;
    return nullptr;
}

QStringList queueOf(const QList<Card> &cards)
{
    QList<const Card *> open;
    for (const Card &c : cards)
        if (c.open()) open.append(&c);
    auto r = [](const Card *c) { return c->permission() ? 4 : rank(c->urgency); };
    std::stable_sort(open.begin(), open.end(), [&](const Card *a, const Card *b) {
        if (r(a) != r(b)) return r(a) > r(b);
        if (a->created != b->created) return a->created < b->created;
        return a->number < b->number;
    });
    QStringList ids;
    for (const Card *c : open) ids.append(c->id);
    return ids;
}

QStringList repairedQueue(const QStringList *given, const QList<Card> &cards)
{
    const QStringList computed = queueOf(cards);
    if (!given) return computed;
    const QSet<QString> open(computed.begin(), computed.end());
    QSet<QString> seen;
    QStringList kept;
    for (const QString &id : *given) {
        if (!open.contains(id) || seen.contains(id)) continue;
        seen.insert(id);
        kept.append(id);
    }
    for (const QString &id : computed)
        if (!seen.contains(id)) kept.append(id);
    return kept;
}

} // namespace trommi
