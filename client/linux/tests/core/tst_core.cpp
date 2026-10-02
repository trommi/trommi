// Protocol and logic, tested without a window or a server.
#include "link.h"
#include "logic.h"
#include "markdown.h"
#include "doodle.h"
#include "model.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QtTest>

using namespace trommi;

static State demo()
{
    QFile f(QStringLiteral(FIXTURES "/demo-state.json"));
    if (!f.open(QIODevice::ReadOnly)) qFatal("fixture missing");
    State s;
    QString error;
    if (!State::decode(f.readAll(), &s, &error)) qFatal("fixture does not decode: %s", qPrintable(error));
    return s;
}

static State board()
{
    QFile f(QStringLiteral(FIXTURES "/board-state.json"));
    if (!f.open(QIODevice::ReadOnly)) qFatal("fixture missing");
    State s;
    if (!State::decode(f.readAll(), &s)) qFatal("fixture does not decode");
    return s;
}

static State from(const QByteArray &json)
{
    State s;
    if (!State::decode(json, &s)) qFatal("test state does not decode");
    return s;
}

static Card quickCard()
{
    Card c;
    c.id = "c";
    c.options = {{"a", "Ja", ""}, {"b", "Nein", ""}};
    return c;
}

class TestCore : public QObject {
    Q_OBJECT

private slots:
    // ── decoding ────────────────────────────────────────────────────────
    void decodesTheDemoState()
    {
        const State s = demo();
        QCOMPARE(s.agents.size(), 3);
        QCOMPARE(s.agents[0].name, "Web-Frontend");
        QVERIFY(s.agents[0].online);
        QVERIFY(!s.agents[2].online);
        QCOMPARE(s.cards.size(), 10);
        QCOMPARE(s.queue, QStringList({"c-perm", "c-migrate", "c-phone", "c-theme", "c-nav", "c-next", "c-backup"}));
        const Card *perm = s.card("c-perm");
        QVERIFY(perm);
        QVERIFY(perm->permission());
        QCOMPARE(perm->urgency, Urgency::Critical);
        QCOMPARE(perm->number, 8);
        QCOMPARE(s.card("c-db")->status, "decided");
        QCOMPARE(s.card("c-db")->choice, "pg");
        QCOMPARE(s.card("c-theme")->attachments.size(), 2);
        QCOMPARE(s.card("c-theme")->attachments[0].kind, "image");
        QVERIFY(!s.messages.isEmpty());
    }

    void rejectsWhatIsNoObject()
    {
        State s;
        QString error;
        QVERIFY(!State::decode("not json", &s, &error));
        QVERIFY(!error.isEmpty());
        QVERIFY(!State::decode("[1,2]", &s, &error));
        QVERIFY(!State::decode("", &s, &error));
    }

