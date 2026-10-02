#include "link.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QSaveFile>
#include <QUrlQuery>
#include <algorithm>
#include <cmath>

namespace trommi {

bool ServerLink::parse(const QString &input, ServerLink *out, QString *error)
{
    auto fail = [&](const QString &why) {
        if (error) *error = why;
        return false;
    };
    QString text = input.trimmed();
    if (text.isEmpty()) return fail(QStringLiteral("Paste the link from data/url.txt."));
    if (text.startsWith("trommi://", Qt::CaseInsensitive)) text = "http://" + text.mid(9);
    if (!text.contains("://")) text = "http://" + text;
    const QUrl url(text, QUrl::StrictMode);
    if (!url.isValid() || url.host().isEmpty()) return fail(QStringLiteral("That is not a link."));
    const QString scheme = url.scheme().toLower();
    if (scheme != "http" && scheme != "https") return fail(QStringLiteral("Only http and https are supported."));
    const QString token = QUrlQuery(url).queryItemValue("t", QUrl::FullyDecoded);
    if (token.isEmpty()) return fail(QStringLiteral("The link has no token (?t=…)."));
    ServerLink link;
    link.base.setScheme(scheme);
    link.base.setHost(url.host());
    link.base.setPort(url.port());
    link.token = token;
    *out = link;
    return true;
}

QString ServerLink::origin() const
{
    QString text = base.toString(QUrl::RemovePath | QUrl::RemoveQuery | QUrl::RemoveFragment | QUrl::RemoveUserInfo);
    while (text.endsWith('/')) text.chop(1);
    return text;
}

QUrl ServerLink::loginUrl() const
{
    QUrl u = base;
    u.setPath("/");
    QUrlQuery q;
    q.addQueryItem("t", QString::fromLatin1(QUrl::toPercentEncoding(token)));
    u.setQuery(q);
    return u;
}

QUrl ServerLink::url(const QString &path) const
{
    QUrl u = base;
    u.setPath(path.startsWith('/') ? path : "/" + path);
    return u;
}

QString ServerLink::text() const { return loginUrl().toString(QUrl::FullyEncoded); }

QString ServerLink::address() const
{
    return base.port() > 0 ? QStringLiteral("%1:%2").arg(base.host()).arg(base.port()) : base.host();
}

static bool startsCookie(const QString &text)
{
    const qsizetype eq = text.indexOf('=');
    if (eq < 0) return false;
    const QString name = text.left(eq).trimmed();
    if (name.isEmpty()) return false;
    return std::all_of(name.begin(), name.end(), [](QChar c) {
        return c.unicode() < 128 && (c.isLetterOrNumber() || c == '_' || c == '-' || c == '.');
    });
}

QList<SessionCookie> SessionCookie::parse(const QString &setCookie)
{
    QStringList pieces;
    for (const QString &part : setCookie.split(QRegularExpression(QStringLiteral("[,\\n]")))) {
        const QString first = part.section(';', 0, 0);
        if (startsCookie(first) || pieces.isEmpty()) pieces.append(part);
        else pieces.last() += "," + part;
    }
    QList<SessionCookie> out;
    for (const QString &piece : pieces) {
        const QString pair = piece.section(';', 0, 0);
        const qsizetype eq = pair.indexOf('=');
        if (eq < 0) continue;
        const QString name = pair.left(eq).trimmed();
        QString value = pair.mid(eq + 1).trimmed();
        if (value.size() >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.mid(1, value.size() - 2);
        if (!name.isEmpty()) out.append({name, value});
    }
    return out;
}

SessionCookie SessionCookie::from(const QString &setCookie, const QString &token)
{
    const QList<SessionCookie> cookies = parse(setCookie);
    for (const SessionCookie &c : cookies)
        if (c.value == token) return c;
    for (const SessionCookie &c : cookies)
        if (c.name.startsWith("board") && !c.value.isEmpty()) return c;
    return {QStringLiteral("board"), token};
}

QList<QByteArray> SseParser::feed(const QByteArray &chunk)
{
    m_buffer += chunk;
    QList<QByteArray> events;
    qsizetype start = 0;
    for (;;) {
        const qsizetype newline = m_buffer.indexOf('\n', start);
        if (newline < 0) break;
        qsizetype end = newline;
        if (end > start && m_buffer[end - 1] == '\r') end--;
        const QByteArray line = m_buffer.mid(start, end - start);
        start = newline + 1;
        if (line.isEmpty()) { // an empty line ends the event
            if (!m_data.isEmpty()) {
                events.append(m_data.join('\n'));
                m_data.clear();
            }
            continue;
        }
        if (line.startsWith(':')) continue; // a comment, used as a heartbeat
        const qsizetype colon = line.indexOf(':');
        const QByteArray field = colon < 0 ? line : line.left(colon);
        QByteArray value = colon < 0 ? QByteArray() : line.mid(colon + 1);
        if (value.startsWith(' ')) value.remove(0, 1);
        if (field == "data") m_data.append(value);
    }
    m_buffer.remove(0, start);
    return events;
}

void SseParser::reset()
{
    m_buffer.clear();
    m_data.clear();
}

double backoffDelay(int attempt)
{
    if (attempt <= 0) return 0;
    return std::min(15.0, std::pow(2.0, std::min(attempt, 10) - 1));
}

double backoffDelay(int attempt, double unit)
{
    return backoffDelay(attempt) * (1.0 + 0.25 * std::clamp(unit, 0.0, 1.0));
}

bool LinkFile::save(const QString &path, const QString &link)
{
    const QFileInfo info(path);
    if (!QDir().mkpath(info.absolutePath())) return false;
    QFile::setPermissions(info.absolutePath(), QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);
    // Created closed, then filled: the token is never readable by others.
    QFile f(path);
    if (f.exists() && !f.remove()) return false;
    if (!f.open(QIODevice::WriteOnly | QIODevice::NewOnly, QFile::ReadOwner | QFile::WriteOwner)) return false;
    const QByteArray data = link.toUtf8() + '\n';
    const bool ok = f.write(data) == data.size();
    f.close();
    return ok && f.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
}

QString LinkFile::load(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return {};
    return QString::fromUtf8(f.readAll()).trimmed();
}

bool LinkFile::remove(const QString &path) { return !QFile::exists(path) || QFile::remove(path); }

} // namespace trommi
