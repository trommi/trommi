#include "board.h"

#include "secrets.h"

#include <QClipboard>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRandomGenerator>
#include <QStandardPaths>
#include <QUrlQuery>

using namespace trommi;

static double nowMs() { return double(QDateTime::currentMSecsSinceEpoch()); }

// How long the note about what just happened is shown, and how long its
// key still works (BACK_MS and BACK_KEY_MS in client/web/js/back.js).
static const int noteMs = 4000;
static const int backKeyMs = 10000;

Board::Board(QObject *parent) : QObject(parent)
{
    connect(&m_client, &BoardClient::loggedIn, this, [this] {
        // Only a link the server took is kept.
        m_kept = Secrets::store(m_link.text());
        setPhase("ready");
    });
    connect(&m_client, &BoardClient::loginFailed, this, [this](const QString &message, bool) {
        setPhase("link", message);
    });
    connect(&m_client, &BoardClient::retrying, this, [this](const QString &message) {
        if (m_phase == "connecting") setPhase("connecting", message);
    });
    connect(&m_client, &BoardClient::state, this, &Board::take);
    connect(&m_client, &BoardClient::onlineChanged, this, &Board::onlineChanged);
    connect(&m_notifier, &Notifier::activated, this, &Board::openRequested);

    m_noteTimer.setSingleShot(true);
    m_noteTimer.setInterval(noteMs);
    connect(&m_noteTimer, &QTimer::timeout, this, [this] {
        m_note.clear();
        emit noteChanged();
    });
    // "3 min ago" grows old by itself.
    m_tick.setInterval(30000);
    connect(&m_tick, &QTimer::timeout, this, [this] {
        if (m_loaded) rebuild();
    });
    m_tick.start();
}

void Board::setPhase(const QString &phase, const QString &error)
{
    m_phase = phase;
    m_error = error;
    emit phaseChanged();
}

void Board::setActive(bool active)
{
    if (m_active == active) return;
    m_active = active;
    emit activeChanged();
    // Back in front: do not wait out the backoff.
    if (active && m_phase == "ready" && !m_demo) m_client.retryNow();
}

bool Board::startFromKept()
{
    const QString link = Secrets::load();
    if (link.isEmpty()) return false;
    connectTo(link, true);
    return m_phase != "link";
}

bool Board::startDemo(const QString &file)
{
    QFile f(file);
    State s;
    if (!f.open(QIODevice::ReadOnly) || !State::decode(f.readAll(), &s)) return false;
    // The file's times are moved so that its latest moment was a minute ago.
    double latest = 0;
    for (const Card &c : s.cards) latest = std::max({latest, c.created, c.decided, c.revised});
    for (const Message &m : s.messages) latest = std::max(latest, m.ts);
    const double by = latest > 0 ? nowMs() - 60000 - latest : 0;
    auto shift = [by](double &t) { if (t > 0) t += by; };
    for (Card &c : s.cards) { shift(c.created); shift(c.decided); shift(c.revised); shift(c.draft.ts); }
    for (Message &m : s.messages) shift(m.ts);
    for (Task &t : s.tasks) shift(t.updated);
    m_demo = true;
    m_phase = "ready";
    emit phaseChanged();
    emit onlineChanged();
    take(s);
    return true;
}

void Board::setMarkup(const QString &mono, const QString &codeBackground, const QString &link)
{
    m_style.monoFamily = mono;
    m_style.codeBackground = codeBackground;
    m_style.linkColor = link;
    if (m_loaded) rebuild();
}

void Board::connectTo(const QString &text, bool kept)
{
    ServerLink link;
    QString error;
    if (!ServerLink::parse(text, &link, &error)) {
        setPhase("link", error);
        return;
    }
    m_link = link;
    m_loaded = false;
    m_state = State();
    m_answering.clear();
    m_reopen.clear();
    loadLater();
    setPhase("connecting");
    m_client.start(link, kept);
}

void Board::forget()
{
    m_client.stop();
    Secrets::clear();
    m_link = ServerLink();
    m_kept.clear();
    m_loaded = false;
    m_state = State();
    m_later.clear();
    rebuild();
    setPhase("link");
}

void Board::retry() { m_client.retryNow(); }

// ── what was put off, kept across starts (the web keeps it in the browser) ──