    void fillsInWhatAnOldServerLeavesOut()
    {
        const State s = from(R"({"cards":[
            {"id":"a","title":"A","options":[{"key":"x","label":"X"}],"created":20},
            {"id":"p","kind":"permission","options":[{"key":"allow"},{"key":"deny"}],"created":30},
            {"id":"d","status":"decided","created":5},
            {"id":"b","urgency":"high","created":10}
        ],"messages":[{"id":"m","text":"hi"}]})");
        QCOMPARE(s.agents.size(), 1);
        QCOMPARE(s.agents[0].id, "main");
        QCOMPARE(s.agents[0].name, "Agent");
        QCOMPARE(s.cards[0].agent, "main");
        QCOMPARE(s.cards[0].number, 1);
        QCOMPARE(s.cards[3].number, 4);
        QCOMPARE(s.cards[0].urgency, Urgency::Normal);
        QCOMPARE(s.cards[1].urgency, Urgency::Critical); // approvals always are
        QCOMPARE(s.cards[1].options[0].label, "allow");  // a label falls back to the key
        QCOMPARE(s.messages[0].agent, "main");
        QCOMPARE(s.messages[0].from, "agent");
        // No queue sent: approvals first, then urgency, then the oldest.
        QCOMPARE(s.queue, QStringList({"p", "b", "a"}));
    }

    void survivesWrongTypes()
    {
        const State s = from(R"({"agents":"nope","cards":[
            17, null, {"title":"no id"},
            {"id":7,"number":"12","urgency":"enormous","options":"x","attachments":[{"name":"n"},{"url":"/files/a.png","image":true},{"url":"/f/b.mp4","kind":"video"}],"created":"100"},
            {"id":"7"}
        ],"messages":{"a":1},"queue":[1,"7","ghost","7"],"tasks":[{"id":"t"}]})");
        QCOMPARE(s.agents.size(), 1);
        QCOMPARE(s.cards.size(), 1); // no id is skipped, a repeated id too
        const Card &c = s.cards[0];
        QCOMPARE(c.id, "7");
        QCOMPARE(c.number, 12);
        QCOMPARE(c.urgency, Urgency::Normal);
        QVERIFY(c.options.isEmpty());
        QCOMPARE(c.attachments.size(), 2);
        QCOMPARE(c.attachments[0].kind, "image");
        QCOMPARE(c.attachments[0].name, "a.png");
        QCOMPARE(c.attachments[1].kind, "video");
        QCOMPARE(c.created, 100.0);
        QCOMPARE(s.queue, QStringList({"7"}));
        QCOMPARE(s.tasks.size(), 1);
        QCOMPARE(s.tasks[0].state, "working");
    }

    void aRenamedSessionShowsItsLabel()
    {
        const State s = from(R"({"agents":[{"id":"a","name":"web","label":"Frontend","starred":true},{"id":"a","name":"twice"}]})");
        QCOMPARE(s.agents.size(), 1);
        QCOMPARE(s.agents[0].name, "Frontend");
        QCOMPARE(s.agents[0].given, "web");
        QVERIFY(s.agents[0].starred);
    }

    void repairsTheQueue()
    {
        const State s = from(R"({"cards":[
            {"id":"a","created":1},{"id":"b","created":2,"urgency":"critical"},{"id":"c","status":"done"}
        ],"queue":["c","a","nope","a"]})");
        // "c" is not open, "nope" unknown, "a" twice; "b" was forgotten.
        QCOMPARE(s.queue, QStringList({"a", "b"}));
    }

    // ── the quick-card rule ─────────────────────────────────────────────
    void quickRule()
    {
        Card c = quickCard();
        QVERIFY(isQuick(c));
        c.body = QString(240, 'x');
        QVERIFY(isQuick(c));
        c.body = QString(241, 'x');
        QVERIFY(!isQuick(c));
        // A word under a thumb must fit its tile: two lines of fourteen letters.
        c = quickCard();
        c.options[0].label = QString(14, 'x');
        QVERIFY(isQuick(c));
        c.options[0].label = QString(15, 'x');
        QVERIFY(!isQuick(c));
        c.options[0].label = "Keep the old one";
        QVERIFY(isQuick(c));
        c.options[0].label = "Keep the old one for now, please";
        QVERIFY(!isQuick(c));
        // Several answers allowed: never by thumb.
        c = quickCard();
        c.multiple = true;
        QVERIFY(!isQuick(c));
        c = quickCard();
        c.options.append({"c", "Drei", ""});
        QVERIFY(!isQuick(c));
        c = quickCard();
        c.attachments = {{"a.png", "/files/a.png", "image"}};
        QVERIFY(isQuick(c)); // pictures are shown in the row
        c.attachments.append({"a.pdf", "/files/a.pdf", "file"});
        QVERIFY(!isQuick(c));
        // An approval is always answered in the list, whatever it carries.
        Card p;
        p.kind = "permission";
        p.body = QString(5000, 'x');
        p.options = {{"allow", "Erlauben", ""}, {"deny", "Ablehnen", ""}};
        QVERIFY(isQuick(p));
    }

    void quickRuleOnTheDemoState()
    {
        const State s = demo();
        QVERIFY(isQuick(*s.card("c-perm")));
        QVERIFY(!isQuick(*s.card("c-migrate"))); // four options
        QVERIFY(!isQuick(*s.card("c-theme")));   // three options
    }

    void tilesPutNoLeftAndYesRight()
    {
        Card c = quickCard(); // the agent leads with "Ja"
        QList<Tile> t = tiles(c);
        QCOMPARE(t.size(), 2);
        QCOMPARE(t[0].key, "b");
        QCOMPARE(t[0].icon, "no");
        QVERIFY(!t[0].lead);
        QCOMPARE(t[1].key, "a");
        QCOMPARE(t[1].icon, "yes");
        QVERIFY(t[1].lead && t[1].answer);
        QVERIFY(isBare(c));

        // On an approval "allow" is the yes, wherever it stands.
        Card p;
        p.kind = "permission";
        p.options = {{"deny", "Ablehnen", ""}, {"allow", "Erlauben", ""}};
        t = tiles(p);
        QCOMPARE(t[0].key, "deny");
        QCOMPARE(t[0].icon, "no");
        QCOMPARE(t[1].key, "allow");
        QVERIFY(t[1].lead);
        QVERIFY(!isBare(p));

        // Thumbs are the rule: down on the left, up on the right, whatever the words.
        c.options = {{"a", "Postgres", ""}, {"b", "SQLite", ""}};
        t = tiles(c);
        QCOMPARE(t[0].icon, "no");
        QCOMPARE(t[0].label, "SQLite");
        QVERIFY(!isBare(c));

        // More than two ways: one wide tile, which says how many.
        c.options.append({"c", "Keine", ""});
        t = tiles(c);
        QCOMPARE(t.size(), 1);
        QCOMPARE(t[0].key, "open");
        QCOMPARE(t[0].label, "Choose");
        QCOMPARE(t[0].detail, "3 options");
        QVERIFY(t[0].lead && !t[0].answer);
        c.multiple = true;
        QCOMPARE(tiles(c)[0].detail, "3 options, several allowed");
    }

    void tileLabels()
    {
        QVERIFY(fitsTile("Yes"));
        QVERIFY(fitsTile("Keep the old"));        // two lines
        QVERIFY(fitsTile("Self-hosted"));
        QVERIFY(fitsTile("Self-hosted runner"));  // breaks after the hyphen too
        QVERIFY(!fitsTile("Internationalisation"));
        QVERIFY(fitsTile("One two three four five six"));   // thirteen letters a line
        QVERIFY(!fitsTile("One two three four five six seven"));
    }

    void whatOpensAsAWindow()
    {
        Card c = quickCard();
        c.options.append({"c", "Drei", ""});
        QVERIFY(!needsWindow(c));
        c.body = QString(481, 'x');
        QVERIFY(needsWindow(c));
        c.body = "Look:\n```\ncode\n```";
        QVERIFY(needsWindow(c));
        c.body.clear();
        c.attachments = {{"a.png", "/files/a.png", "image"}};
        QVERIFY(!needsWindow(c));
        c.attachments.append({"b.png", "/files/b.png", "image"});
        QVERIFY(needsWindow(c));
        c.attachments = {{"a.pdf", "/files/a.pdf", "file"}};
        QVERIFY(needsWindow(c));
        c.attachments.clear();
        for (int i = 0; i < 4; i++) c.options.append({QString::number(i), "x", ""});
        QVERIFY(needsWindow(c)); // seven options
    }

    void negativeLabels()
    {
        QVERIFY(isNegative("Nein"));
        QVERIFY(isNegative("noch nicht"));
        QVERIFY(isNegative("Später"));
        QVERIFY(isNegative("Bei SQLite bleiben"));
        QVERIFY(isNegative("Nur lesen"));
        QVERIFY(isNegative("No"));
        QVERIFY(isNegative("Not yet"));
        QVERIFY(isNegative("Keep it"));
        QVERIFY(isNegative("Deny"));
        QVERIFY(!isNegative("Yes"));
        QVERIFY(!isNegative("Now"));
        QVERIFY(!isNegative("Notify me"));
        QVERIFY(!isNegative("Ja"));
        QVERIFY(!isNegative("Jetzt ausführen"));
    }

    // ── grouping and order ──────────────────────────────────────────────
    void groupsBySenderMostUrgentFirst()
    {
        const State s = from(R"({"agents":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"},{"id":"idle","name":"I"}],
          "cards":[
            {"id":"a1","agent":"a","urgency":"normal","created":1},
            {"id":"b1","agent":"b","urgency":"low","created":2},
            {"id":"b2","agent":"b","urgency":"critical","created":3},
            {"id":"c1","agent":"c","urgency":"high","created":4},
            {"id":"done","agent":"a","status":"done"}
          ]})");
        const QList<Group> g = groups(s, {});
        QCOMPARE(g.size(), 3); // a sender without a question has no group
        QCOMPARE(g[0].agent.id, "b");
        QCOMPARE(g[1].agent.id, "c");
        QCOMPARE(g[2].agent.id, "a");
        // Inside a group the queue's order holds.
        QCOMPARE(g[0].cards[0].id, "b2");
        QCOMPARE(g[0].cards[1].id, "b1");
        QCOMPARE(inboxOrder(s, {}), QStringList({"b2", "b1", "c1", "a1"}));
    }

    void starredSendersLead()
    {
        const State s = from(R"({"agents":[{"id":"a"},{"id":"b","starred":true}],
          "cards":[{"id":"a1","agent":"a","urgency":"critical"},{"id":"b1","agent":"b","urgency":"low"}]})");
        QCOMPARE(inboxOrder(s, {}), QStringList({"b1", "a1"}));
    }

    void equalGroupsKeepTheSessionsOrder()
    {
        const State s = from(R"({"agents":[{"id":"a"},{"id":"b"}],
          "cards":[{"id":"b1","agent":"b","created":1},{"id":"a1","agent":"a","created":2}]})");
        QCOMPARE(inboxOrder(s, {}), QStringList({"a1", "b1"}));
    }

    void aCardOfAnUnknownSenderIsKept()
    {
        const State s = from(R"({"agents":[{"id":"a"}],"cards":[{"id":"x","agent":"gone"}]})");
        const QList<Group> g = groups(s, {});
        QCOMPARE(g.size(), 1);
        QCOMPARE(g[0].agent.name, "gone");
    }

    void whatIsPutOffLeavesItsSender()
    {
        const State s = demo();
        const int all = int(inboxOrder(s, {}).size());
        const QList<PutOff> off = {{"c-theme", 1, 0}, {"c-migrate", 3, 0}};
        const Inbox in = inboxOf(s, off);
        // Whoever asked: one pile, in the order they were put off.
        QCOMPARE(in.later.size(), 2);
        QCOMPARE(in.later[0].id, "c-theme");
        QCOMPARE(in.later[1].id, "c-migrate");
        QVERIFY(in.asked.isEmpty());
        for (const Group &g : in.groups)
            for (const Card &c : g.cards) QVERIFY(c.id != "c-theme" && c.id != "c-migrate");
        QCOMPARE(in.fresh, all - 2);
        // The walk comes to them last.
        QCOMPARE(inboxOrder(s, off).size(), all);
        QCOMPARE(inboxOrder(s, off).mid(all - 2), QStringList({"c-theme", "c-migrate"}));
        // A sender whose every question was put off has no group of its own.
        for (const Group &g : inboxOf(s, {{"c-backup", 0, 0}}).groups) QVERIFY(g.agent.id != "infrastruktur");
        // A card that is gone is no trouble.
        QVERIFY(inboxOf(s, {{"nope", 1, 0}}).later.isEmpty());
    }

    void whatWasPutOffReturnsWhenItMatters()
    {
        const char *json = R"({"agents":[{"id":"a","name":"A","online":true}],
          "cards":[{"id":"c","agent":"a","urgency":"%1","options":[{"key":"x","label":"X"},{"key":"y","label":"Y"},{"key":"z","label":"Z"}]}],
          "messages":[{"id":"m1","agent":"a","from":"user","text":"why?","card_id":"c","ts":2000}%2]})";
        const State calm = from(QString(json).arg("normal", "").toUtf8());
        QCOMPARE(keptLater(calm, {{"c", 1, 0}}).size(), 1);
        // The agent made it more urgent since: it is news again.
        const State urgent = from(QString(json).arg("high", "").toUtf8());
        QVERIFY(keptLater(urgent, {{"c", 1, 0}}).isEmpty());
        // Handed to its session ("Explain", "Back to agent"): the pile "With the agent".
        QCOMPARE(inboxOf(calm, {{"c", 1, 1000}}).asked.size(), 1);
        QVERIFY(inboxOf(calm, {{"c", 1, 1000}}).later.isEmpty());
        QCOMPARE(inboxOf(calm, {{"c", 1, 1000}}).fresh, 0);
        // It comes back by itself once the session has answered about it; the human's own words do not count.
        const State replied = from(QString(json).arg("normal", R"(,{"id":"m2","agent":"a","from":"agent","text":"because","card_id":"c","ts":3000})").toUtf8());
        QVERIFY(keptLater(replied, {{"c", 1, 1000}}).isEmpty());
        QCOMPARE(inboxOf(replied, {{"c", 1, 1000}}).fresh, 1);
        QCOMPARE(keptLater(replied, {{"c", 1, 5000}}).size(), 1); // asked after that reply
        QCOMPARE(threadOf(replied, "c").size(), 2);
    }

    void theServerSaysWhatIsWithTheAgent()
    {
        const State s = from(R"({"agents":[{"id":"a","name":"A","online":true}],"cards":[
          {"id":"c","agent":"a","with_agent":5000,"version":3,"revisions":2,"revision_note":"shorter","versions":[{"n":1},{"n":2}],
           "options":[{"key":"x","label":"X"},{"key":"y","label":"Y"},{"key":"z","label":"Z"}]},
          {"id":"d","agent":"a","revisions":1,"options":[{"key":"x","label":"X"},{"key":"y","label":"Y"},{"key":"z","label":"Z"}]},
          {"id":"e","agent":"a","status":"decided","choice":"x","with_agent":7,"options":[{"key":"x","label":"X"}]}]})");
        QCOMPARE(s.card("c")->withAgent, 5000.0);
        QCOMPARE(s.card("c")->version, 3);
        QCOMPARE(s.card("c")->earlier, 2);
        QCOMPARE(s.card("c")->revisionNote, "shorter");
        QCOMPARE(s.card("d")->version, 2); // an older server only counts the rewordings
        QCOMPARE(s.card("e")->withAgent, 0.0); // only an open card waits
        // Handed over on another device: it waits in the same pile here, and is not to be worked down.
        const Inbox in = inboxOf(s, {});
        QCOMPARE(in.asked.size(), 1);
        QCOMPARE(in.asked[0].id, "c");
        QCOMPARE(in.fresh, 1);
        QCOMPARE(inboxOrder(s, {}), QStringList{"d"});
        // Put off here as well: still one card, in that pile.
        const Inbox both = inboxOf(s, {{"c", 1, 0}});
        QCOMPARE(both.asked.size(), 1);
        QVERIFY(both.later.isEmpty());
        // Handed over here, and the session reworded it since: it is back.
        const State r = from(R"({"agents":[{"id":"a","name":"A"}],"cards":[{"id":"c","agent":"a","revised":9000,
           "options":[{"key":"x","label":"X"},{"key":"y","label":"Y"},{"key":"z","label":"Z"}]}]})");
        QVERIFY(keptLater(r, {{"c", 1, 8000}}).isEmpty());
        QCOMPARE(keptLater(r, {{"c", 1, 9500}}).size(), 1);
        QCOMPARE(eventLabel("revised"), "Question revised");
    }

    void theAnsweredPile()
    {
        const State s = demo();
        const Inbox in = inboxOf(s, {});
        // Decisions that were answered, the latest first; an approval is not among them.
        QVERIFY(!in.answered.isEmpty());
        for (const Card &c : in.answered) QVERIFY(!c.open() && !c.permission() && !c.choice.isEmpty());
        for (int i = 1; i < in.answered.size(); i++) QVERIFY(in.answered[i - 1].decided >= in.answered[i].decided);
    }

    void theRecommendedOptionIsMarked()
    {
        const State s = demo();
        QCOMPARE(s.card("c-nav")->recommended, QStringList{"ja"});
        const QList<Tile> t = tiles(*s.card("c-nav"));
        QCOMPARE(t[1].key, "ja");
        QVERIFY(t[1].advised && !t[0].advised);
        QVERIFY(s.card("c-perm")->recommended.isEmpty());
        for (const Tile &x : tiles(*s.card("c-perm"))) QVERIFY(!x.advised);
        // The advice may be the "no", and one for an option that is not there is dropped.
        const State o = from(R"({"cards":[
            {"id":"a","options":[{"key":"x","label":"Ja"},{"key":"y","label":"Nein"}],"recommended":"y"},
            {"id":"b","options":[{"key":"x","label":"Ja"},{"key":"y","label":"Nein"}],"recommended":"z"},
            {"id":"c","options":[{"key":"x","label":"Ja"},{"key":"y","label":"Nein"}],"recommended":7}]})");
        QVERIFY(tiles(*o.card("a"))[0].advised && !tiles(*o.card("a"))[1].advised);
        QVERIFY(o.card("b")->recommended.isEmpty());
        QVERIFY(o.card("c")->recommended.isEmpty());
        // Where several answers are allowed, the advice may be several.
        const State m = from(R"({"cards":[{"id":"a","multiple":true,"recommended":["x","nope","z"],
            "options":[{"key":"x","label":"X"},{"key":"y","label":"Y"},{"key":"z","label":"Z"}]}]})");
        QCOMPARE(m.card("a")->recommended, QStringList({"x", "z"}));
        QVERIFY(m.card("a")->advised("z") && !m.card("a")->advised("y"));
    }

    void theDemoInbox()
    {
        const State s = demo();
        const QList<Group> g = groups(s, {});
        int total = 0;
        for (const Group &x : g) total += x.cards.size();
        QCOMPARE(total, s.queue.size());
        // The first group holds a blocked card.
        QCOMPARE(rank(g[0].cards[0].urgency), 3);
    }

    void nextCardAfterAnAnswer()
    {
        const QStringList before = {"a", "b", "c"};
        QCOMPARE(nextCard("b", before, {"a", "c"}), "c");
        QCOMPARE(nextCard("c", before, {"a", "b"}), "b"); // the last one: back to the previous
        QCOMPARE(nextCard("a", {"a"}, {}), "");
        QCOMPARE(nextCard("x", before, {"a", "c"}), "a");
        QCOMPARE(nextCard("b", before, {"d"}), "d");
    }

    void notifiesOnlyForNewUrgentCards()
    {
        const State before = from(R"({"cards":[
            {"id":"old","urgency":"critical"},{"id":"calm","urgency":"normal"},{"id":"raised","urgency":"low"},
            {"id":"back","urgency":"high","status":"decided"}]})");
        const State after = from(R"({"cards":[
            {"id":"old","urgency":"critical"},{"id":"calm","urgency":"normal"},{"id":"raised","urgency":"high"},
            {"id":"back","urgency":"high"},
            {"id":"new","urgency":"critical"},{"id":"quiet","urgency":"low"},{"id":"gone","urgency":"critical","status":"done"},
            {"id":"perm","kind":"permission"}]})");
        QStringList ids;
        for (const Card &c : newlyUrgent(before, after)) ids.append(c.id);
        QCOMPARE(ids, QStringList({"raised", "back", "new", "perm"}));
        QVERIFY(newlyUrgent(after, after).isEmpty());
    }

    // ── wording ─────────────────────────────────────────────────────────
    void wording()
    {
        QCOMPARE(urgencyLabel(Urgency::Critical), "Blocking");
        QCOMPARE(waiting(0), "Nothing needs you.");
        QCOMPARE(waiting(0, 2), "Nothing new. What you put off is below.");
        QCOMPARE(waiting(1, 2), "question needs you.");
        QCOMPARE(waiting(3), "questions need you.");
        QCOMPARE(urgencyLabel(Urgency::High), "Urgent");
        QCOMPARE(urgencyLabel(Urgency::Normal), ""); // nothing for the usual case
        QCOMPARE(urgencyLabel(Urgency::Low), "whenever");
        QCOMPARE(questions(1), "1 question");
        QCOMPARE(questions(4), "4 questions");
        QCOMPARE(eventLabel("asked"), "New question");
        QCOMPARE(eventLabel("whatever"), "Board");
        QCOMPARE(translateError("card already decided"), "This question is already answered.");
        QCOMPARE(translateError("no agent named x"), "There is no such session.");
        QCOMPARE(translateError("something new"), "something new");
        const QString stale = "the agent revised this question while you were answering; nothing was sent, read it again and answer once more";
        QVERIFY(isStale(stale));
        QVERIFY(translateError(stale).startsWith("The agent revised this question"));
        Card c;
        c.number = 12;
        QCOMPARE(cardNr(c), "Nr. 12");
        QCOMPARE(cardNote(c), "");
        c.revised = 5;
        c.mergedFrom = {"a", "b", "c"};
        QCOMPARE(cardNote(c), "replaces 3 questions · revised");
    }

    void agoInWords()
    {
        const double now = 1790000000000.0;
        QCOMPARE(ago(now - 20000, now), "just now");
        QCOMPARE(ago(now - 5 * 60000, now), "5 min ago");
        QCOMPARE(ago(now - 59 * 60000, now), "59 min ago");
        QCOMPARE(ago(now - 90 * 60000, now), "2 h ago");
        const QString date = ago(now - 3 * 86400000.0, now);
        QVERIFY2(QRegularExpression("^\\d{1,2} \\S+$").match(date).hasMatch(), qPrintable(date));
    }

    void plainTakesTheMarkdownOut()
    {
        QCOMPARE(plain("Die Migration `x` füllt **48 Zeilen** nach.\n\n```\nALTER TABLE\n```\n# Ende"), "Die Migration x füllt 48 Zeilen nach. Ende");
        QCOMPARE(plain(""), "");
    }

    void barStatusForWaybar()
    {
        const State s = demo();
        QJsonObject o = barStatus(s, true);
        QCOMPARE(o["text"].toString(), "7");
        QCOMPARE(o["class"].toString(), "critical");
        QVERIFY(o["tooltip"].toString().contains("Approval"));
        o = barStatus(State(), true);
        QCOMPARE(o["text"].toString(), "");
        QCOMPARE(o["class"].toString(), "empty");
        QCOMPARE(barStatus(s, false)["class"].toString(), "offline");
    }

    // ── markdown ────────────────────────────────────────────────────────
    void inlineMarkdown()
    {
        const QList<Inline> in = parseInline("Die `Spalte` füllt **48 Zeilen** nach, siehe https://example.org/a?b=1 (hier).");
        QCOMPARE(in.size(), 7);
        QCOMPARE(in[0], (Inline{Inline::Text, "Die "}));
        QCOMPARE(in[1], (Inline{Inline::Code, "Spalte"}));
        QCOMPARE(in[3], (Inline{Inline::Bold, "48 Zeilen"}));
        QCOMPARE(in[5], (Inline{Inline::Link, "https://example.org/a?b=1"}));
        QCOMPARE(in[6].text, " (hier).");
        // Unclosed marks stay as they were written.
        QCOMPARE(parseInline("a ** b ` c"), (QList<Inline>{{Inline::Text, "a ** b ` c"}}));
        QVERIFY(parseInline("").isEmpty());
    }

    void blockMarkdown()
    {
        const QList<Block> b = parseMarkdown("Plan:\n\n- **Datenbank** festlegen\n* Tabs\n\nMit:\n\n```sh\ndocker compose up\n  -d\n```\nFertig.\nZweite Zeile.");
        QCOMPARE(b.size(), 5);
        QCOMPARE(b[0].kind, Block::Paragraph);
        QCOMPARE(b[1].kind, Block::Bullets);
        QCOMPARE(b[1].items.size(), 2);
        QCOMPARE(b[1].items[0][0], (Inline{Inline::Bold, "Datenbank"}));
        QCOMPARE(b[1].items[1][0].text, "Tabs");
        QCOMPARE(b[3].kind, Block::CodeBlock);
        QCOMPARE(b[3].code, "docker compose up\n  -d"); // the language tag is dropped, indentation kept
        QCOMPARE(b[4].inlines[0].text, "Fertig.\nZweite Zeile.");
        // A list mixed with prose is a paragraph.
        QCOMPARE(parseMarkdown("- eins\nund Text")[0].kind, Block::Paragraph);
        QVERIFY(parseMarkdown("").isEmpty());
        QVERIFY(parseMarkdown("\n\n  \n").isEmpty());
    }

    void aTableAsAgentsWriteIt()
    {
        const QList<Block> b = parseMarkdown("Before\n\n| Account | Seconds |\n|---|---:|\n| small | **1** |\n| large | 45 |\n\n| not | a table |");
        QCOMPARE(b.size(), 3);
        QCOMPARE(b[1].kind, Block::Table);
        QCOMPARE(b[1].rows.size(), 3); // the head and two rows; the rule is no row
        QCOMPARE(b[1].rows[0][1][0].text, "Seconds");
        QCOMPARE(b[1].rows[1][1][0].kind, Inline::Bold);
        QCOMPARE(b[2].kind, Block::Paragraph); // one line of pipes is only a line
    }

    void htmlEscapesWhatTheAgentWrote()
    {
        HtmlStyle style;
        style.monoFamily = "Mono";
        const QString html = toHtml(parseInline("<b>x</b> & **<i>fett</i>** `a<b`\nneu"), style);
        QVERIFY(!html.contains("<i>"));
        QVERIFY(html.contains("&lt;b&gt;x&lt;/b&gt; &amp; <b>&lt;i&gt;fett&lt;/i&gt;</b>"));
        QVERIFY(html.contains("a&lt;b"));
        QVERIFY(html.contains("<br>neu"));
        QVERIFY(toHtml(parseInline("https://a.de/?q=\"x\"")).contains("href=\"https://a.de/?q=&quot;x&quot;\""));
    }

    // ── link and cookie ─────────────────────────────────────────────────
    void parsesTheBoardLink()
    {
        ServerLink l;
        QString error;
        QVERIFY(ServerLink::parse("  http://192.168.1.20:8790/?t=abc123 \n", &l, &error));
        QCOMPARE(l.token, "abc123");
        QCOMPARE(l.origin(), "http://192.168.1.20:8790");
        QCOMPARE(l.loginUrl().toString(), "http://192.168.1.20:8790/?t=abc123");
        QCOMPARE(l.url("/events").toString(), "http://192.168.1.20:8790/events");
        QCOMPARE(l.address(), "192.168.1.20:8790");
        // No scheme is http; a path and other parameters are dropped.
        QVERIFY(ServerLink::parse("localhost:8801/some/path?x=1&t=demo#dark", &l));
        QCOMPARE(l.origin(), "http://localhost:8801");
        QCOMPARE(l.token, "demo");
        // https without a port, as behind tailscale serve.
        QVERIFY(ServerLink::parse("https://kiste.tail1234.ts.net/?t=a%2Bb", &l));
        QCOMPARE(l.origin(), "https://kiste.tail1234.ts.net");
        QCOMPARE(l.token, "a+b");
        QCOMPARE(l.loginUrl().toString(QUrl::FullyEncoded), "https://kiste.tail1234.ts.net/?t=a%2Bb");
        // The desktop deep link.
        QVERIFY(ServerLink::parse("trommi://127.0.0.1:8790/?t=x", &l));
        QCOMPARE(l.origin(), "http://127.0.0.1:8790");
        // What was kept reads back the same.
        ServerLink again;
        QVERIFY(ServerLink::parse(l.text(), &again));
        QCOMPARE(again.origin(), l.origin());
        QCOMPARE(again.token, l.token);
    }

    void refusesWhatIsNoBoardLink()
    {
        ServerLink l;
        QString error;
        QVERIFY(!ServerLink::parse("", &l, &error));
        QVERIFY(!ServerLink::parse("http://host:8790/", &l, &error));
        QVERIFY(error.contains("token"));
        QVERIFY(!ServerLink::parse("ftp://host/?t=x", &l, &error));
        QVERIFY(!ServerLink::parse("http:///?t=x", &l, &error));
        QVERIFY(!error.isEmpty());
    }

    void readsTheCookieOfTheLogin()
    {
        SessionCookie c = SessionCookie::from("board_8790=secret; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000", "secret");
        QCOMPARE(c.name, "board_8790");
        QCOMPARE(c.header(), QByteArray("board_8790=secret"));
        // Several cookies in one header, one with a comma in its date.
        c = SessionCookie::from("other=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, board_8801=tok; Path=/", "tok");
        QCOMPARE(c.name, "board_8801");
        // Qt joins repeated Set-Cookie headers with a newline.
        c = SessionCookie::from("a=b; Path=/\nboard=\"tok\"; Path=/", "tok");
        QCOMPARE(c.name, "board");
        // A cookie named board whose value is not the token still counts.
        c = SessionCookie::from("board_1=session-id", "tok");
        QCOMPARE(c.header(), QByteArray("board_1=session-id"));
        // No header at all: the plain name, which the server still accepts.
        c = SessionCookie::from("", "tok");
        QCOMPARE(c.header(), QByteArray("board=tok"));
    }

    // ── the event stream ────────────────────────────────────────────────
    void sseFrames()
    {
        SseParser p;
        QCOMPARE(p.feed("data: {\"a\":1}\n\n"), QList<QByteArray>{"{\"a\":1}"});
        // Split anywhere, even inside a UTF-8 character.
        const QByteArray frame = QStringLiteral("data: {\"t\":\"Später\"}\n\n").toUtf8();
        QList<QByteArray> got;
        for (char ch : frame) got += p.feed(QByteArray(1, ch));
        QCOMPARE(got.size(), 1);
        QCOMPARE(QString::fromUtf8(got[0]), "{\"t\":\"Später\"}");
        // Two events in one chunk, comments, other fields, CRLF, several data lines.
        got = p.feed(": ping\nevent: x\nid: 4\ndata: one\r\n\r\nretry: 5\ndata:two\ndata: three\n\ndata: half");
        QCOMPARE(got, (QList<QByteArray>{"one", "two\nthree"}));
        QCOMPARE(p.feed("\n\n"), QList<QByteArray>{"half"});
        // Empty lines alone are no event.
        QVERIFY(p.feed("\n\n\n").isEmpty());
        // After a reconnect nothing of the old stream is left.
        p.feed("data: stale");
        p.reset();
        QCOMPARE(p.feed("data: fresh\n\n"), QList<QByteArray>{"fresh"});
    }

    void backoff()
    {
        QCOMPARE(backoffDelay(0), 0.0);
        QCOMPARE(backoffDelay(1), 1.0);
        QCOMPARE(backoffDelay(2), 2.0);
        QCOMPARE(backoffDelay(4), 8.0);
        QCOMPARE(backoffDelay(5), 15.0);
        QCOMPARE(backoffDelay(500), 15.0);
        QCOMPARE(backoffDelay(2, 0.0), 2.0);
        QCOMPARE(backoffDelay(2, 1.0), 2.5);
    }

    // ── the link on disk ────────────────────────────────────────────────
    void linkFileIsOnlyTheOwners()
    {
        QTemporaryDir dir;
        const QString path = dir.path() + "/trommi/board";
        QCOMPARE(LinkFile::load(path), "");
        QVERIFY(LinkFile::save(path, "http://h:1/?t=x"));
        QCOMPARE(QFile::permissions(path) & (QFile::ReadGroup | QFile::WriteGroup | QFile::ReadOther | QFile::WriteOther), QFile::Permissions());
        QVERIFY(QFile::permissions(path) & QFile::ReadOwner);
        QCOMPARE(LinkFile::load(path), "http://h:1/?t=x");
        QVERIFY(LinkFile::save(path, "http://h:2/?t=y")); // over an old one
        QCOMPARE(LinkFile::load(path), "http://h:2/?t=y");
        QVERIFY(LinkFile::remove(path));
        QVERIFY(!QFile::exists(path));
        QVERIFY(LinkFile::remove(path));
    }

    // ── the product as it is now: the fields the server sends today ─────
    void decodesTheCurrentFields()
    {
        const State s = board();
        // Sessions in the server's order, the archived one apart, a pair as a group.
        QVERIFY(s.agents.size() >= 4);
        QCOMPARE(s.archived.size(), 1);
        QCOMPARE(s.archived[0].id, "old-spike");
        QVERIFY(s.agent("old-spike")); // still known by name
        QCOMPARE(s.groups.size(), 1);
        QCOMPARE(s.groups[0].members, QStringList({"docs", "docs-review"}));
        QCOMPARE(s.agent("api")->mark, "draw:anchor"); // the icon the human picked
        QCOMPARE(s.agent("web-frontend")->mark, "web-frontend");
        QVERIFY(s.agent("api")->starred);
        QVERIFY(s.speech);
        // What an archived session asked waits with it.
        QVERIFY(s.card("c-old") && s.card("c-old")->open());
        QVERIFY(!s.queue.contains("c-old"));

        const Card *multi = s.card("c-checks");
        QVERIFY(multi->multiple);
        QCOMPARE(multi->recommended, QStringList({"lint", "e2e"}));
        QVERIFY(!isQuick(*multi));
        QCOMPARE(multi->draft.keys, QStringList{"lint"});
        QCOMPARE(multi->draft.note, "only on main ");
        QCOMPARE(multi->draft.notes.size(), 1);

        const Card *merged = s.card("c-export");
        QVERIFY(merged->revised > 0);
        QCOMPARE(merged->mergedFrom.size(), 2);
        QCOMPARE(cardNote(*merged), "replaces 2 questions · revised");
        // Sections: a plain block, then the options as paragraphs, tied by their keys.
        QCOMPARE(merged->sections.size(), 4);
        QVERIFY(!merged->sections[0].flagged());
        QCOMPARE(merged->sections[1].key, "limit");
        QVERIFY(merged->sections[1].recommended);
        QCOMPARE(merged->sections[2].picture, 0);
        QCOMPARE(merged->sections[3].picture, -1); // an index the card does not have

        const Card *done = s.card("c-runner");
        QCOMPARE(done->choices, QStringList({"hosted"}));
        QCOMPARE(done->optionNotes.size(), 1);
        QCOMPARE(done->optionNotes[0].first, "self");
        const Card *many = s.card("c-notify");
        QCOMPARE(many->choices, QStringList({"mail", "board"}));
        QCOMPARE(many->choice, "mail");
    }

    void oneStringOfChoicesIsAList()
    {
        const State s = from(R"({"cards":[
            {"id":"a","status":"decided","choice":"x","options":[{"key":"x","label":"X"},{"key":"y","label":"Y"}]},
            {"id":"b","status":"decided","choices":["y"],"options":[{"key":"x","label":"X"},{"key":"y","label":"Y"}]},
            {"id":"c","sections":"nonsense","draft":7,"merged_from":"x","option_notes":[1],"revised":"soon","multiple":"yes",
             "options":[{"key":"x","label":"X"}]}]})");
        QCOMPARE(s.card("a")->choices, QStringList{"x"});
        QCOMPARE(s.card("b")->choice, "y");
        QVERIFY(s.card("c")->sections.isEmpty());
        QVERIFY(s.card("c")->draft.empty());
        QVERIFY(!s.card("c")->multiple);
        QCOMPARE(s.card("c")->revised, 0.0);
    }

    void aGroupNeedsTwoWhoAreStillHere()
    {
        const State s = from(R"({"agents":[
            {"id":"a","name":"A","group":"g1"},{"id":"b","name":"B","group":"g1","archived":true},
            {"id":"c","name":"C","group":"g2"},{"id":"d","name":"D","group":"g2"},{"id":"e","name":"E"}]})");
        QCOMPARE(s.groups.size(), 1);
        QCOMPARE(s.groups[0].id, "g2");
        QVERIFY(s.agent("a")->group.isEmpty());
        const QList<Unit> u = units(s);
        QCOMPARE(u.size(), 3);
        QCOMPARE(u[0].id, "a");
        QCOMPARE(u[1].id, "g2");
        QCOMPARE(u[1].members.size(), 2);
        QCOMPARE(u[2].id, "e");
    }

    void whatASessionNeedsShowsAtItsRow()
    {
        const State s = board();
        QHash<QString, Unit> by;
        for (const Unit &u : units(s)) by.insert(u.id, u);
        // Blocked: something of it cannot go on without the human. The raised hand.
        QVERIFY(by["api"].stuck);
        QCOMPARE(by["api"].badge(), "waiting");
        // Working, with questions open: the ring with the count.
        QVERIFY(by["web-frontend"].running && !by["web-frontend"].stuck);
        QCOMPARE(by["web-frontend"].badge(), "running");
        QVERIFY(by["web-frontend"].open > 0);
        // Disconnected with a question left: the count alone.
        QVERIFY(!by["infrastructure"].online);
        QCOMPARE(by["infrastructure"].badge(), "open");
        // Online, nothing running, a question open: it waits for the human.
        Unit idle;
        idle.online = true;
        idle.open = 1;
        QCOMPARE(idle.badge(), "waiting");
        idle.open = 0;
        QCOMPARE(idle.badge(), "");
        idle.running = true;
        QCOMPARE(idle.badge(), "running");
    }

    void layingSessionsTogether()
    {
        const State s = from(R"({"agents":[
            {"id":"a","name":"A","group":"g1"},{"id":"b","name":"B","group":"g1"},
            {"id":"c","name":"C","group":"g2"},{"id":"d","name":"D","group":"g2"},{"id":"e","name":"E","group":"g2"},
            {"id":"f","name":"F"},{"id":"h","name":"H"}]})");
        using L = QList<QPair<QString, QString>>;
        // Two that stand alone: a new group for both.
        QCOMPARE(pairChanges(s, "f", "h", "new"), L({{"h", "new"}, {"f", "new"}}));
        // Onto one that is in a group: into that group.
        QCOMPARE(pairChanges(s, "f", "c", "new"), L({{"c", "g2"}, {"f", "g2"}}));
        // Out of a pair into another: whoever is left behind stands alone again.
        QCOMPARE(pairChanges(s, "a", "f", "new"), L({{"b", ""}, {"f", "new"}, {"a", "new"}}));
        // Onto itself, onto its own group, onto nobody: nothing.
        QVERIFY(pairChanges(s, "a", "a", "new").isEmpty());
        QVERIFY(pairChanges(s, "a", "b", "new").isEmpty());
        QVERIFY(pairChanges(s, "a", "nobody", "new").isEmpty());
        // Taking one out: a group of two dissolves, a larger one only loses it.
        QCOMPARE(unpairChanges(s, "a"), L({{"a", ""}, {"b", ""}}));
        QCOMPARE(unpairChanges(s, "d"), L({{"d", ""}}));
        QVERIFY(unpairChanges(s, "f").isEmpty());
    }

    void twinsAreToldApart()
    {
        const State s = from(R"({"agents":[
            {"id":"a","name":"trommi","cwd":"/home/x/git/trommi"},{"id":"b","name":"trommi","cwd":"/home/x/tmp/trommi"},
            {"id":"c","name":"api","cwd":"/srv/api","host":"one"},{"id":"d","name":"api","cwd":"/srv/api","host":"two"},
            {"id":"e","name":"alone"}]})");
        const auto lines = tellApart(s.agents);
        QCOMPARE(lines.value("a"), "git/trommi");
        QCOMPARE(lines.value("b"), "tmp/trommi");
        QCOMPARE(lines.value("d"), "two");
        QVERIFY(!lines.contains("e"));
    }

    void linksInARowAreNamedNotSpelled()
    {
        QCOMPARE(plain("See https://example.com/a/very/long/path/that/goes/on/and/on?x=1 now"), "See example.com/a/very/long/path/that… now");
        QCOMPARE(plain("Here: https://board.example/a/abcdefghijklmnop0123#0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"), "Here: [published link]");
    }

    // ── the scribbles: the same strokes as the web draws ────────────────
    void scribblesMatchTheWeb_data()
    {
        QTest::addColumn<QString>("file");
        QTest::newRow("this client's fixture") << QStringLiteral(FIXTURES "/doodles.json");
        QTest::newRow("the iOS client's fixture") << QStringLiteral(FIXTURES "/../../../ios/TrommiTests/Fixtures/doodles.json");
    }
    void scribblesMatchTheWeb()
    {
        QFETCH(QString, file);
        QFile f(file);
        if (!f.open(QIODevice::ReadOnly)) QSKIP("fixture not there");
        const QJsonObject all = QJsonDocument::fromJson(f.readAll()).object();
        auto list = [](const QJsonValue &v) {
            QStringList out;
            for (const QJsonValue &x : v.toArray()) out.append(x.toString());
            return out;
        };
        QVERIFY(all.value("doodles").toArray().size() > 30);
        for (const QJsonValue &v : all.value("doodles").toArray()) {
            const QJsonObject o = v.toObject();
            const Drawing d = doodle(o.value("seed").toString());
            QVERIFY2(d.paths == list(o.value("paths")), qPrintable("doodle " + o.value("seed").toString() + ": " + d.paths.join(" | ")));
            QCOMPARE(d.rotate, o.value("rotate").toDouble());
        }
        for (const QJsonValue &v : all.value("sketches").toArray()) {
            const QJsonObject o = v.toObject();
            const Drawing d = sketch(o.value("name").toString());
            QVERIFY2(d.paths == list(o.value("paths")), qPrintable("sketch " + o.value("name").toString()));
            QCOMPARE(d.rotate, o.value("rotate").toDouble());
        }
        for (const QJsonValue &v : all.value("pairs").toArray()) {
            const QJsonObject o = v.toObject();
            QList<PairMember> members;
            for (const QJsonValue &m : o.value("members").toArray()) members.append({m.toObject().value("id").toString(), m.toObject().value("mark").toString()});
            const PairDrawing p = pairDoodle(members);
            QStringList transforms;
            for (const auto &m : p.members) transforms.append(m.transform);
            QCOMPARE(transforms, list(o.value("transforms")));
            QCOMPARE(p.loop, o.value("loop").toString());
        }
        const QJsonValue c = all.value("crown");
        QCOMPARE(crown(), c.isObject() ? c.toObject().value("path").toString() : c.toString());
        if (!all.contains("hand")) return; // the rest is in this client's fixture only
        QCOMPARE(raisedHand(), list(all.value("hand")));
        // The highlighter behind the words the agent would pick: one swipe per line.
        const QJsonObject marker = all.value("marker").toObject();
        QList<QRectF> lines;
        for (const QJsonValue &v : marker.value("lines").toArray()) lines.append(QRectF(v.toObject().value("x").toDouble(), v.toObject().value("y").toDouble(), v.toObject().value("w").toDouble(), v.toObject().value("h").toDouble()));
        const QList<MarkerStroke> swipes = adviceMarker(lines);
        QCOMPARE(swipes.size(), 3);
        for (int i = 0; i < swipes.size(); i++) {
            QCOMPARE(swipes[i].path, marker.value("paths").toArray()[i].toString());
            QCOMPARE(swipes[i].width, marker.value("widths").toArray()[i].toDouble());
        }
        for (const QJsonValue &v : all.value("groupLoops").toArray()) QCOMPARE(groupLoop(v.toObject().value("seed").toString()), v.toObject().value("path").toString());
        for (const QJsonValue &v : all.value("loops").toArray()) {
            const QJsonObject o = v.toObject();
            Pen pen(o.value("seed").toString());
            QCOMPARE(loopPath(pen, o.value("rad").toDouble(), o.value("drift").toDouble(), o.value("jitter").toDouble(), o.value("start").toDouble()), o.value("path").toString());
        }
        QCOMPARE(ringLoop(), all.value("loops").toArray()[0].toObject().value("path").toString());
        for (const QJsonValue &v : all.value("hues").toArray()) QCOMPARE(hueOf(v.toObject().value("id").toString()), v.toObject().value("hue").toInt());
        QCOMPARE(railMark("open", false, "c-1")[0], all.value("loops").toArray()[1].toObject().value("path").toString());
    }

    void scribblesByName()
    {
        QCOMPARE(drawings().size(), 40);
        QVERIFY(drawings().contains("crown") && drawings().contains("burst"));
        // The same seed, the same scribble; another seed, another one.
        QCOMPARE(doodle("api").paths, doodle("api").paths);
        QVERIFY(doodle("api").paths != doodle("web-frontend").paths);
        QVERIFY(!sketch("explain").paths.isEmpty());
        QVERIFY(sketch("no such icon").paths.isEmpty());
        QCOMPARE(railMark("done", true, "x").size(), 2);
        QVERIFY(ringDrop().startsWith('M') && ringDrop().endsWith('Z'));
    }
};

QTEST_GUILESS_MAIN(TestCore)
#include "tst_core.moc"
