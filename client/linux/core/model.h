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
    QString id, name, given, cwd, model, task, host;
    QString mark;   // the seed of its scribble: the icon the human picked, else its id
    QString group;  // sessions that share one are laid together; empty for none
    bool online = false;
    bool starred = false;
    bool archived = false;
    double joined = 0, connected = 0, seen = 0; // milliseconds
};

// Two or more sessions the human laid together, shown as one.
struct AgentGroup {
    QString id;
    QStringList members; // session ids, in the order of the sessions
};

// A card handed in as one structured text (docs/question-contract.md): a
// plain block is a paragraph, a flagged one (with a key) is an option.
struct Section {
    QString key, label, text;
    bool recommended = false;
    int picture = -1; // index into the card's attachments, -1 for none
    bool flagged() const { return !key.isEmpty(); }
    bool operator==(const Section &) const = default;
};

// What the human ticked and wrote on an open card without sending.
struct Draft {
    QStringList keys;
    QString note;
    QList<QPair<QString, QString>> notes; // option key, text
    double ts = 0;
    bool empty() const { return keys.isEmpty() && note.isEmpty() && notes.isEmpty(); }
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
    bool multiple = false;      // several answers allowed, sent together
    QStringList recommended;    // the options the agent would pick; empty for no advice
    QString choice, note, summary;
    QStringList choices;        // what was answered; one key unless `multiple`
    QList<QPair<QString, QString>> optionNotes; // option key, the human's note on it
    QList<Section> sections;    // empty for a card filed as body plus options
    QStringList mergedFrom;     // the cards this one replaces
    Draft draft;
    double created = 0, decided = 0; // milliseconds
    double revised = 0;         // when the agent last reworded it; 0 for never
    int version = 1;            // 1 when filed, one more with every rewording
    int earlier = 0;            // how many earlier versions the card still holds
    QString revisionNote;       // the agent's note for this version
    double withAgent = 0;       // since when the card is with its session (handed back, "Explain"); 0 if not

    bool advised(const QString &key) const { return recommended.contains(key); }

    bool open() const { return status == "open"; }
    bool permission() const { return kind == "permission"; }
};

struct Message {
    QString id, agent;
    QString from;   // user | agent | event
    QString kind;   // events: asked, decided, done, urgency, reopened
    QString text, details, cardId;
    QList<Attachment> attachments;
    // Something the session published under a link of its own (empty id: none).
    QString assetId, assetType, assetTitle;
    bool assetGone = false;
    double ts = 0;
};

struct Task {
    QString agent, id, label, state, detail, cardId;
    double updated = 0;
};

struct State {
    QList<Agent> agents;      // the sessions in the human's order, without the archived ones
    QList<Agent> archived;    // sessions put away
    QList<AgentGroup> groups;
    bool speech = false;      // the server can take dictation
    QList<Message> messages;
    QList<Card> cards;
    QStringList queue; // ids of the open cards, most urgent first
    QList<Task> tasks;

    // False (with a reason in *error) only when the text is no JSON object;
    // everything inside it is taken as far as it makes sense.
    static bool decode(const QByteArray &json, State *out, QString *error = nullptr);

    const Card *card(const QString &id) const;
    const Agent *agent(const QString &id) const; // archived ones too
    const AgentGroup *group(const QString &id) const;
};

// The stack order of server.mjs queueOf: approvals first, then by urgency,
// then the oldest first.
QStringList queueOf(const QList<Card> &cards);

// The server's queue without ids that are no open cards, and with open cards
// it forgot appended; computed here if it sent none.
QStringList repairedQueue(const QStringList *given, const QList<Card> &cards);

} // namespace trommi
