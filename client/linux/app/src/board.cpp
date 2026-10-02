#include "board.h"

#include "secrets.h"

#include <QClipboard>
#include <QDateTime>
#include <QFile>
#include <QGuiApplication>

using namespace trommi;

static double nowMs() { return double(QDateTime::currentMSecsSinceEpoch()); }

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

    m_undoTimer.setSingleShot(true);
    m_undoTimer.setInterval(10000);
    connect(&m_undoTimer, &QTimer::timeout, this, [this] {
        m_undo.clear();
        emit undoChanged();
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
    m_later.clear();
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
    rebuild();
    setPhase("link");
}

void Board::retry() { m_client.retryNow(); }

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
    // Cards that are gone need not be remembered as put off.
    QStringList later;
    for (const QString &id : m_later)
        if (const Card *c = m_state.card(id); c && c->open()) later.append(id);
    m_later = later;
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
        }
        out.append(m);
    }
    return out;
}

QVariantMap Board::cardMap(const Card &c, bool full) const
{
    const Agent *a = m_state.agent(c.agent);
    QVariantMap m;
    m["id"] = c.id;
    m["number"] = c.number;
    m["permission"] = c.permission();
    m["urgency"] = urgencyName(c.urgency);
    m["tab"] = c.permission() ? QStringLiteral("Approval") : urgencyLabel(c.urgency);
    m["reason"] = c.urgencyReason;
    m["title"] = c.title;
    m["ago"] = ago(c.created, nowMs());
    m["agent"] = c.agent;
    m["agentName"] = a ? a->name : c.agent;
    m["vip"] = a && a->starred;
    m["quick"] = isQuick(c);
    m["bare"] = isBare(c);
    m["busy"] = m_busy.contains(c.id);
    m["open"] = c.open();
    QStringList rest;
    if (!c.urgencyReason.isEmpty()) rest.append(c.urgencyReason);
    if (const QString p = plain(c.body); !p.isEmpty()) rest.append(p);
    m["excerpt"] = rest.join(QStringLiteral(" · "));
    const qsizetype files = c.attachments.size();
    m["attachments"] = files == 0 ? QString() : files == 1 ? QStringLiteral("1 attachment") : QStringLiteral("%1 attachments").arg(files);
    QVariantList ts;
    const bool off = m_later.contains(c.id);
    m["later"] = off;
    for (const Tile &t : tiles(c, off))
        ts.append(QVariantMap{{"key", t.key}, {"label", t.label}, {"icon", t.icon}, {"lead", t.lead}, {"answer", t.answer}, {"advised", t.advised}});
    m["tiles"] = ts;
    if (full) {
        m["blocks"] = blocks(c.body);
        const int yes = isQuick(c) ? yesIndex(c) : -1;
        QVariantList options;
        for (int i = 0; i < c.options.size(); i++) {
            const Option &o = c.options[i];
            options.append(QVariantMap{{"key", o.key}, {"label", o.label}, {"detail", o.detail}, {"lead", i == yes}, {"advised", o.key == c.recommended}});
        }
        m["options"] = options;
        m["yes"] = yes >= 0 ? c.options[yes].key : QString();
        // The "no" of a yes/no question: the other of the two.
        QString no;
        if (isQuick(c) && c.options.size() == 2)
            no = c.options[yes == 0 ? 1 : 0].key;
        m["no"] = no;
        m["position"] = m_order.indexOf(c.id) + 1;
        m["total"] = m_order.size();
    }
    return m;
}

void Board::rebuild()
{
    m_before = m_order;
    m_order.clear();
    m_inbox.clear();
    for (const Group &g : groups(m_state, m_later)) {
        m_inbox.append(QVariantMap{
            {"head", true},
            {"later", g.later},
            {"name", g.agent.starred ? QStringLiteral("★ ") + g.agent.name : g.agent.name},
            {"initial", g.later ? QStringLiteral("↓") : g.agent.name.left(1).toUpper()},
            {"count", g.later ? QStringLiteral("%1 put off").arg(g.cards.size()) : questions(int(g.cards.size()))},
        });
        for (const Card &c : g.cards) {
            QVariantMap row = cardMap(c, false);
            row["head"] = false;
            // Under "Later" a row says who asked, since it no longer stands under its sender.
            row["from"] = g.later ? row.value("agentName").toString() : QString();
            m_inbox.append(row);
            m_order.append(c.id);
        }
    }
    m_sessions.clear();
    for (const Agent &a : m_state.agents) m_sessions.append(session(a.id));
    m_rev++;
    emit changed();
}

QVariantMap Board::card(const QString &id) const
{
    const Card *c = m_state.card(id);
    return c ? cardMap(*c, true) : QVariantMap();
}

QString Board::nextAfter(const QString &id) const { return nextCard(id, m_before, m_order); }

