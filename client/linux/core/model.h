// The state the server sends over /events, decoded defensively: unknown
// fields are ignored, missing ones get the defaults the web client uses
// (client/web/js/store.js, normalize). Nothing here knows about a window.
#pragma once

#include <QByteArray>
#include <QList>
#include <QString>
#include <QStringList>

namespace trommi {

enum class Urgency { Low = 0, Normal = 1, High = 2, Critical = 3 };

int rank(Urgency u);                  // URGENCY_RANK in store.js
QString urgencyLabel(Urgency u);      // URGENCY_LABEL in ui.js
QString urgencyName(Urgency u);       // "low" … "critical", as the server spells it
Urgency urgencyFrom(const QString &name, Urgency fallback);

struct Option {
    QString key, label, detail;
    bool operator==(const Option &) const = default;
};

struct Attachment {
    QString name, url, kind; // image, video, audio, file, scribble
    bool operator==(const Attachment &) const = default;
};

struct Agent {
    QString id, name, given, cwd, model, task;
    bool online = false;
    bool starred = false;
};

struct Card {
    QString id, agent;
    int number = 0;
    QString kind = "decision";  // decision | permission
    QString status = "open";    // open | decided | done
    Urgency urgency = Urgency::Normal;
    QString urgencyReason, title, body;
    QList<Option> options;
    QList<Attachment> attachments;
    QString recommended; // the key of the option the agent would pick, or empty
    QString choice, note, summary;
    double created = 0, decided = 0; // milliseconds

    bool open() const { return status == "open"; }
    bool permission() const { return kind == "permission"; }
};

struct Message {
    QString id, agent;
    QString from;   // user | agent | event
    QString kind;   // events: asked, decided, done, urgency, reopened
    QString text, details, cardId;
    QList<Attachment> attachments;
    double ts = 0;
};

struct Task {
    QString agent, id, label, state, detail, cardId;
    double updated = 0;
};

struct State {
    QList<Agent> agents;
    QList<Message> messages;
    QList<Card> cards;
    QStringList queue; // ids of the open cards, most urgent first
    QList<Task> tasks;

    // False (with a reason in *error) only when the text is no JSON object;
    // everything inside it is taken as far as it makes sense.
    static bool decode(const QByteArray &json, State *out, QString *error = nullptr);

    const Card *card(const QString &id) const;
    const Agent *agent(const QString &id) const;
};

// The stack order of server.mjs queueOf: approvals first, then by urgency,
// then the oldest first.
QStringList queueOf(const QList<Card> &cards);

// The server's queue without ids that are no open cards, and with open cards
// it forgot appended; computed here if it sent none.
QStringList repairedQueue(const QStringList *given, const QList<Card> &cards);

} // namespace trommi
