// Desktop notifications over org.freedesktop.Notifications (mako, dunst,
// swaync, GNOME, KDE): one per urgent card, and a click on it comes back
// with the card's id.
#pragma once

#include <QHash>
#include <QObject>

class Notifier : public QObject {
    Q_OBJECT

public:
    explicit Notifier(QObject *parent = nullptr);

    void notify(const QString &cardId, const QString &summary, const QString &body, bool critical);
    void close(const QString &cardId); // the card was answered elsewhere

signals:
    void activated(const QString &cardId);

private slots:
    void actionInvoked(uint id, const QString &action);
    void closed(uint id, uint reason);

private:
    QHash<uint, QString> m_cards;
};