QVariantMap Board::session(const QString &agent) const
{
    const Agent *a = m_state.agent(agent);
    if (!a) return {};
    QVariantList tasks;
    for (const Task &t : m_state.tasks)
        if (t.agent == a->id) tasks.append(QVariantMap{{"label", t.label}, {"state", t.state}, {"detail", t.detail}});
    QString last;
    for (auto it = m_state.messages.crbegin(); it != m_state.messages.crend(); ++it)
        if (it->agent == a->id && it->from != "event") {
            last = plain(it->text).left(120);
            break;
        }
    return {
        {"id", a->id}, {"name", a->name}, {"starred", a->starred}, {"online", a->online}, {"cwd", a->cwd},
        {"model", a->model}, {"task", a->task}, {"open", trommi::openCount(m_state, a->id)}, {"tasks", tasks}, {"last", last},
    };
}

QVariantList Board::conversation(const QString &agent) const
{
    QVariantList out;
    for (const Message &msg : m_state.messages) {
        if (msg.agent != agent) continue;
        QVariantMap m;
        m["id"] = msg.id;
        m["from"] = msg.from;
        m["time"] = clock(msg.ts);
        const qsizetype files = msg.attachments.size();
        m["attachments"] = files == 0 ? QString() : files == 1 ? QStringLiteral("1 attachment") : QStringLiteral("%1 attachments").arg(files);
        if (msg.from == "event") {
            const Card *c = m_state.card(msg.cardId);
            m["label"] = eventLabel(msg.kind);
            m["text"] = msg.text;
            m["cardId"] = c && c->open() ? c->id : QString();
            m["urgency"] = c ? urgencyName(c->urgency) : QStringLiteral("normal");
            m["number"] = c ? c->number : 0;
        } else {
            m["blocks"] = blocks(msg.text);
            m["details"] = msg.details.isEmpty() ? QVariantList() : blocks(msg.details);
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
    for (const Message &msg : m_state.messages) {
        if (msg.agent != agent) continue;
        count++;
        last = msg.id + QString::number(msg.text.size());
        if (msg.from == "event")
            if (const Card *c = m_state.card(msg.cardId); c && c->open()) open.append(c->id);
    }
    return QStringLiteral("%1|%2|%3|%4|%5").arg(agent).arg(count).arg(last, open.join(','), m_style.codeBackground);
}

void Board::offerUndo(const Card &card, const QString &key)
{
    QString label = key;
    for (const Option &o : card.options)
        if (o.key == key) label = o.label;
    m_undo = {{"id", card.id}, {"number", card.number}, {"label", label}};
    m_undoTimer.start();
    emit undoChanged();
}

void Board::decide(const QString &id, const QString &key, const QString &note)
{
    const Card *found = m_state.card(id);
    if (!found || m_busy.contains(id)) return;
    const Card card = *found;
    m_busy.insert(id);
    rebuild();
    auto done = [this, card, key](bool ok, const QString &error) {
        m_busy.remove(card.id);
        if (!ok) {
            rebuild();
            emit failed(card.id, QStringLiteral("Not saved: %1").arg(error));
            return;
        }
        // An approval cannot be taken back: Claude Code has acted on it.
        if (!card.permission()) offerUndo(card, key);
        emit decided(card.id);
    };
    if (m_demo) {
        State s = m_state;
        for (Card &c : s.cards)
            if (c.id == id) {
                c.status = "decided";
                c.choice = key;
                c.note = note.trimmed();
            }
        s.queue = queueOf(s.cards);
        m_busy.remove(id);
        take(s);
        if (!card.permission()) offerUndo(card, key);
        emit decided(id);
        return;
    }
    m_client.decide(id, key, note.trimmed(), done);
}

void Board::undoLast()
{
    if (m_undo.isEmpty()) return;
    const QString id = m_undo.value("id").toString();
    m_undoTimer.stop();
    if (m_demo) {
        State s = m_state;
        for (Card &c : s.cards)
            if (c.id == id) {
                c.status = "open";
                c.choice.clear();
            }
        s.queue = queueOf(s.cards);
        m_undo.clear();
        emit undoChanged();
        take(s);
        emit reopened(id);
        return;
    }
    m_client.reopen(id, [this, id](bool ok, const QString &error) {
        if (ok) {
            m_undo.clear();
            emit undoChanged();
            emit reopened(id);
            return;
        }
        m_undo["error"] = QStringLiteral("Not taken back: %1").arg(error);
        m_undoTimer.start();
        emit undoChanged();
    });
}

void Board::later(const QString &id)
{
    const trommi::Card *c = m_state.card(id);
    if (!c || !c->open()) return;
    m_later.removeAll(id);
    m_later.append(id);
    rebuild();
}

void Board::putBack(const QString &id)
{
    if (m_later.removeAll(id)) rebuild();
}

void Board::send(const QString &agent, const QString &text)
{
    const QString clean = text.trimmed();
    if (clean.isEmpty()) return;
    if (m_demo) {
        State s = m_state;
        Message m;
        m.id = QStringLiteral("local-%1").arg(s.messages.size());
        m.agent = agent;
        m.from = "user";
        m.text = clean;
        m.ts = nowMs();
        s.messages.append(m);
        take(s);
        emit sent(agent);
        return;
    }
    m_client.sendMessage(clean, agent, [this, agent](bool ok, const QString &error) {
        if (ok) emit sent(agent);
        else emit sendFailed(QStringLiteral("Not sent: %1").arg(error));
    });
}

void Board::copy(const QString &text) { QGuiApplication::clipboard()->setText(text); }
