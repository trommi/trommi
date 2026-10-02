// Board is what the window knows: the server's state in the shapes the
// QML draws (rows of the inbox, the piles at its foot, a question with its
// conversation, the sessions with their marks), and everything the human
// can do. The rules themselves live in core/, without a window.
#pragma once

#include "client.h"
#include "doodle.h"
#include "logic.h"
#include "markdown.h"
#include "notifier.h"

#include <QHash>
#include <QObject>
#include <QSet>
#include <QTimer>
#include <QVariantList>
#include <QVariantMap>
#include <functional>

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
    Q_PROPERTY(QVariantList inbox READ inbox NOTIFY changed)   // headings and rows, top to bottom
    Q_PROPERTY(QVariantList piles READ piles NOTIFY changed)   // Later, With the agent, Answered
    Q_PROPERTY(QStringList order READ order NOTIFY changed)    // the walk: every open question, put off last
    Q_PROPERTY(QStringList fresh READ fresh NOTIFY changed)    // of those, what is still to be worked down
    Q_PROPERTY(int openCount READ openCount NOTIFY changed)
    Q_PROPERTY(int freshCount READ freshCount NOTIFY changed)
    Q_PROPERTY(QString waitingLine READ waitingLine NOTIFY changed)
    Q_PROPERTY(QVariantList sessions READ sessions NOTIFY changed) // one row per session or pair
    Q_PROPERTY(bool speech READ speech NOTIFY changed)
    Q_PROPERTY(QVariantMap note READ note NOTIFY noteChanged)  // what just happened, and the way back
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
    QVariantList piles() const { return m_piles; }
    QStringList order() const { return m_order; }
    QStringList fresh() const { return m_fresh; }
    int openCount() const { return int(m_order.size()); }
    int freshCount() const { return int(m_fresh.size()); }
    QString waitingLine() const { return trommi::waiting(freshCount(), int(m_order.size() - m_fresh.size())); }
    QVariantList sessions() const { return m_sessions; }
    bool speech() const { return m_view.speech; }
    QVariantMap note() const { return m_note; }
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

    // One question with all it holds: text or sections, options, the words
    // exchanged about it, the draft.
    Q_INVOKABLE QVariantMap card(const QString &id) const;
    Q_INVOKABLE QVariantMap session(const QString &agent) const;
    Q_INVOKABLE QVariantList conversation(const QString &agent) const;
    Q_INVOKABLE QString conversationStamp(const QString &agent) const;

    // The scribbles (core/doodle): { paths, rotate } in a 32 box for a
    // session's mark, in a 24 box for an icon.
    Q_INVOKABLE QVariantMap mark(const QString &seed) const;
    Q_INVOKABLE QVariantMap icon(const QString &name) const;
    Q_INVOKABLE QStringList railMark(const QString &state, bool front, const QString &seed) const;
    Q_INVOKABLE QString crown() const { return trommi::crown(); }
    Q_INVOKABLE QStringList hand() const { return trommi::raisedHand(); }
    Q_INVOKABLE QString ringLoop() const { return trommi::ringLoop(); }
    Q_INVOKABLE QString ringDrop() const { return trommi::ringDrop(); }
    Q_INVOKABLE QString adviceLoop() const { return trommi::adviceLoop(); }
    // The highlighter behind the words the agent would pick: words of this
    // width and height, standing in so many lines. { path, pen }
    Q_INVOKABLE QVariantMap adviceMark(double width, double height, int lines) const;
    Q_INVOKABLE QString groupLoop(const QString &seed) const { return trommi::groupLoop(seed); }

    // Answering. The card leaves at once and the request travels behind it;
    // if it is refused the card is back, with the reason (failed()).
    Q_INVOKABLE void decide(const QString &id, const QStringList &keys, const QString &note = {});
    Q_INVOKABLE void takeBack(const QString &id); // an answer of the "Answered" pile
    Q_INVOKABLE void later(const QString &id);    // put off: into the pile at the foot
    Q_INVOKABLE void putBack(const QString &id);  // and back under its sender
    // "Back": undo what the note says, for as long as its key works.
    Q_INVOKABLE bool backNow();
    Q_INVOKABLE void dropNote();

    // Words about a question, to its session; the card stays open.
    Q_INVOKABLE void ask(const QString &id, const QString &text);
    // "Explain": one fixed question back; the card waits with the agent and
    // returns with its reply.
    Q_INVOKABLE void explain(const QString &id);
    // "Back to agent": the session works on it (with the words, if any).
    Q_INVOKABLE void handBack(const QString &id, const QString &text = {});
    Q_INVOKABLE void saveDraft(const QString &id, const QStringList &keys, const QString &note);

    Q_INVOKABLE void send(const QString &agent, const QString &text);
    Q_INVOKABLE void star(const QString &agent, bool starred);
    Q_INVOKABLE void pair(const QString &agent, const QString &target); // lay one on another
    Q_INVOKABLE void unpair(const QString &agent);
    Q_INVOKABLE void move(const QString &agent, const QString &before); // "" for the end
    Q_INVOKABLE void openPad(); // the pad lives on the web: in the default browser
    Q_INVOKABLE void copy(const QString &text);

signals:
    void phaseChanged();
    void onlineChanged();
    void changed();
    void noteChanged();
    void activeChanged();
    void decided(const QString &id);
    void failed(const QString &id, const QString &message);
    void returned(const QString &id);  // a card is back among the open ones
    void asked(const QString &id);     // words about a card were sent
    void handed(const QString &id);    // it went to its session
    void sent(const QString &agent);
    void sendFailed(const QString &message);
    void openRequested(const QString &id); // a notification was clicked

private:
    using Undo = std::function<void()>;
    void setPhase(const QString &phase, const QString &error = {});
    void take(const trommi::State &state);
    void rebuild();
    void say(const QString &head, const QString &title, Undo back);
    void putOff(const QString &id, bool asked);
    void loadLater();
    void saveLater() const;
    QString laterFile() const;
    QVariantMap cardMap(const trommi::Card &c, bool full) const;
    QVariantMap doneMap(const trommi::Card &c) const;
    QVariantMap who(const trommi::Agent &a) const;
    QVariantList blocks(const QString &text) const;
    QString labels(const trommi::Card &c, const QStringList &keys) const;
    using Outcome = trommi::BoardClient::Outcome;

    trommi::BoardClient m_client;
    Notifier m_notifier;
    trommi::ServerLink m_link;
    trommi::State m_state;  // as the server sent it
    trommi::State m_view;   // the same with the answers that are on their way
    trommi::HtmlStyle m_style;
    QString m_phase = "link", m_error, m_kept;
    bool m_loaded = false, m_demo = false, m_active = true;
    int m_rev = 0;
    QList<trommi::PutOff> m_later;  // cards put off, in the order they were put off
    QStringList m_order, m_fresh;
    QVariantList m_inbox, m_piles, m_sessions;
    QHash<QString, QStringList> m_answering; // answers on their way: card id, keys
    QSet<QString> m_reopen;     // of those, the ones to take back as soon as they arrived
    QHash<QString, double> m_fetched; // cards fetched back from their session here: id, the with_agent it had
    QVariantMap m_note;
    Undo m_back;
    double m_backUntil = 0;
    QTimer m_noteTimer, m_tick;
    mutable QHash<QString, QVariantMap> m_marks;
};
