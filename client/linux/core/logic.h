// What the views need worked out: the order of the inbox, which cards are
// answered in the list, the wording. Follows client/web/js/inbox.js and
// ui.js, and client/ios/Trommi/Core/BoardLogic.swift.
#pragma once

#include "model.h"

#include <QHash>
#include <QJsonObject>

namespace trommi {

// The one rule for a word under a thumb (fitsTile in inbox.js): a tile has
// room for two short lines, broken between words or after a hyphen.
bool fitsTile(const QString &label);

// quick() in inbox.js: a two-way question, answered by thumb in the list.
bool isQuick(const Card &card);

// "Choose" unfolds a card in its row; one with more than fits there (a long
// text, code, several pictures, a file, many options) opens as a window.
bool needsWindow(const Card &card);

// The option the agent leads with, the "yes": "allow" on an approval, else
// the first. -1 without options.
int yesIndex(const Card &card);

// A label that says no (NEGATIVE in inbox.js).
bool isNegative(const QString &label);

// Both labels are a bare yes/no/ok/allow/deny/ja/nein: the tiles need no words.
bool isBare(const Card &card);

// One of the answer tiles at the right edge of a row.
struct Tile {
    QString key;    // the option's key, or "open" for the wide "Choose"
    QString label;
    QString icon;   // yes, no, choose
    QString detail; // under "Choose": "3 options"
    bool lead = false;
    bool answer = false;  // pressing it decides the card
    bool advised = false; // the option the agent recommends (card.recommended)
};
// Thumb down, then thumb up, for a two-way question; else one wide "Choose".
QList<Tile> tiles(const Card &card);

// A card's number as it is written wherever a card is named: "Nr. 12".
QString cardNr(const Card &card);
// What a card says about its own history: "replaces 5 questions · revised".
QString cardNote(const Card &card);
// What "Explain" asks the session about a card (EXPLAIN_TEXT in inbox.js).
QString explainText();

// Markdown taken out, links named instead of spelled, whitespace folded:
// the excerpt in a row.
QString plain(const QString &text);

// A card the human put off ("Later"): its urgency then, and when it was
// handed to its session (asked back, Explain, "Back to agent"), 0 if not.
struct PutOff {
    QString id;
    int rank = 1;
    double asked = 0; // milliseconds
};
// Those that still hold: the card is open, the agent has not made it more
// urgent since, and its session has neither answered about it nor reworded
// it since it was asked.
QList<PutOff> keptLater(const State &state, const QList<PutOff> &later);
QStringList ids(const QList<PutOff> &later);

// The open cards in the order of the server's queue.
QList<Card> openCards(const State &state);

struct Group {
    Agent agent;
    QList<Card> cards;
};
// One group per sender, without what was put off: starred sessions first,
// then whoever has the most urgent question.
QList<Group> groups(const State &state, const QStringList &later);

// The inbox from top to bottom: the senders' groups, then the piles at its
// foot (put off, handed to the agent, answered).
struct Inbox {
    QList<Group> groups;
    QList<Card> later;    // put off, in the order they were put off
    QList<Card> asked;    // what waits for its session (card.with_agent, or handed over here)
    QList<Card> answered; // the latest answers first, at most answeredMax
    int fresh = 0;        // what is still to be worked down
};
inline constexpr int answeredMax = 40;
Inbox inboxOf(const State &state, const QList<PutOff> &later);

// The ids of the walk through the questions: the groups from top to bottom,
// then what was put off.
QStringList inboxOrder(const State &state, const QList<PutOff> &later);

// What a session, or several laid together, need from the human right now.
struct Unit {
    QString id;            // the session's id, or the group's
    QList<Agent> members;
    int open = 0;
    bool online = false;
    bool running = false;  // has work in progress
    bool stuck = false;    // something of it cannot go on without the human
    // The badge at the end of its row: "" none, "waiting" the raised hand,
    // "running" the ring with the count, "open" the count alone.
    QString badge() const;
};
// One row per session or per group, in the server's order.
QList<Unit> units(const State &state);

// Sessions that share a name get a second line that tells them apart: the
// folder, else the machine, else the id.
QHash<QString, QString> tellApart(const QList<Agent> &agents);

// Laying one session together with another (or with the group the other is
// in), and taking one out again: which session gets which group; an empty
// group means none. pair() and unpair() in store.js. newGroup: the id for a
// group that does not exist yet.
QList<QPair<QString, QString>> pairChanges(const State &state, const QString &agent, const QString &target, const QString &newGroup);
QList<QPair<QString, QString>> unpairChanges(const State &state, const QString &agent);

// A stable hue per session (hueOf in agents.js).
int hueOf(const QString &id);

// The words about a card in its session's conversation, oldest first.
QList<Message> threadOf(const State &state, const QString &cardId);

// Which card to show after `current` left the stack: the next that is still
// open, else the previous one, else none.
QString nextCard(const QString &current, const QStringList &before, const QStringList &after);

// Cards worth a notification: open, high or critical, and not so in `prev`.
QList<Card> newlyUrgent(const State &prev, const State &next);

int openCount(const State &state, const QString &agent);

QString ago(double ts, double now);           // ago() in ui.js; milliseconds
QString clock(double ts);                     // "14:05"
QString eventLabel(const QString &kind);      // EVENT_LABEL in chat.js
QString questions(int n);                     // "1 question" / "3 questions"
QString waiting(int fresh, int off = 0);      // the line beside "Inbox"; off: put off
QString translateError(const QString &text);  // the server's words, as a sentence for the human
bool isStale(const QString &serverError);     // the agent revised the card meanwhile (409)

// One line for a status bar (waybar's custom module with return-type json).
QJsonObject barStatus(const State &state, bool online);

} // namespace trommi
