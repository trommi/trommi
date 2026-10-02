// The server over HTTP: login, the event stream with reconnect, and the
// three things the human can do. The cookie is sent by hand on every
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

    using Done = std::function<void(bool ok, const QString &error)>;
    void sendMessage(const QString &text, const QString &agent, Done done = {});
    void decide(const QString &cardId, const QString &key, const QString &note, Done done = {});
    void reopen(const QString &cardId, Done done = {});

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
