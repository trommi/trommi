// Protocol and logic, tested without a window or a server.
#include "link.h"
#include "logic.h"
#include "markdown.h"
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

static State from(const char *json)
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
        c = quickCard();
        c.options[0].label = QString(18, 'x');
        QVERIFY(isQuick(c));
        c.options[0].label = QString(19, 'x');
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

        // The second answer is not always a no.
        c.options = {{"a", "Postgres", ""}, {"b", "SQLite", ""}};
        t = tiles(c);
        QCOMPARE(t[0].icon, "other");

        // Not a yes/no: later and more, in the same two places.
        c.options.append({"c", "Keine", ""});
        t = tiles(c);
        QCOMPARE(t[0].key, "later");
        QCOMPARE(t[0].label, "Later");
        QCOMPARE(t[1].key, "open");
        QCOMPARE(t[1].label, "Choose");
        QVERIFY(t[1].lead && !t[1].answer);
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

    void laterMovesACardToTheEnd()
    {
        const State s = demo();
        const QList<Card> plain = openCards(s, {});
        QCOMPARE(plain.first().id, "c-perm");
        // Put off in this order: they sink to the end in this order.
        const QList<Card> put = openCards(s, {"c-migrate", "c-perm"});
        QCOMPARE(put.size(), plain.size());
        QCOMPARE(put[put.size() - 2].id, "c-migrate");
        QCOMPARE(put.last().id, "c-perm");
        QCOMPARE(put.first().id, "c-phone");
        // A card that is gone is no trouble.
        QCOMPARE(openCards(s, {"nope"}).first().id, "c-perm");
    }

    void whatIsPutOffStandsInOneGroupAtTheEnd()
    {
        const State s = demo();
        const int senders = int(groups(s, {}).size());
        const QList<Group> g = groups(s, {"c-theme", "c-migrate"});
        QVERIFY(g.last().later);
        QCOMPARE(g.last().agent.name, "Later");
        // Whoever asked: one group, in the order they were put off.
        QCOMPARE(g.last().cards.size(), 2);
        QCOMPARE(g.last().cards[0].id, "c-theme");
        QCOMPARE(g.last().cards[1].id, "c-migrate");
        QCOMPARE(g.size(), senders + 1);
        for (int i = 0; i < g.size() - 1; i++) {
            QVERIFY(!g[i].later);
            for (const Card &c : g[i].cards) QVERIFY(c.id != "c-theme" && c.id != "c-migrate");
        }
        QCOMPARE(inboxOrder(s, {"c-theme", "c-migrate"}).mid(5), QStringList({"c-theme", "c-migrate"}));
        // A sender whose every question was put off has no group of its own.
        const QList<Group> h = groups(s, {"c-backup"});
        for (int i = 0; i < h.size() - 1; i++) QVERIFY(h[i].agent.id != "infrastruktur");
        // Nothing put off, or only cards that are gone: no such group.
        for (const Group &x : groups(s, {"nope"})) QVERIFY(!x.later);
        // There the left tile fetches the card back.
        QCOMPARE(tiles(*s.card("c-theme"), true)[0].key, "back");
        QCOMPARE(tiles(*s.card("c-theme"), true)[0].label, "Bring back");
        QCOMPARE(tiles(*s.card("c-nav"), true)[0].answer, true); // a yes/no stays a yes/no
    }

    void theRecommendedOptionIsMarked()
    {
        const State s = demo();
        QCOMPARE(s.card("c-nav")->recommended, "ja");
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
        QCOMPARE(waiting(0), "Nothing is waiting for you.");
        QCOMPARE(waiting(0, 2), "Nothing new. What you put off is below.");
        QCOMPARE(waiting(1, 2), "question is waiting for you.");
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
};

QTEST_GUILESS_MAIN(TestCore)
#include "tst_core.moc"
