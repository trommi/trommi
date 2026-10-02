// The link the human pastes, the cookie the server hands out for it, the
// event stream's framing and where the link is kept when there is no
// keyring. Follows client/ios/Trommi/Core/Login.swift and SSEParser.swift.
#pragma once

#include <QByteArray>
#include <QList>
#include <QString>
#include <QStringList>
#include <QUrl>

namespace trommi {

struct ServerLink {
    QUrl base;      // scheme, host and port only
    QString token;

    bool valid() const { return base.isValid() && !base.host().isEmpty() && !token.isEmpty(); }

    // Reads "http://host:8790/?t=TOKEN"; a missing scheme is taken as http,
    // and trommi://host:8790/?t=TOKEN (a desktop deep link) likewise.
    // Returns false with a German reason.
    static bool parse(const QString &input, ServerLink *out, QString *error = nullptr);

    QString origin() const;               // what a POST's Origin must be: scheme://host[:port]
    QUrl loginUrl() const;                // the address that sets the cookie
    QUrl url(const QString &path) const;  // a path on this server
    QString text() const;                 // the link as pasted, to keep
    QString address() const;              // host[:port], to show
};

struct SessionCookie {
    QString name, value;
    QByteArray header() const { return (name + "=" + value).toUtf8(); }

    // Every cookie of a Set-Cookie header; several may arrive joined with
    // commas, and "Expires=Wed, 21 Oct …" has a comma too.
    static QList<SessionCookie> parse(const QString &setCookie);

    // The cookie the server set for the login. Its name depends on the port
    // (board_8790): the one that carries the token, else one whose name
    // starts with "board", else board=<token>.
    static SessionCookie from(const QString &setCookie, const QString &token);
};

// Server-sent events: feed it what arrived, get the data of every event
// that this completed.
class SseParser {
public:
    QList<QByteArray> feed(const QByteArray &chunk);
    void reset();

private:
    QByteArray m_buffer;
    QList<QByteArray> m_data;
};

// Seconds before the n-th reconnect: 1, 2, 4, 8, 15, 15, …
double backoffDelay(int attempt);
// The same with up to a quarter added by chance (unit in 0…1), so several
// clients do not return in step.
double backoffDelay(int attempt, double unit);

// The link in a file only its owner can read (0600), for desktops without
// a Secret Service.
namespace LinkFile {
bool save(const QString &path, const QString &link);
QString load(const QString &path);
bool remove(const QString &path);
}

} // namespace trommi
