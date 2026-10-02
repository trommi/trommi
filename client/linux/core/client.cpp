#include "client.h"

#include "logic.h"

#include <QJsonDocument>
#include <QNetworkCookie>
#include <QNetworkCookieJar>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRandomGenerator>

namespace trommi {

// Keeps nothing and hands out nothing: the one cookie is sent by hand.
class NoCookies : public QNetworkCookieJar {
public:
    using QNetworkCookieJar::QNetworkCookieJar;
    QList<QNetworkCookie> cookiesForUrl(const QUrl &) const override { return {}; }
    bool setCookiesFromUrl(const QList<QNetworkCookie> &, const QUrl &) override { return false; }
};

BoardClient::BoardClient(QObject *parent) : QObject(parent)
{
    qRegisterMetaType<trommi::State>();
    m_net.setCookieJar(new NoCookies(&m_net));
    m_net.setRedirectPolicy(QNetworkRequest::ManualRedirectPolicy);
    m_retry.setSingleShot(true);
    connect(&m_retry, &QTimer::timeout, this, [this] {
        if (m_running) login();
    });
}

QNetworkRequest BoardClient::request(const QString &path) const
{
    QNetworkRequest req(m_link.url(path));
    req.setRawHeader("Cookie", m_cookie.header());
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    req.setAttribute(QNetworkRequest::CookieSaveControlAttribute, QNetworkRequest::Manual);
    req.setAttribute(QNetworkRequest::CookieLoadControlAttribute, QNetworkRequest::Manual);
    return req;
}

void BoardClient::start(const ServerLink &link, bool patient)
{
    stop();
    m_patient = patient;
    m_link = link;
    m_cookie = {QStringLiteral("board"), link.token};
    m_running = true;
    m_everIn = false;
    m_attempt = 0;
    login();
}

void BoardClient::stop()
{
    m_running = false;
    m_retry.stop();
    if (m_login) {
        m_login->disconnect(this);
        m_login->abort();
        m_login->deleteLater();
    }
    if (m_stream) {
        m_stream->disconnect(this);
        m_stream->abort();
        m_stream->deleteLater();
    }
    m_parser.reset();
    setOnline(false);
}

void BoardClient::retryNow()
{
    if (!m_running || m_online || m_login || m_stream) return;
    m_retry.stop();
    login();
}

void BoardClient::setOnline(bool online)
{
    if (m_online == online) return;
    m_online = online;
    emit onlineChanged(online);
}

// GET /?t=TOKEN answers 302 with the cookie. The redirect is not followed:
// the Set-Cookie of that very answer is what is wanted.
void BoardClient::login()
{
    QNetworkRequest req(m_link.loginUrl());
    req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    req.setAttribute(QNetworkRequest::CookieSaveControlAttribute, QNetworkRequest::Manual);
    req.setAttribute(QNetworkRequest::CookieLoadControlAttribute, QNetworkRequest::Manual);
    req.setTransferTimeout(10000);
    QNetworkReply *reply = m_net.get(req);
    m_login = reply;
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        m_login = nullptr;
        if (!m_running) return;
        const int code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (code == 302 || code == 303 || code == 200) {
            m_cookie = SessionCookie::from(QString::fromLatin1(reply->rawHeader("Set-Cookie")), m_link.token);
            if (!m_everIn) {
                m_everIn = true;
                emit loggedIn();
            }
            listen();
            return;
        }
        if (code == 401 || code == 403) {
            if (!m_everIn) {
                m_running = false;
                emit loginFailed(QStringLiteral("The server does not accept the token."), true);
                return;
            }
            lost(true);
            return;
        }
        if (!m_everIn && m_patient) {
            emit retrying(code ? QStringLiteral("The server answers with %1.").arg(code) : QStringLiteral("Server not reachable."));
            lost(false);
            return;
        }
        if (!m_everIn) {
            m_running = false;
            emit loginFailed(code ? QStringLiteral("The server answers with %1.").arg(code)
                                  : QStringLiteral("Server not reachable: %1").arg(reply->errorString()),
                             false);
            return;
        }
        lost(false);
    });
}

void BoardClient::listen()
{
    QNetworkRequest req = request("/events");
    req.setRawHeader("Accept", "text/event-stream");
    req.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
    req.setTransferTimeout(0); // the stream is quiet for as long as nothing happens
    m_parser.reset();
    QNetworkReply *reply = m_net.get(req);
    m_stream = reply;
    connect(reply, &QNetworkReply::readyRead, this, [this, reply] {
        const int code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (code != 200) return; // an error page, read when it has finished
        for (const QByteArray &data : m_parser.feed(reply->readAll())) {
            State s;
            // A frame that is no JSON is skipped; the next one is whole again.
            if (!State::decode(data, &s)) continue;
            m_attempt = 0;
            setOnline(true);
            emit state(s);
        }
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        m_stream = nullptr;
        if (!m_running) return;
        const int code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        lost(code == 401);
    });
}

// A lost stream is no logout: wait, then log in again (which also renews
// the cookie's name, should the server have changed).
void BoardClient::lost(bool)
{
    setOnline(false);
    if (!m_running) return;
    m_attempt++;
    const double seconds = backoffDelay(m_attempt, QRandomGenerator::global()->generateDouble());
    m_retry.start(int(seconds * 1000));
}

void BoardClient::post(const QString &path, const QJsonObject &body, Done done)
{
    if (!m_link.valid()) {
        if (done) done(false, QStringLiteral("Not connected."));
        return;
    }
    QNetworkRequest req = request(path);
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    // The server only takes a POST whose Origin is its own address.
    req.setRawHeader("Origin", m_link.origin().toUtf8());
    req.setTransferTimeout(15000);
    QNetworkReply *reply = m_net.post(req, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [reply, done] {
        reply->deleteLater();
        const int code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (code >= 200 && code < 300) {
            if (done) done(true, {});
            return;
        }
        QString error = QJsonDocument::fromJson(reply->readAll()).object().value("error").toString();
        if (error.isEmpty())
            error = code == 401 ? QStringLiteral("The login has expired.")
                  : code ? QStringLiteral("The server answers with %1.").arg(code)
                         : QStringLiteral("Server not reachable.");
        if (done) done(false, translateError(error));
    });
}

void BoardClient::sendMessage(const QString &text, const QString &agent, Done done)
{
    post("/message", {{"text", text}, {"agent", agent}}, done);
}

void BoardClient::decide(const QString &cardId, const QString &key, const QString &note, Done done)
{
    post("/decide", {{"card_id", cardId}, {"key", key}, {"note", note}}, done);
}

void BoardClient::reopen(const QString &cardId, Done done)
{
    post("/reopen", {{"card_id", cardId}}, done);
}

} // namespace trommi