QString Board::laterFile() const
{
    // Demos and screenshots stand alone and leave nothing behind.
    if (m_demo || !m_link.valid() || qEnvironmentVariableIsSet("TROMMI_SHOT")) return {};
    return QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation) + "/later.json";
}

void Board::loadLater()
{
    m_later.clear();
    QFile f(laterFile());
    if (f.fileName().isEmpty() || !f.open(QIODevice::ReadOnly)) return;
    for (const QJsonValue &v : QJsonDocument::fromJson(f.readAll()).object().value(m_link.address()).toArray()) {
        const QJsonArray e = v.toArray();
        if (e.at(0).isString()) m_later.append({e.at(0).toString(), e.at(1).toInt(1), e.at(2).toDouble()});
    }
}

void Board::saveLater() const
{
    const QString path = laterFile();
    if (path.isEmpty()) return;
    QJsonObject all;
    if (QFile f(path); f.open(QIODevice::ReadOnly)) all = QJsonDocument::fromJson(f.readAll()).object();
    QJsonArray list;
    for (const PutOff &e : m_later) list.append(QJsonArray{e.id, e.rank, e.asked});
    all[m_link.address()] = list;
    QDir().mkpath(QFileInfo(path).absolutePath());
    if (QFile f(path); f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.write(QJsonDocument(all).toJson(QJsonDocument::Compact));
}

void Board::take(const State &state)
{
    // Only what arrives after the first state is news.
    if (m_loaded && !m_active) {
        for (const Card &c : newlyUrgent(m_state, state)) {
            const Agent *a = state.agent(c.agent);
            const QString who = a ? a->name + " · " : QString();
            const QString label = c.permission() ? QStringLiteral("Approval") : urgencyLabel(c.urgency);
            m_notifier.notify(c.id, c.title, QStringLiteral("%1%2%3").arg(who, label, c.urgencyReason.isEmpty() ? QString() : "\n" + c.urgencyReason),
                              c.urgency == Urgency::Critical);
        }
    }
    // A card answered here or elsewhere needs its notification no longer.
    for (const Card &c : state.cards)
        if (!c.open()) m_notifier.close(c.id);
    m_state = state;
    m_loaded = true;
    // An answer the server has taken is the server's from here on; one that
    // was to be taken back as soon as it arrived is taken back now.
    const QStringList sent = m_answering.keys();
    for (const QString &id : sent) {
        const Card *c = m_state.card(id);
        if (c && c->open()) continue;
        m_answering.remove(id);
        if (c && m_reopen.remove(id)) takeBack(id);
    }
    rebuild();
}

QVariantList Board::blocks(const QString &text) const
{
    QVariantList out;
    for (const Block &b : parseMarkdown(text)) {
        QVariantMap m;
        switch (b.kind) {
        case Block::Paragraph:
            m["kind"] = "p";
            m["html"] = toHtml(b.inlines, m_style);
            break;
        case Block::Bullets: {
            QStringList items;
            for (const auto &item : b.items) items.append(toHtml(item, m_style));
            m["kind"] = "ul";
            m["items"] = items;
            break;
        }
        case Block::CodeBlock:
            m["kind"] = "code";
            m["text"] = b.code;
            break;
        case Block::Table: {
            QVariantList rows;
            for (const auto &row : b.rows) {
                QStringList cells;
                for (const auto &cell : row) cells.append(toHtml(cell, m_style));
                rows.append(QVariant(cells));
            }
            m["kind"] = "table";
            m["rows"] = rows;
            break;
        }
        }
        out.append(m);
    }
    return out;
}

QVariantMap Board::mark(const QString &seed) const
{
    const QString key = "m:" + seed;
    if (!m_marks.contains(key)) {
        const Drawing d = doodle(seed);
        m_marks.insert(key, {{"paths", d.paths}, {"rotate", d.rotate}});
    }
    return m_marks.value(key);
}

QVariantMap Board::icon(const QString &name) const
{
    const QString key = "i:" + name;
    if (!m_marks.contains(key)) {
        const Drawing d = sketch(name);
        m_marks.insert(key, {{"paths", d.paths}, {"rotate", d.rotate}});
    }
    return m_marks.value(key);
}

QVariantMap Board::adviceMark(double width, double height, int lines) const
{
    if (width <= 0 || height <= 0) return {};
    const int n = qMax(1, lines);
    QList<QRectF> boxes;
    for (int i = 0; i < n; i++) boxes.append(QRectF(0, i * height / n, width, height / n));
    QStringList paths;
    double pen = 0;
    for (const MarkerStroke &s : adviceMarker(boxes)) {
        paths.append(s.path);
        pen = s.width;
    }
    return {{"path", paths.join(' ')}, {"pen", pen}};
}

QStringList Board::railMark(const QString &state, bool front, const QString &seed) const { return trommi::railMark(state, front, seed); }

// Who asked: the name, the scribble and its hue, and whether it wears the crown.
QVariantMap Board::who(const Agent &a) const
{
    return {{"id", a.id}, {"name", a.name}, {"mark", mark(a.mark.isEmpty() ? a.id : a.mark)}, {"hue", hueOf(a.id)}, {"vip", a.starred}, {"online", a.online}};
}

QString Board::labels(const Card &c, const QStringList &keys) const
{
    QStringList out;
    for (const Option &o : c.options)
        if (keys.contains(o.key)) out.append(o.label);
    return out.isEmpty() ? keys.join(QStringLiteral(", ")) : out.join(QStringLiteral(", "));
}

QVariantMap Board::cardMap(const Card &c, bool full) const
{
    const Agent *a = m_view.agent(c.agent);
    Agent unknown;
    unknown.id = unknown.name = unknown.mark = c.agent;
    const bool blocking = c.permission() || c.urgency == Urgency::Critical;
    QVariantMap m;
    m["id"] = c.id;
    m["number"] = c.number;
    m["nr"] = cardNr(c);
    m["permission"] = c.permission();
    m["urgency"] = urgencyName(c.urgency);
    // Only what stands out gets a tab: blocking, or urgent. What can wait a small hourglass.
    m["tab"] = blocking ? (c.permission() ? QStringLiteral("Blocking · Permission") : QStringLiteral("Blocking"))
             : c.urgency == Urgency::High ? QStringLiteral("Urgent") : QString();
    m["whenever"] = !blocking && c.urgency == Urgency::Low;
    m["reason"] = c.urgencyReason;
    m["title"] = c.title;
    m["ago"] = ago(c.created, nowMs());
    m["agent"] = c.agent;
    m["agentName"] = a ? a->name : c.agent;
    m["who"] = who(a ? *a : unknown);
    m["quick"] = isQuick(c);
    m["bare"] = isBare(c);
    m["window"] = needsWindow(c);
    m["multiple"] = c.multiple;
    m["revised"] = c.revised;
    // Under the title: what the card says of itself, why it is urgent, then its text.
    QStringList about;
    if (const QString n = cardNote(c); !n.isEmpty()) about.append(n);
    if (!c.urgencyReason.isEmpty()) about.append(c.urgencyReason);
    m["about"] = about.join(QStringLiteral(" · "));
    m["excerpt"] = plain(c.body);
    int images = 0;
    for (const Attachment &at : c.attachments)
        if (at.kind == "image") images++;
    m["images"] = images;
    const qsizetype files = c.attachments.size();
    m["attachments"] = files == 0 ? QString() : files == 1 ? QStringLiteral("1 attachment") : QStringLiteral("%1 attachments").arg(files);
    bool off = c.withAgent > 0, handed = c.withAgent > 0;
    for (const PutOff &e : m_later)
        if (e.id == c.id) {
            off = true;
            handed = handed || e.asked > 0;
        }
    m["later"] = off;
    m["handed"] = handed;
    QVariantList ts;
    for (const Tile &t : tiles(c))
        ts.append(QVariantMap{{"key", t.key}, {"label", t.label}, {"icon", t.icon}, {"detail", t.detail}, {"lead", t.lead}, {"answer", t.answer}, {"advised", t.advised}});
    m["tiles"] = ts;
    const int yes = isQuick(c) ? yesIndex(c) : -1;
    QVariantList options;
    bool shortLabels = true;
    for (int i = 0; i < c.options.size(); i++) {
        const Option &o = c.options[i];
        QString note;
        for (const auto &[key, text] : c.draft.notes)
            if (key == o.key) note = text;
        if (o.label.trimmed().size() > 18) shortLabels = false;
        options.append(QVariantMap{{"key", o.key}, {"label", o.label}, {"detail", o.detail}, {"lead", i == yes}, {"advised", c.advised(o.key)}, {"note", note}});
    }
    m["options"] = options;
    // Many short options stand as small tags (TAGS_FROM, TAG_CHARS in focus.js).
    m["tags"] = !isQuick(c) && c.options.size() >= 7 && shortLabels;
    m["blocks"] = blocks(c.body);
    if (!full) return m;

    m["yes"] = yes >= 0 ? c.options[yes].key : QString();
    // The "no" of a two-way question: the other of the two.
    m["no"] = isQuick(c) && c.options.size() == 2 ? c.options[yes == 0 ? 1 : 0].key : QString();
    QVariantList sections;
    for (const Section &s : c.sections) {
        QVariantMap sm{{"key", s.key}, {"label", s.label}, {"blocks", blocks(s.text)}, {"advised", s.recommended}};
        sm["picture"] = s.picture >= 0 ? c.attachments.value(s.picture).name : QString();
        sections.append(sm);
    }
    m["sections"] = sections;
    QVariantList thread;
    for (const Message &msg : threadOf(m_view, c.id))
        thread.append(QVariantMap{{"id", msg.id}, {"mine", msg.from == "user"}, {"blocks", blocks(msg.text)}, {"time", clock(msg.ts)},
                                  {"fixed", msg.text == explainText()}});
    m["thread"] = thread;
    m["draftKeys"] = c.draft.keys;
    m["draftNote"] = c.draft.note;
    m["draftStamp"] = c.draft.ts;
    return m;
}

// An answered question, as a slim row of the "Answered" pile.
QVariantMap Board::doneMap(const Card &c) const
{
    const Agent *a = m_view.agent(c.agent);
    const bool duo = c.options.size() == 2 && !c.multiple;
    QVariantMap m;
    m["id"] = c.id;
    m["done"] = true;
    m["nr"] = cardNr(c);
    m["title"] = c.title;
    m["labels"] = labels(c, c.choices);
    // A yes or no shows its thumb; anything else the drawing of a choice.
    m["icon"] = !duo ? QStringLiteral("choose") : c.choice == c.options[0].key ? QStringLiteral("yes") : QStringLiteral("no");
    if (a) m["who"] = who(*a);
    m["ago"] = c.decided > 0 ? ago(c.decided, nowMs()) : QString();
    m["closed"] = c.status == "done";
    return m;
}

void Board::rebuild()
{
    // The answers on their way are answers already, as far as the eye goes.
    m_view = m_state;
    for (auto it = m_answering.cbegin(); it != m_answering.cend(); ++it)
        for (Card &c : m_view.cards) {
            if (c.id != it.key() || !c.open()) continue;
            c.status = "decided";
            c.choices = it.value();
            c.choice = it.value().value(0);
            c.decided = nowMs();
            m_view.queue.removeAll(c.id);
        }
    // "Back" on a card that is with its session: here it counts as fetched, until it is handed over anew.
    for (Card &c : m_view.cards)
        if (c.withAgent > 0 && m_fetched.value(c.id) == c.withAgent) c.withAgent = 0;
    if (m_loaded) {
        const QList<PutOff> kept = keptLater(m_view, m_later);
        // What only waits for its own answer to arrive is not forgotten for that.
        QList<PutOff> keep;
        for (const PutOff &e : m_later)
            if (m_answering.contains(e.id) || std::any_of(kept.begin(), kept.end(), [&](const PutOff &k) { return k.id == e.id; })) keep.append(e);
        if (keep.size() != m_later.size()) {
            m_later = keep;
            saveLater();
        }
    }
    const Inbox in = inboxOf(m_view, m_later);

    m_fresh.clear();
    m_inbox.clear();
    for (const Group &g : in.groups) {
        QVariantMap head = who(g.agent);
        head["head"] = true;
        head["count"] = questions(int(g.cards.size()));
        m_inbox.append(head);
        for (const Card &c : g.cards) {
            QVariantMap row = cardMap(c, false);
            row["head"] = false;
            m_inbox.append(row);
            m_fresh.append(c.id);
        }
    }
    m_order = m_fresh;
    for (const Card &c : in.later) m_order.append(c.id);

    // The piles at the foot: what was put off, what waits for its session, what was answered.
    m_piles.clear();
    auto offPile = [&](const QString &kind, const QString &label, const QString &icon, const QList<Card> &cards, const QString &count) {
        if (cards.isEmpty()) return;
        QVariantList rows;
        for (const Card &c : cards) {
            QVariantMap row = cardMap(c, false);
            row["head"] = false;
            row["from"] = row.value("who");
            row["tail"] = row.value("agentName").toString() + " · " + cardNr(c);
            rows.append(row);
        }
        m_piles.append(QVariantMap{{"kind", kind}, {"label", label}, {"icon", icon}, {"count", count}, {"rows", rows}});
    };
    offPile("later", "Later", "later", in.later, QStringLiteral("%1 put off").arg(in.later.size()));
    offPile("asked", "With the agent", "explain", in.asked, QStringLiteral("%1 asked").arg(in.asked.size()));
    if (!in.answered.isEmpty()) {
        QVariantList rows;
        int today = 0;
        const QDate now = QDate::currentDate();
        for (const Card &c : in.answered) {
            QVariantMap row = doneMap(c);
            row["tail"] = row.value("labels");
            rows.append(row);
            if (QDateTime::fromMSecsSinceEpoch(qint64(c.decided)).date() == now) today++;
        }
        const qsizetype n = in.answered.size();
        const QString count = today == n ? QStringLiteral("%1 today").arg(today)
                            : today ? QStringLiteral("%1 today · %2 in all").arg(today).arg(n) : QString::number(n);
        m_piles.append(QVariantMap{{"kind", "answered"}, {"label", "Answered"}, {"icon", "yes"}, {"count", count}, {"rows", rows}});
    }

    // One row per session, or per group of sessions laid together.
    m_sessions.clear();
    const QHash<QString, QString> apart = tellApart(m_view.agents);
    for (const Unit &u : units(m_view)) {
        QVariantMap m{{"id", u.id}, {"single", u.members.size() == 1}, {"open", u.open}, {"badge", u.badge()}, {"online", u.online}};
        QVariantList members;
        QStringList names, tasks;
        QList<PairMember> seeds;
        for (const Agent &a : u.members) {
            QVariantMap w = who(a);
            w["sub"] = apart.value(a.id);
            members.append(w);
            names.append(a.name);
            if (!a.task.isEmpty()) tasks.append(a.task);
            seeds.append({a.id, a.mark});
        }
        m["members"] = members;
        m["name"] = names.join(QStringLiteral(" + "));
        m["tip"] = tasks.join(QStringLiteral(" · "));
        if (u.members.size() > 1) {
            // Their scribbles over each other inside one loop drawn by hand.
            const PairDrawing p = pairDoodle(seeds);
            QVariantList marks;
            for (int i = 0; i < p.members.size(); i++) {
                const auto &pm = p.members[i];
                marks.append(QVariantMap{{"paths", pm.drawing.paths}, {"x", pm.x}, {"y", pm.y}, {"size", pm.size}, {"turn", pm.turn},
                                         {"hue", hueOf(u.members[i].id)}, {"vip", u.members[i].starred}});
            }
            QStringList idList;
            for (const Agent &a : u.members) idList.append(a.id);
            m["pair"] = QVariantMap{{"marks", marks}, {"loop", p.loop}};
        }
        m_sessions.append(m);
    }
    m_rev++;
    emit changed();
}

QVariantMap Board::card(const QString &id) const
{
    const Card *c = m_view.card(id);
    if (!c) return {};
    QVariantMap m = cardMap(*c, true);
    m["open"] = c->open();
    m["position"] = m_order.indexOf(c->id) + 1;
    m["total"] = m_order.size();
    return m;
}

QVariantMap Board::session(const QString &agent) const
{
    const Agent *a = m_view.agent(agent);
    if (!a) return {};
    QVariantList tasks;
    for (const Task &t : m_view.tasks)
        if (t.agent == a->id) tasks.append(QVariantMap{{"label", t.label}, {"state", t.state}, {"detail", t.detail}});
    QVariantMap m = who(*a);
    m["starred"] = a->starred;
    m["cwd"] = a->cwd;
    m["model"] = a->model;
    m["task"] = a->task;
    m["group"] = a->group;
    m["open"] = trommi::openCount(m_view, a->id);
    m["tasks"] = tasks;
    return m;
}

QVariantList Board::conversation(const QString &agent) const
{
    QVariantList out;
    for (const Message &msg : m_view.messages) {
        if (msg.agent != agent) continue;
        const Card *c = msg.cardId.isEmpty() ? nullptr : m_view.card(msg.cardId);
        QVariantMap m;
        m["id"] = msg.id;
        m["from"] = msg.from;
        m["time"] = clock(msg.ts);
        const qsizetype files = msg.attachments.size();
        m["attachments"] = files == 0 ? QString() : files == 1 ? QStringLiteral("1 attachment") : QStringLiteral("%1 attachments").arg(files);
        if (msg.from == "event") {
            // The marker names the question, and what was said to it.
            const bool said = msg.kind == "decided" || msg.kind == "done";
            m["label"] = eventLabel(msg.kind);
            m["kind"] = msg.kind;
            m["text"] = c && said ? c->title : msg.text;
            m["tail"] = c && said ? msg.text : QString();
            m["cardId"] = c && c->open() ? c->id : QString();
            m["urgency"] = c ? urgencyName(c->urgency) : QStringLiteral("normal");
            m["nr"] = c ? cardNr(*c) : QString();
        } else {
            m["blocks"] = blocks(msg.text);
            m["details"] = msg.details.isEmpty() ? QVariantList() : blocks(msg.details);
            // Words about a question say which one.
            m["about"] = c ? c->title : QString();
            if (!msg.assetId.isEmpty())
                m["asset"] = QVariantMap{{"title", msg.assetTitle.isEmpty() ? QStringLiteral("Untitled") : msg.assetTitle},
                                         {"type", msg.assetType == "html" ? QStringLiteral("Page") : msg.assetType == "image" ? QStringLiteral("Picture") : QStringLiteral("File")},
                                         {"gone", msg.assetGone}};
        }
        out.append(m);
    }
    return out;
}

// Changes when the conversation would be drawn differently, and only then.
QString Board::conversationStamp(const QString &agent) const
{
    int count = 0;
    QString last;
    QStringList open;
    for (const Message &msg : m_view.messages) {
        if (msg.agent != agent) continue;
        count++;
        last = msg.id + QString::number(msg.text.size());
        if (msg.from == "event")
            if (const Card *c = m_view.card(msg.cardId); c && c->open()) open.append(c->id);
    }
    return QStringLiteral("%1|%2|%3|%4|%5").arg(agent).arg(count).arg(last, open.join(','), m_style.codeBackground);
}

// In a demo the queue is worked out here, as the server would: without what
// an archived session asked.
static void requeue(State &s)
{
    s.queue = queueOf(s.cards);
    s.queue.removeIf([&](const QString &id) {
        const Card *c = s.card(id);
        return std::any_of(s.archived.begin(), s.archived.end(), [&](const Agent &a) { return c && a.id == c->agent; });
    });
}

// ── the note: what just happened, and the way back ───────────────────────

void Board::say(const QString &head, const QString &title, Undo back)
{
    m_back = back;
    m_backUntil = back ? nowMs() + backKeyMs : 0;
    m_note = {{"head", head}, {"title", title}, {"back", bool(back)}, {"stamp", nowMs()}};
    m_noteTimer.start();
    emit noteChanged();
}

bool Board::backNow()
{
    if (!m_back || nowMs() > m_backUntil) return false;
    const Undo back = m_back;
    dropNote();
    back();
    return true;
}

void Board::dropNote()
{
    m_back = nullptr;
    m_noteTimer.stop();
    if (m_note.isEmpty()) return;
    m_note.clear();
    emit noteChanged();
}

// ── answering ────────────────────────────────────────────────────────────

void Board::decide(const QString &id, const QStringList &keys, const QString &note)
{
    const Card *found = m_view.card(id);
    if (!found || !found->open() || m_answering.contains(id)) return;
    const Card card = *found;
    QStringList picked;
    for (const Option &o : card.options)
        if (keys.contains(o.key)) picked.append(o.key);
    if (picked.isEmpty()) return;
    if (!card.multiple) picked = {picked.first()};

    // The row leaves at once; the request travels behind it.
    if (m_demo) {
        for (Card &c : m_state.cards)
            if (c.id == id) {
                c.status = "decided";
                c.choices = picked;
                c.choice = picked.first();
                c.note = note.trimmed();
                c.decided = nowMs();
            }
        requeue(m_state);
    } else {
        m_answering.insert(id, picked);
    }
    rebuild();
    // An approval cannot be taken back: Claude Code has acted on it.
    say(QStringLiteral("Answered: %1").arg(labels(card, picked)), card.title, card.permission() ? Undo() : [this, id] { takeBack(id); });
    emit decided(id);
    if (m_demo) return;
    m_client.decide(id, picked, card.multiple, note.trimmed(), card.revised, [this, id](const Outcome &o) {
        if (o.ok) return; // the next state says so itself
        m_answering.remove(id);
        m_reopen.remove(id);
        dropNote();
        rebuild();
        emit failed(id, o.stale ? o.error : QStringLiteral("Not saved: %1").arg(o.error));
        emit returned(id);
    });
}

void Board::takeBack(const QString &id)
{
    // Still on its way: taken back as soon as the server has it.
    if (m_answering.contains(id)) {
        m_reopen.insert(id);
        return;
    }
    if (m_demo) {
        for (Card &c : m_state.cards)
            if (c.id == id) {
                c.status = "open";
                c.choice.clear();
                c.choices.clear();
                c.decided = 0;
            }
        requeue(m_state);
        rebuild();
        emit returned(id);
        return;
    }
    m_client.reopen(id, [this, id](const Outcome &o) {
        if (o.ok) emit returned(id);
        else emit failed(id, QStringLiteral("Not taken back: %1").arg(o.error));
    });
}

void Board::putOff(const QString &id, bool asked)
{
    const Card *c = m_view.card(id);
    if (!c || !c->open()) return;
    m_later.removeIf([&](const PutOff &e) { return e.id == id; });
    m_later.append({id, rank(c->urgency), asked ? nowMs() : 0});
    saveLater();
    rebuild();
}

void Board::later(const QString &id)
{
    const Card *c = m_view.card(id);
    if (!c || !c->open()) return;
    const QString title = c->title;
    putOff(id, false);
    say(QStringLiteral("Moved to Later"), title, [this, id] { putBack(id); });
}

void Board::putBack(const QString &id)
{
    const Card *c = m_state.card(id);
    const bool fetched = c && c->withAgent > 0 && m_fetched.value(id) != c->withAgent;
    if (fetched) m_fetched.insert(id, c->withAgent);
    if (!m_later.removeIf([&](const PutOff &e) { return e.id == id; }) && !fetched) return;
    saveLater();
    rebuild();
    emit returned(id);
}

void Board::ask(const QString &id, const QString &text)
{
    const Card *c = m_view.card(id);
    const QString clean = text.trimmed();
    if (!c || clean.isEmpty()) return;
    if (m_demo) {
        Message m;
        m.id = QStringLiteral("local-%1").arg(m_state.messages.size());
        m.agent = c->agent;
        m.from = "user";
        m.text = clean;
        m.cardId = id;
        m.ts = nowMs();
        m_state.messages.append(m);
        rebuild();
        emit asked(id);
        return;
    }
    m_client.sendMessage(clean, c->agent, id, [this, id](const Outcome &o) {
        if (o.ok) emit asked(id);
        else emit failed(id, QStringLiteral("Not sent: %1").arg(o.error));
    });
}

void Board::explain(const QString &id)
{
    const Card *c = m_view.card(id);
    if (!c || !c->open() || c->permission()) return;
    auto went = [this, id] {
        putOff(id, true);
        say(QStringLiteral("Asked to explain"), QStringLiteral("It comes back with the answer."), [this, id] { putBack(id); });
        emit handed(id);
    };
    if (m_demo) {
        ask(id, explainText());
        went();
        return;
    }
    m_client.sendMessage(explainText(), c->agent, id, [this, id, went](const Outcome &o) {
        if (o.ok) went();
        else emit failed(id, QStringLiteral("Not asked: %1").arg(o.error));
    }, QStringLiteral("explain"));
}

void Board::handBack(const QString &id, const QString &text)
{
    const Card *c = m_view.card(id);
    if (!c || !c->open() || c->permission()) return;
    auto went = [this, id] {
        putOff(id, true);
        say(QStringLiteral("With the agent"), QStringLiteral("It comes back with the reply."), [this, id] { putBack(id); });
        emit handed(id);
    };
    // The session is told with words; without any of the human's, with these.
    const QString clean = text.trimmed().isEmpty() ? QStringLiteral("Back to you: please rework this question.") : text.trimmed();
    if (m_demo) {
        ask(id, clean);
        went();
        return;
    }
    m_client.sendMessage(clean, c->agent, id, [this, id, went](const Outcome &o) {
        if (o.ok) went();
        else emit failed(id, QStringLiteral("Not handed over: %1").arg(o.error));
    }, QStringLiteral("handback"));
}

void Board::saveDraft(const QString &id, const QStringList &keys, const QString &note)
{
    const Card *c = m_view.card(id);
    if (!c || !c->open() || c->permission()) return;
    if (c->draft.keys == keys && c->draft.note == note) return;
    if (m_demo) {
        for (Card &d : m_state.cards)
            if (d.id == id) {
                d.draft.keys = keys;
                d.draft.note = note;
            }
        return;
    }
    m_client.draft(id, keys, note);
}

void Board::send(const QString &agent, const QString &text)
{
    const QString clean = text.trimmed();
    if (clean.isEmpty()) return;
    if (m_demo) {
        Message m;
        m.id = QStringLiteral("local-%1").arg(m_state.messages.size());
        m.agent = agent;
        m.from = "user";
        m.text = clean;
        m.ts = nowMs();
        m_state.messages.append(m);
        rebuild();
        emit sent(agent);
        return;
    }
    m_client.sendMessage(clean, agent, {}, [this, agent](const Outcome &o) {
        if (o.ok) emit sent(agent);
        else emit sendFailed(QStringLiteral("Not sent: %1").arg(o.error));
    });
}

// ── the sessions ─────────────────────────────────────────────────────────

void Board::star(const QString &agent, bool starred)
{
    if (m_demo) {
        for (Agent &a : m_state.agents)
            if (a.id == agent) a.starred = starred;
        rebuild();
        return;
    }
    m_client.star(agent, starred);
}

// In a demo the groups are kept here; a server sends them back with its next state.
static void regroup(State &s, const QList<QPair<QString, QString>> &changes)
{
    for (const auto &[id, group] : changes)
        for (Agent &a : s.agents)
            if (a.id == id) a.group = group;
    s.groups.clear();
    for (const Agent &a : s.agents) {
        if (a.group.isEmpty()) continue;
        auto it = std::find_if(s.groups.begin(), s.groups.end(), [&](const AgentGroup &g) { return g.id == a.group; });
        if (it == s.groups.end()) s.groups.append({a.group, {a.id}});
        else it->members.append(a.id);
    }
    s.groups.removeIf([](const AgentGroup &g) { return g.members.size() < 2; });
    for (Agent &a : s.agents)
        if (!a.group.isEmpty() && !s.group(a.group)) a.group.clear();
}

void Board::pair(const QString &agent, const QString &target)
{
    const QString fresh = QStringLiteral("g%1%2").arg(QString::number(QDateTime::currentMSecsSinceEpoch(), 36), QString::number(QRandomGenerator::global()->bounded(36 * 36 * 36 * 36), 36));
    const auto changes = pairChanges(m_state, agent, target, fresh);
    if (m_demo) {
        regroup(m_state, changes);
        rebuild();
        return;
    }
    for (const auto &[id, group] : changes)
        m_client.session(id, {{"group", group.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(group)}});
}

void Board::unpair(const QString &agent)
{
    const auto changes = unpairChanges(m_state, agent);
    if (m_demo) {
        regroup(m_state, changes);
        rebuild();
        return;
    }
    for (const auto &[id, group] : changes) m_client.session(id, {{"group", QJsonValue::Null}});
}

void Board::move(const QString &agent, const QString &before)
{
    if (agent == before) return;
    if (m_demo) {
        const auto at = std::find_if(m_state.agents.begin(), m_state.agents.end(), [&](const Agent &a) { return a.id == agent; });
        if (at == m_state.agents.end()) return;
        const Agent moved = *at;
        m_state.agents.erase(at);
        auto to = std::find_if(m_state.agents.begin(), m_state.agents.end(), [&](const Agent &a) { return a.id == before; });
        m_state.agents.insert(to, moved);
        rebuild();
        return;
    }
    m_client.session(agent, {{"before", before.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(before)}});
}

// The pad is a page of the web client (/pad); the login link takes the
// browser there and leaves the token out of the address it ends on.
void Board::openPad()
{
    if (!m_link.valid()) return;
    QUrl url = m_link.url("/pad");
    QUrlQuery q;
    q.addQueryItem("t", m_link.token);
    url.setQuery(q);
    QDesktopServices::openUrl(url);
}

void Board::copy(const QString &text) { QGuiApplication::clipboard()->setText(text); }
