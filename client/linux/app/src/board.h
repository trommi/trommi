// Board is what the window knows: the server's state in the shapes the
// QML draws (rows of the inbox, a card, a conversation), and everything
// the human can do. The rules themselves live in core/, without a window.
#pragma once

#include "client.h"
#include "logic.h"
#include "markdown.h"
#include "notifier.h"

#include <QObject>
#include <QSet>
#include <QTimer>
#include <QVariantList>
#include <QVariantMap>

class Board : public QObject {
    Q_OBJECT
    // "link": no board yet, ask for the link · "connecting" · "ready"
    Q_PROPERTY(QString phase READ phase NOTIFY phaseChanged)
    Q_PROPERTY(QString error READ error NOTIFY phaseChanged)
    Q_PROPERTY(QString address READ address NOTIFY phaseChanged)
    Q_PROPERTY(QString kept READ kept NOTIFY phaseChanged) // "keyring", "file" or ""
    Q_PROPERTY(bool online READ online NOTIFY onlineChanged)
    Q_PROPERTY(bool loaded READ loaded NOTIFY changed)
    Q_PROPERTY(int rev READ rev NOTIFY changed)
    Q_PROPERTY(QVariantList inbox READ inbox NOTIFY changed)
    Q_PROPERTY(QStringList order READ order NOTIFY changed)
    Q_PROPERTY(int openCount READ openCount NOTIFY changed)
    Q_PROPERTY(int freshCount READ freshCount NOTIFY changed) // open and not put off
    Q_PROPERTY(QString waitingLine READ waitingLine NOTIFY changed)
    Q_PROPERTY(QVariantList sessions READ sessions NOTIFY changed)
    Q_PROPERTY(QVariantMap undo READ undo NOTIFY undoChanged)
    Q_PROPERTY(bool active READ active WRITE setActive NOTIFY activeChanged)

public:
    explicit Board(QObject *parent = nullptr);

    QString phase() const { return m_phase; }
    QString error() const { return m_error; }
    QString address() const { return m_demo ? QStringLiteral("Demo, no server") : m_link.valid() ? m_link.address() : QString(); }
    QString kept() const { return m_kept; }
    bool online() const { return m_demo || m_client.online(); }
    bool loaded() const { return m_loaded; }
    int rev() const { return m_rev; }
    QVariantList inbox() const { return m_inbox; }
    QStringList order() const { return m_order; }
    int openCount() const { return int(m_order.size()); }
    int freshCount() const { return int(m_order.size() - m_later.size()); }
    QString waitingLine() const { return trommi::waiting(freshCount(), int(m_later.size())); }
    QVariantList sessions() const { return m_sessions; }
    QVariantMap undo() const { return m_undo; }
    bool active() const { return m_active; }
    void setActive(bool active);

    // The link kept from the last start, if any; false if there is none.
    bool startFromKept();
    // A state from a file instead of a server, for screenshots and trying
    // the window out: answers change it here and go nowhere.
    bool startDemo(const QString &file);

    // The colours the markdown is drawn in follow the theme.
    Q_INVOKABLE void setMarkup(const QString &mono, const QString &codeBackground, const QString &link);

    // kept: the link worked before, so an unreachable server is waited for.
    Q_INVOKABLE void connectTo(const QString &link, bool kept = false);
    Q_INVOKABLE void forget(); // drop the kept link and ask again
    Q_INVOKABLE void retry();

    Q_INVOKABLE QVariantMap card(const QString &id) const;
    Q_INVOKABLE QString nextAfter(const QString &id) const;
    Q_INVOKABLE bool busy(const QString &id) const { return m_busy.contains(id); }
    Q_INVOKABLE QVariantMap session(const QString &agent) const;
    Q_INVOKABLE QVariantList conversation(const QString &agent) const;
    Q_INVOKABLE QString conversationStamp(const QString &agent) const;

    Q_INVOKABLE void decide(const QString &id, const QString &key, const QString &note = {});
    Q_INVOKABLE void undoLast();
    Q_INVOKABLE void later(const QString &id);   // put off: into the group at the end
    Q_INVOKABLE void putBack(const QString &id); // and back under its sender
    Q_INVOKABLE void send(const QString &agent, const QString &text);
    Q_INVOKABLE void copy(const QString &text);

signals:
    void phaseChanged();
    void onlineChanged();
    void changed();
    void undoChanged();
    void activeChanged();
    void decided(const QString &id);
    void failed(const QString &id, const QString &message);
    void reopened(const QString &id);
    void sent(const QString &agent);
    void sendFailed(const QString &message);
    void openRequested(const QString &id); // a notification was clicked

private:
    void setPhase(const QString &phase, const QString &error = {});
    void take(const trommi::State &state);
    void rebuild();
    QVariantMap cardMap(const trommi::Card &c, bool full) const;
    QVariantList blocks(const QString &text) const;
    void offerUndo(const trommi::Card &card, const QString &key);

    trommi::BoardClient m_client;
    Notifier m_notifier;
    trommi::ServerLink m_link;
    trommi::State m_state;
    trommi::HtmlStyle m_style;
    QString m_phase = "link", m_error, m_kept;
    bool m_loaded = false, m_demo = false, m_active = true;
    int m_rev = 0;
    QStringList m_later;        // cards put off, in the order they were put off
    QStringList m_order;        // the inbox from top to bottom
    QStringList m_before;       // the same, one state earlier
    QVariantList m_inbox, m_sessions;
    QSet<QString> m_busy;       // cards whose answer is on its way
    QVariantMap m_undo;
    QTimer m_undoTimer, m_tick;
};
