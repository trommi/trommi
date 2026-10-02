#include "notifier.h"

#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QVariantMap>

static const char *service = "org.freedesktop.Notifications";
static const char *path = "/org/freedesktop/Notifications";

Notifier::Notifier(QObject *parent) : QObject(parent)
{
    auto bus = QDBusConnection::sessionBus();
    bus.connect(service, path, service, "ActionInvoked", this, SLOT(actionInvoked(uint, QString)));
    bus.connect(service, path, service, "NotificationClosed", this, SLOT(closed(uint, uint)));
}

void Notifier::notify(const QString &cardId, const QString &summary, const QString &body, bool critical)
{
    QVariantMap hints;
    hints["urgency"] = QVariant::fromValue(uchar(critical ? 2 : 1));
    hints["desktop-entry"] = QStringLiteral("trommi");
    hints["category"] = QStringLiteral("im.received");
    auto msg = QDBusMessage::createMethodCall(service, path, service, "Notify");
    msg << QStringLiteral("Trommi") << uint(0) << QStringLiteral("trommi") << summary << body
        << QStringList{"default", QStringLiteral("Open")} << hints << int(-1);
    auto *watcher = new QDBusPendingCallWatcher(QDBusConnection::sessionBus().asyncCall(msg), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, cardId](QDBusPendingCallWatcher *w) {
        const QDBusPendingReply<uint> reply = *w;
        if (reply.isValid()) m_cards.insert(reply.value(), cardId);
        w->deleteLater();
    });
}

void Notifier::close(const QString &cardId)
{
    for (auto it = m_cards.begin(); it != m_cards.end();) {
        if (it.value() != cardId) {
            ++it;
            continue;
        }
        auto msg = QDBusMessage::createMethodCall(service, path, service, "CloseNotification");
        msg << it.key();
        QDBusConnection::sessionBus().asyncCall(msg);
        it = m_cards.erase(it);
    }
}

void Notifier::actionInvoked(uint id, const QString &)
{
    if (m_cards.contains(id)) emit activated(m_cards.value(id));
}

void Notifier::closed(uint id, uint) { m_cards.remove(id); }
