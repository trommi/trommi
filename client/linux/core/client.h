// The server over HTTP: login, the event stream with reconnect, and what
// the human can do: answer, take back, write, keep a draft, and tend the
// sessions (star, name, mark, pair, order, archive). The cookie is sent by hand on every
// request and no cookie store is used. Needs an event loop, no window.
#pragma once

#include "link.h"
#include "model.h"

#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QPointer>
#include <QTimer>
#include <functional>

class QNetworkReply;

namespace trommi {

class BoardClient : public QObject {
    Q_OBJECT

public:
    explicit BoardClient(QObject *parent = nullptr);

    const ServerLink &link() const { return m_link; }
    const SessionCookie &cookie() const { return m_cookie; }
    bool online() const { return m_online; }
    int attempt() const { return m_attempt; }

    // Log in and hold the event stream until stop(). loggedIn() or
    // loginFailed() answers the first attempt; later losses are retried
    // silently, with backoff, and show in online().
    // patient: a server that is not reached at first is no failure either
    // (a link that worked before); only a refused token is.
    void start(const ServerLink &link, bool patient = false);
    void stop();
    // Try again now, e.g. when the window comes back to the front.
    void retryNow();

    // How a POST went. stale: the agent revised the card while the human was
    // answering (409); nothing was sent, the card has to be read again.
    struct Outcome {
        bool ok = false;
        int status = 0;
        QString error; // a sentence for the human
        bool stale = false;
    };
    using Done = std::function<void(const Outcome &)>;
    // cardId: a question back about that card instead of an answer to it.
    // turn: "handback" gives the card back to its session to be reworked,
    // "explain" asks it to explain; the card is then with the agent
    // (card.with_agent) until the session replies or rewords it.
    void sendMessage(const QString &text, const QString &agent, const QString &cardId = {}, Done done = {}, const QString &turn = {});
    // keys: one option, or several where the card allows it (multiple).
    // revised: the wording of the card the human saw (card.revised, 0 for
    // never); the server refuses an answer given to an earlier one.
    void decide(const QString &cardId, const QStringList &keys, bool multiple, const QString &note, double revised, Done done = {});
    void reopen(const QString &cardId, Done done = {});
    // What is ticked and written on an open card but not sent; always the whole draft.
    void draft(const QString &cardId, const QStringList &keys, const QString &note, Done done = {});
    void star(const QString &agent, bool starred, Done done = {});
    // label, icon, group (null takes it out), archived, before (the session it
    // is dropped in front of, null for the end): POST /session.
    void session(const QString &agent, const QJsonObject &changes, Done done = {});

signals:
    void loggedIn();
    // denied: the server refused the token (401); otherwise it was not reached.
    void loginFailed(const QString &message, bool denied);
    // Not reached, trying again by itself (only before the first login).
    void retrying(const QString &message);
    void state(const trommi::State &state);
    void onlineChanged(bool online);

private:
    void login();
    void listen();
    void lost(bool denied);
    void setOnline(bool online);
    void post(const QString &path, const QJsonObject &body, Done done);
    QNetworkRequest request(const QString &path) const;

    QNetworkAccessManager m_net;
    ServerLink m_link;
    SessionCookie m_cookie;
    SseParser m_parser;
    QPointer<QNetworkReply> m_stream;
    QPointer<QNetworkReply> m_login;
    QTimer m_retry;
    bool m_running = false;
    bool m_online = false;
    bool m_everIn = false; // the first login was answered
    bool m_patient = false;
    int m_attempt = 0;
};

} // namespace trommi

Q_DECLARE_METATYPE(trommi::State)
