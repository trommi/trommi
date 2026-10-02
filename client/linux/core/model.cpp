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

// A list of keys, whatever the server made of it: one string is a list of one.
static QStringList strings(const QJsonValue &v)
{
    QStringList out;
    if (v.isString() && !v.toString().isEmpty()) out.append(v.toString());
    for (const QJsonValue &item : v.toArray())
        if (item.isString() && !item.toString().isEmpty()) out.append(item.toString());
    return out;
}

// Notes on single options, in the order of the options; empty ones dropped.
static QList<QPair<QString, QString>> notes(const QJsonValue &v, const QList<Option> &options)
{
    QList<QPair<QString, QString>> out;
    const QJsonObject o = v.toObject();
    for (const Option &opt : options) {
        const QString text = o.value(opt.key).toString().trimmed();
        if (!text.isEmpty()) out.append({opt.key, text});
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
    QList<Agent> everyone;
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
        a.host = str(o, "host");
        a.online = flag(o, "online");
        a.starred = flag(o, "starred");
        a.archived = flag(o, "archived");
        a.group = str(o, "group");
        const QString icon = str(o, "icon");
        a.mark = icon.isEmpty() ? a.id : icon;
        a.joined = num(o, "joined");
        a.connected = num(o, "connected");
        a.seen = num(o, "seen");
        everyone.append(a);
    }
    // Older servers send no agents.
    if (everyone.isEmpty()) {
        Agent a;
        a.id = a.mark = "main";
        a.name = a.given = "Agent";
        a.online = true;
        everyone.append(a);
    }
    const QString fallback = everyone.first().id;
    QSet<QString> gone;
    for (const Agent &a : everyone) {
        if (a.archived) gone.insert(a.id);
        (a.archived ? s.archived : s.agents).append(a);
    }
    // A group is two or more sessions that are still here; one alone is just a session.
    for (const Agent &a : s.agents) {
        if (a.group.isEmpty()) continue;
        auto it = std::find_if(s.groups.begin(), s.groups.end(), [&](const AgentGroup &g) { return g.id == a.group; });
        if (it == s.groups.end()) s.groups.append({a.group, {a.id}});
        else it->members.append(a.id);
    }
    s.groups.removeIf([](const AgentGroup &g) { return g.members.size() < 2; });
    for (Agent &a : s.agents)
        if (!a.group.isEmpty() && !s.group(a.group)) a.group.clear();
    s.speech = flag(root, "speech");

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
        auto has = [&c](const QString &key) {
            return std::any_of(c.options.begin(), c.options.end(), [&](const Option &opt) { return opt.key == key; });
        };
        c.multiple = flag(o, "multiple");
        // One key or a list of them; advice for an option that is not there is no advice.
        for (const QString &key : strings(o.value("recommended")))
            if (has(key) && !c.recommended.contains(key)) c.recommended.append(key);
        c.attachments = attachments(o.value("attachments"));
        c.choice = str(o, "choice");
        c.choices = strings(o.value("choices"));
        if (c.choices.isEmpty() && !c.choice.isEmpty()) c.choices.append(c.choice);
        if (c.choice.isEmpty() && !c.choices.isEmpty()) c.choice = c.choices.first();
        c.note = str(o, "note");
        c.optionNotes = notes(o.value("option_notes"), c.options);
        c.summary = str(o, "summary");
        c.created = num(o, "created");
        c.decided = num(o, "decided");
        c.revised = num(o, "revised");
        c.mergedFrom = strings(o.value("merged_from"));
        c.version = std::max(1, int(num(o, "version", num(o, "revisions") + 1)));
        c.earlier = int(o.value("versions").toArray().size());
        c.revisionNote = str(o, "revision_note");
        c.withAgent = c.open() ? num(o, "with_agent") : 0;
        for (const QJsonValue &sv : o.value("sections").toArray()) {
            const QJsonObject so = sv.toObject();
            Section sec;
            sec.key = str(so, "key");
            sec.text = str(so, "text");
            if (sec.flagged()) {
                if (!has(sec.key)) continue; // an option the card does not have
                sec.label = str(so, "label", sec.key);
                sec.recommended = c.advised(sec.key) || flag(so, "recommended");
                const QJsonValue pic = so.value("picture");
                if (pic.isDouble() && pic.toInt(-1) >= 0 && pic.toInt() < c.attachments.size()) sec.picture = pic.toInt();
            } else if (sec.text.trimmed().isEmpty()) {
                continue;
            }
            c.sections.append(sec);
        }
        if (o.value("draft").isObject()) {
            const QJsonObject d = o.value("draft").toObject();
            for (const QString &key : strings(d.value("keys")))
                if (has(key)) c.draft.keys.append(key);
            c.draft.note = str(d, "note");
            c.draft.notes = notes(d.value("notes"), c.options);
            c.draft.ts = num(d, "ts");
        }
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
        if (o.value("asset").isObject()) {
            const QJsonObject a = o.value("asset").toObject();
            m.assetId = str(a, "id");
            m.assetType = str(a, "type");
            m.assetTitle = str(a, "title");
            m.assetGone = flag(a, "gone");
        }
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
    // What an archived session asked waits with it, out of the way.
    s.queue.removeIf([&](const QString &id) {
        const Card *c = s.card(id);
        return c && gone.contains(c->agent);
    });

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
    for (const Agent &a : archived)
        if (a.id == id) return &a;
    return nullptr;
}

const AgentGroup *State::group(const QString &id) const
{
    for (const AgentGroup &g : groups)
        if (g.id == id) return &g;
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
