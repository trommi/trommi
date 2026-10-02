// What the views need worked out: the order of the inbox, which cards are
// answered in the list, the wording. Follows client/web/js/inbox.js and
// ui.js, and client/ios/Trommi/Core/BoardLogic.swift.
#pragma once

#include "model.h"

#include <QJsonObject>

namespace trommi {

// quick() in inbox.js: a yes/no kind of question, answered in the list.
bool isQuick(const Card &card);

// The option the agent leads with, the "yes": "allow" on an approval, else
// the first. -1 without options.
int yesIndex(const Card &card);

// A label that says no (NEGATIVE in inbox.js).
bool isNegative(const QString &label);

// Both labels are a bare ja/nein/yes/no/ok: the tiles need no words.
bool isBare(const Card &card);

// One of the two tiles at the right edge of a row.
struct Tile {
    QString key;    // the option's key, or "later" / "open"
    QString label;
    QString icon;   // yes, no, other, later, open
    bool lead = false;
    bool answer = false;  // pressing it decides the card
    bool advised = false; // the option the agent recommends (card.recommended)
};
// Left tile, then right: no and yes for a quick card, else Later and Choose.
// off: the card was put off, so the left tile fetches it back ("Bring back").
QList<Tile> tiles(const Card &card, bool off = false);

// Markdown taken out and whitespace folded, for the excerpt in a row.
QString plain(const QString &text);

// The open cards in the order the human sees them: the server's queue,
// with the cards put off ("Later") at the end, in the order they were put off.
QList<Card> openCards(const State &state, const QStringList &later);

struct Group {
    Agent agent;
    QList<Card> cards;
    bool later = false; // the group of the cards put off, below all senders
};
// One group per sender: starred sessions first, then whoever has the most
// urgent question. The cards put off leave their sender's group for one
// group at the very end, in the order they were put off.
QList<Group> groups(const State &state, const QStringList &later);

// The ids of the inbox from top to bottom, as groups() lays them out.
QStringList inboxOrder(const State &state, const QStringList &later);

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
QString waiting(int fresh, int off = 0);      // the line under "Posteingang"; off: put off
QString translateError(const QString &text);  // the server's English, in German

// One line for a status bar (waybar's custom module with return-type json).
QJsonObject barStatus(const State &state, bool online);

} // namespace trommi
