// The client against a server. Two parts:
//  - against a stand-in written here (a QTcpServer), which can do what the
//    real one will not on request: drop the stream, change nothing else;
//  - against the real server/server.mjs with demo data, when
//    TROMMI_TEST_URL names it (bin/test-live starts one). Skipped otherwise.
#include "client.h"
#include "logic.h"

#include <QSignalSpy>
#include <QTcpServer>
#include <QTcpSocket>
#include <QProcess>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QtTest>

using namespace trommi;

// Speaks just enough HTTP: the login redirect, the event stream, POSTs.
class StandIn : public QTcpServer {
public:
    QString token = "tok";
    int logins = 0, streams = 0, denied = 0;
    bool dropStreams = true; // close every stream right after its first frame
    QList<QByteArray> posts; // "PATH origin=… cookie=… BODY"
    QList<QPointer<QTcpSocket>> open;

    StandIn()
    {
        connect(this, &QTcpServer::newConnection, this, [this] {
            while (QTcpSocket *s = nextPendingConnection()) {
                connect(s, &QTcpSocket::readyRead, this, [this, s] { read(s); });
                connect(s, &QTcpSocket::disconnected, s, &QObject::deleteLater);
            }
        });
    }

    QString cookieName() const { return QStringLiteral("board_%1").arg(serverPort()); }
    QString link() const { return QStringLiteral("http://127.0.0.1:%1/?t=%2").arg(serverPort()).arg(token); }

    void push(const QByteArray &json)
    {
        for (const auto &s : open)
            if (s) s->write("data: " + json + "\n\n");
    }

private:
    QHash<QTcpSocket *, QByteArray> m_in;

    void read(QTcpSocket *s)
    {
        QByteArray &buf = m_in[s];
        buf += s->readAll();
        const qsizetype end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const QList<QByteArray> lines = buf.left(end).split('\n');
        QHash<QByteArray, QByteArray> head;
        for (const QByteArray &l : lines.mid(1)) {
            const qsizetype c = l.indexOf(':');
            if (c > 0) head[l.left(c).trimmed().toLower()] = l.mid(c + 1).trimmed();
        }
        const QByteArray body = buf.mid(end + 4);
        if (body.size() < head.value("content-length").toInt()) return;
        const QList<QByteArray> first = lines[0].trimmed().split(' ');
        const QByteArray method = first.value(0), path = first.value(1);
        m_in.remove(s);
        const QByteArray cookie = (cookieName() + "=" + token).toUtf8();

        auto answer = [s](const QByteArray &status, const QByteArray &headers, const QByteArray &content) {
            s->write("HTTP/1.1 " + status + "\r\n" + headers + "Content-Length: " + QByteArray::number(content.size()) + "\r\nConnection: close\r\n\r\n" + content);
            s->disconnectFromHost();
        };
        if (method == "GET" && path == "/?t=" + token.toUtf8()) {
            logins++;
            return answer("302 Found", "Set-Cookie: " + cookie + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000\r\nLocation: /\r\n", "");
        }
        if (head.value("cookie") != cookie) {
            denied++;
            return answer("401 Unauthorized", "Content-Type: text/plain\r\n", "Zugang nur über den Link");
        }
        if (method == "GET" && path == "/events") {
            streams++;
            s->write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n");
            s->write(": hello\n\ndata: {\"cards\":[{\"id\":\"c" + QByteArray::number(streams) + "\",\"title\":\"T\"}]}\n\n");
            if (dropStreams) s->disconnectFromHost();
            else open.append(s);
            return;
        }
        if (method == "POST") {
            posts.append(path + " origin=" + head.value("origin") + " " + body);
            if (path == "/decide" && body.contains("\"gone\""))
                return answer("400 Bad Request", "Content-Type: application/json\r\n", "{\"error\":\"unknown card\"}");
            if (path == "/decide" && body.contains("\"reworded\""))
                return answer("409 Conflict", "Content-Type: application/json\r\n", "{\"error\":\"the agent revised this question while you were answering; nothing was sent, read it again and answer once more\"}");
            if (path == "/decide" && body.contains("\"answered\""))
                return answer("409 Conflict", "Content-Type: application/json\r\n", "{\"error\":\"card already decided\"}");
            return answer("200 OK", "Content-Type: application/json\r\n", "{\"ok\":true}");
        }
        answer("404 Not Found", "", "");
    }
};

// Waits for the answer of one POST.
struct Answer {
    bool done = false, ok = false, stale = false;
    int status = 0;
    QString error;
    BoardClient::Done take()
    {
        return [this](const BoardClient::Outcome &o) { done = true; ok = o.ok; error = o.error; stale = o.stale; status = o.status; };
    }
    bool wait() { return QTest::qWaitFor([this] { return done; }, 5000); }
};

class TestLive : public QObject {
    Q_OBJECT

    ServerLink real;
    bool haveReal = false;

private slots:
    void initTestCase()
    {
        const QString url = qEnvironmentVariable("TROMMI_TEST_URL");
        if (!url.isEmpty()) {
            QString error;
            QVERIFY2(ServerLink::parse(url, &real, &error), qPrintable(error));
            haveReal = true;
        }
    }

    // ── against the stand-in ────────────────────────────────────────────
    void standIn_loginReadsTheCookieWithoutFollowingTheRedirect()
    {
        StandIn server;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        ServerLink link;
        QVERIFY(ServerLink::parse(server.link(), &link));
        BoardClient client;
        QSignalSpy in(&client, &BoardClient::loggedIn);
        QSignalSpy states(&client, &BoardClient::state);
        client.start(link);
        QVERIFY(states.wait(5000));
        QCOMPARE(in.count(), 1);
        QCOMPARE(client.cookie().name, server.cookieName());
        QCOMPARE(server.logins, 1);
        QCOMPARE(server.denied, 0); // "/" was never asked for: the redirect was not followed
        QCOMPARE(states[0][0].value<State>().cards[0].id, "c1");
        client.stop();
    }

    void standIn_wrongTokenIsDeniedAndNotRetried()
    {
        StandIn server;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        ServerLink link;
        QVERIFY(ServerLink::parse(server.link() + "wrong", &link));
        BoardClient client;
        QSignalSpy failed(&client, &BoardClient::loginFailed);
        client.start(link);
        QVERIFY(failed.wait(5000));
        QCOMPARE(failed[0][1].toBool(), true);
        QTest::qWait(300);
        QCOMPARE(server.denied, 1);
        QCOMPARE(server.streams, 0);
    }

    void standIn_noServerIsNotADenial()
    {
        // A port nobody listens on.
        QTcpServer probe;
        QVERIFY(probe.listen(QHostAddress::LocalHost));
        const quint16 port = probe.serverPort();
        probe.close();
        ServerLink link;
        QVERIFY(ServerLink::parse(QStringLiteral("http://127.0.0.1:%1/?t=x").arg(port), &link));
        BoardClient client;
        QSignalSpy failed(&client, &BoardClient::loginFailed);
        client.start(link);
        QVERIFY(failed.wait(5000));
        QCOMPARE(failed[0][1].toBool(), false);
    }

    void standIn_aDroppedStreamIsTakenUpAgain()
    {
        StandIn server; // drops every stream after its first frame
        QVERIFY(server.listen(QHostAddress::LocalHost));
        ServerLink link;
        QVERIFY(ServerLink::parse(server.link(), &link));
        BoardClient client;
        QSignalSpy states(&client, &BoardClient::state);
        QSignalSpy online(&client, &BoardClient::onlineChanged);
        QSignalSpy in(&client, &BoardClient::loggedIn);
        client.start(link);
        // The first wait is about a second (backoff 1 s plus up to a quarter).
        QVERIFY(QTest::qWaitFor([&] { return states.count() >= 2; }, 6000));
        QCOMPARE(states[1][0].value<State>().cards[0].id, "c2");
        QVERIFY(server.logins >= 2);   // it logs in anew before listening again
        QCOMPARE(in.count(), 1);       // but says so only once
        QVERIFY(online.count() >= 3);  // on, off, on
        QCOMPARE(online[0][0].toBool(), true);
        QCOMPARE(online[1][0].toBool(), false);
        client.stop();
        QVERIFY(!client.online());
        const int streams = server.streams;
        QTest::qWait(1600);
        QCOMPARE(server.streams, streams); // stopped means stopped
    }

    void standIn_aBrokenFrameIsSkipped()
    {
        StandIn server;
        server.dropStreams = false;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        ServerLink link;
        QVERIFY(ServerLink::parse(server.link(), &link));
        BoardClient client;
        QSignalSpy states(&client, &BoardClient::state);
        client.start(link);
        QVERIFY(states.wait(5000));
        server.push("{broken");
        server.push("{\"cards\":[{\"id\":\"later\"}]}");
        QVERIFY(QTest::qWaitFor([&] { return states.count() >= 2; }, 5000));
        QCOMPARE(states.count(), 2);
        QCOMPARE(states[1][0].value<State>().cards[0].id, "later");
        QVERIFY(client.online());
        client.stop();
    }

    void standIn_postsCarryOriginAndCookie()
    {
        StandIn server;
        server.dropStreams = false;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        ServerLink link;
        QVERIFY(ServerLink::parse(server.link(), &link));
        BoardClient client;
        QSignalSpy states(&client, &BoardClient::state);
        client.start(link);
        QVERIFY(states.wait(5000));
        Answer a, b, c, d;
        client.decide("c1", {"ja"}, false, "eine Anmerkung", 0, a.take());
        QVERIFY(a.wait());
        QVERIFY2(a.ok, qPrintable(a.error));
        client.reopen("c1", b.take());
        QVERIFY(b.wait() && b.ok);
        client.sendMessage("Hallo Ä", "web", {}, c.take());
        QVERIFY(c.wait() && c.ok);
        client.decide("gone", {"ja"}, false, "", 0, d.take());
        QVERIFY(d.wait());
        QVERIFY(!d.ok && !d.stale);
        QCOMPARE(d.status, 400);
        QCOMPARE(d.error, "This question is no longer there.");
        QCOMPARE(server.denied, 0);
        QCOMPARE(server.posts.size(), 4);
        const QByteArray origin = " origin=" + link.origin().toUtf8() + " ";
        QCOMPARE(server.posts[0], "/decide" + origin + R"({"card_id":"c1","key":"ja","note":"eine Anmerkung","revised":null})");
        QCOMPARE(server.posts[1], "/reopen" + origin + R"({"card_id":"c1"})");
        QCOMPARE(server.posts[2], "/message" + origin + QStringLiteral(R"({"agent":"web","text":"Hallo Ä"})").toUtf8());
        client.stop();
    }

    void standIn_whatTheProductSendsToday()
    {
        StandIn server;
        server.dropStreams = false;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        ServerLink link;
        QVERIFY(ServerLink::parse(server.link(), &link));
        BoardClient client;
        QSignalSpy states(&client, &BoardClient::state);
        client.start(link);
        QVERIFY(states.wait(5000));
        const QByteArray origin = " origin=" + link.origin().toUtf8() + " ";
        auto sent = [&](Answer &a) { return a.wait() && a.ok ? server.posts.last() : QByteArray("failed: ") + a.error.toUtf8(); };

        // Several answers at once, with the wording the human saw.
        Answer many;
        client.decide("c1", {"lint", "e2e"}, true, "", 1790930000000.0, many.take());
        QCOMPARE(sent(many), "/decide" + origin + R"({"card_id":"c1","key":"lint","keys":["lint","e2e"],"note":"","revised":1790930000000})");
        // A question back about a card, instead of an answer to it.
        Answer ask;
        client.sendMessage("Why?", "web", "c1", ask.take());
        QCOMPARE(sent(ask), "/message" + origin + R"({"agent":"web","card_id":"c1","text":"Why?"})");
        // "Explain" and "Back to agent": the same route, with the turn named.
        Answer what, hand;
        client.sendMessage("Explain it.", "web", "c1", what.take(), "explain");
        QCOMPARE(sent(what), "/message" + origin + R"({"agent":"web","card_id":"c1","explain":true,"text":"Explain it."})");
        client.sendMessage("Not like this.", "web", "c1", hand.take(), "handback");
        QCOMPARE(sent(hand), "/message" + origin + R"({"agent":"web","card_id":"c1","handback":true,"text":"Not like this."})");
        Answer draft;
        client.draft("c1", {"lint"}, "half a ", draft.take());
        QCOMPARE(sent(draft), "/draft" + origin + R"({"card_id":"c1","keys":["lint"],"note":"half a "})");
        Answer star;
        client.star("web", true, star.take());
        QCOMPARE(sent(star), "/star" + origin + R"({"agent":"web","starred":true})");
        // Pair, order, mark, name: one route.
        Answer pair, move;
        client.session("web", {{"group", "g1"}}, pair.take());
        QCOMPARE(sent(pair), "/session" + origin + R"({"agent":"web","group":"g1"})");
        client.session("web", {{"before", QJsonValue::Null}}, move.take());
        QCOMPARE(sent(move), "/session" + origin + R"({"agent":"web","before":null})");

        // The agent reworded the card meanwhile: refused, and said so as what it is.
        Answer stale;
        client.decide("reworded", {"ja"}, false, "", 5, stale.take());
        QVERIFY(stale.wait());
        QVERIFY(!stale.ok && stale.stale);
        QCOMPARE(stale.status, 409);
        QVERIFY(stale.error.startsWith("The agent revised this question"));
        // Another 409 is no rewording.
        Answer late;
        client.decide("answered", {"ja"}, false, "", 0, late.take());
        QVERIFY(late.wait());
        QVERIFY(!late.ok && !late.stale);
        QCOMPARE(late.error, "This question is already answered.");
        client.stop();
    }

    // ── against the real server ─────────────────────────────────────────
    void real_wrongTokenIsDenied()
    {
        if (!haveReal) QSKIP("TROMMI_TEST_URL is not set");
        ServerLink wrong = real;
        wrong.token += "-wrong";
        BoardClient client;
        QSignalSpy failed(&client, &BoardClient::loginFailed);
        client.start(wrong);
        QVERIFY(failed.wait(5000));
        QCOMPARE(failed[0][1].toBool(), true);
    }

    void real_loginStreamDecideReopenMessage()
    {
        if (!haveReal) QSKIP("TROMMI_TEST_URL is not set");
        BoardClient client;
        State latest;
        int frames = 0;
        connect(&client, &BoardClient::state, this, [&](const State &s) { latest = s; frames++; });
        QSignalSpy in(&client, &BoardClient::loggedIn);
        client.start(real);
        QVERIFY2(QTest::qWaitFor([&] { return frames >= 1; }, 8000), "no state from the real server");
        QCOMPARE(in.count(), 1);
        QVERIFY(client.online());
        // The cookie carries the port in its name.
        QCOMPARE(client.cookie().name, QStringLiteral("board_%1").arg(real.base.port()));
        QCOMPARE(client.cookie().value, real.token);

        // The demo data: several open cards, the most urgent first. (The
        // server closes the demo's approval on start: nobody waits for it.)
        QVERIFY(latest.queue.size() >= 3);
        QVERIFY(!latest.agents.isEmpty());
        const QList<Card> open = openCards(latest);
        QCOMPARE(open.size(), latest.queue.size());
        for (const Card &c : open) QVERIFY(rank(open.first().urgency) >= rank(c.urgency));
        QCOMPARE(open.first().urgency, Urgency::Critical);
        QVERIFY(!groups(latest, {}).isEmpty());

        // Decide a decision card with a note; the stream reports it.
        const Card *pick = nullptr;
        for (const Card &c : open)
            if (!c.permission() && !c.options.isEmpty()) { pick = &c; break; }
        QVERIFY(pick);
        const QString id = pick->id, key = pick->options.last().key, agent = pick->agent;
        const int openBefore = latest.queue.size();
        Answer a;
        client.decide(id, {key}, false, "vom Linux-Test", 0, a.take());
        QVERIFY(a.wait());
        QVERIFY2(a.ok, qPrintable(a.error));
        QVERIFY(QTest::qWaitFor([&] { return latest.card(id) && !latest.card(id)->open(); }, 5000));
        QCOMPARE(latest.card(id)->status, "decided");
        QCOMPARE(latest.card(id)->choice, key);
        QCOMPARE(latest.card(id)->note, "vom Linux-Test");
        QCOMPARE(latest.queue.size(), openBefore - 1);
        QVERIFY(!latest.queue.contains(id));

        // Deciding it again is refused, in German.
        Answer again;
        client.decide(id, {key}, false, "", 0, again.take());
        QVERIFY(again.wait());
        QVERIFY(!again.ok);
        QCOMPARE(again.error, "This question is already answered.");

        // An option that does not exist, on another card.
        Answer bad;
        client.decide(open.first().id, {"no-such-key"}, false, "", 0, bad.take());
        QVERIFY(bad.wait());
        QVERIFY(!bad.ok);
        QVERIFY(!bad.error.isEmpty());

        // Take the answer back: the card is open again and back in the queue.
        Answer r;
        client.reopen(id, r.take());
        QVERIFY(r.wait());
        QVERIFY2(r.ok, qPrintable(r.error));
        QVERIFY(QTest::qWaitFor([&] { return latest.card(id) && latest.card(id)->open(); }, 5000));
        QVERIFY(latest.queue.contains(id));
        QCOMPARE(latest.queue.size(), openBefore);

        // A message to that card's session shows up in its conversation.
        const QString text = QStringLiteral("Hallo vom Linux-Client äöü %1").arg(QDateTime::currentMSecsSinceEpoch());
        Answer m;
        client.sendMessage(text, agent, {}, m.take());
        QVERIFY(m.wait());
        QVERIFY2(m.ok, qPrintable(m.error));
        auto arrived = [&] {
            for (const Message &msg : latest.messages)
                if (msg.text == text && msg.from == "user" && msg.agent == agent) return true;
            return false;
        };
        QVERIFY(QTest::qWaitFor(arrived, 5000));

        // An empty message is refused.
        Answer e;
        client.sendMessage("   ", agent, {}, e.take());
        QVERIFY(e.wait());
        QVERIFY(!e.ok);
        QCOMPARE(e.error, "The message is empty.");
        client.stop();
    }

    // The contracts the product got since: several answers at once, an agent
    // that rewords a card while the human answers (409), handing a card back.
    // Needs a session of its own on that board to play the agent
    // (bin/test-live links one and names dev/session.mjs in TROMMI_TEST_SESSION).
    void real_multiSelectRevisedAndHandedBack()
    {
        const QString script = qEnvironmentVariable("TROMMI_TEST_SESSION");
        if (!haveReal || script.isEmpty()) QSKIP("TROMMI_TEST_URL and TROMMI_TEST_SESSION are not set");
        auto agent = [&](const QString &tool, const QJsonObject &args) {
            QProcess p;
            p.start("node", {script, "call", "fixture", tool, QJsonDocument(args).toJson(QJsonDocument::Compact)});
            if (!p.waitForFinished(10000) || p.exitCode() != 0) return QString("failed: " + p.readAllStandardError() + p.readAllStandardOutput());
            return QString::fromUtf8(p.readAllStandardOutput()).trimmed();
        };
        BoardClient client;
        State latest;
        connect(&client, &BoardClient::state, this, [&](const State &s) { latest = s; });
        client.start(real);
        QVERIFY(QTest::qWaitFor([&] { return latest.agent("fixture") != nullptr; }, 8000));
        auto byTitle = [&](const QString &title) -> const Card * {
            for (const Card &c : latest.cards)
                if (c.title == title) return &c;
            return nullptr;
        };
        const QJsonArray options{QJsonObject{{"key", "lint"}, {"label", "Lint"}}, QJsonObject{{"key", "unit"}, {"label", "Unit tests"}}, QJsonObject{{"key", "e2e"}, {"label", "End to end"}}};

        // Several answers allowed, two of them advised.
        QVERIFY2(!agent("create_decision", {{"title", "Which checks?"}, {"body", "Tick them."}, {"options", options}, {"multiple", true}, {"recommended", QJsonArray{"lint", "e2e"}}}).startsWith("failed"), "the fixture session could not file a card");
        QVERIFY(QTest::qWaitFor([&] { return byTitle("Which checks?") != nullptr; }, 5000));
        const Card multi = *byTitle("Which checks?");
        QVERIFY(multi.multiple);
        QCOMPARE(multi.recommended, QStringList({"lint", "e2e"}));
        // A draft is kept on the hub, so another device shows the same ticks.
        Answer d;
        client.draft(multi.id, {"unit"}, "half a ", d.take());
        QVERIFY(d.wait() && d.ok);
        QVERIFY(QTest::qWaitFor([&] { return byTitle("Which checks?")->draft.keys == QStringList{"unit"}; }, 5000));
        QCOMPARE(byTitle("Which checks?")->draft.note, "half a ");
        Answer a;
        client.decide(multi.id, {"lint", "e2e"}, true, "", multi.revised, a.take());
        QVERIFY(a.wait());
        QVERIFY2(a.ok, qPrintable(a.error));
        QVERIFY(QTest::qWaitFor([&] { return !byTitle("Which checks?")->open(); }, 5000));
        QCOMPARE(byTitle("Which checks?")->choices, QStringList({"lint", "e2e"}));
        QVERIFY(byTitle("Which checks?")->draft.empty());
        QCOMPARE(inboxOf(latest, {}).answered.first().id, multi.id);

        // The agent rewords a card the human is looking at: the answer to the old wording is refused.
        QVERIFY(!agent("create_decision", {{"title", "Old wording?"}, {"options", options}}).startsWith("failed"));
        QVERIFY(QTest::qWaitFor([&] { return byTitle("Old wording?") != nullptr; }, 5000));
        const Card old = *byTitle("Old wording?");
        QCOMPARE(old.revised, 0.0);
        QCOMPARE(old.version, 1);
        QVERIFY2(!agent("revise_card", {{"card_id", old.id}, {"title", "New wording?"}, {"note", "clearer"}}).startsWith("failed"), "revise_card failed");
        QVERIFY(QTest::qWaitFor([&] { return byTitle("New wording?") != nullptr; }, 5000));
        const Card fresh = *byTitle("New wording?");
        QCOMPARE(fresh.id, old.id); // one card through its whole life
        QVERIFY(fresh.revised > 0);
        QCOMPARE(fresh.version, 2);
        QCOMPARE(fresh.earlier, 1);
        QCOMPARE(cardNote(fresh), "revised");
        Answer stale;
        client.decide(old.id, {"lint"}, false, "", old.revised, stale.take());
        QVERIFY(stale.wait());
        QVERIFY(!stale.ok);
        QCOMPARE(stale.status, 409);
        QVERIFY(stale.stale);
        QVERIFY(byTitle("New wording?")->open()); // nothing was sent

        // Handed back: the card is with the agent, on every device, until the session rewords it.
        Answer h;
        client.sendMessage("Shorter, please.", "fixture", fresh.id, h.take(), "handback");
        QVERIFY(h.wait() && h.ok);
        QVERIFY(QTest::qWaitFor([&] { return byTitle("New wording?")->withAgent > 0; }, 5000));
        QCOMPARE(inboxOf(latest, {}).asked.size(), 1);
        QVERIFY(!inboxOrder(latest, {}).contains(fresh.id));
        QCOMPARE(threadOf(latest, fresh.id).size(), 1);
        QVERIFY(!agent("revise_card", {{"card_id", fresh.id}, {"title", "Short?"}}).startsWith("failed"));
        QVERIFY(QTest::qWaitFor([&] { return byTitle("Short?") && byTitle("Short?")->withAgent == 0; }, 5000));
        QVERIFY(inboxOrder(latest, {}).contains(fresh.id));
        // Read again and answered once more, past the moment the server gives the eye: taken.
        QTest::qWait(1700);
        Answer again;
        client.decide(fresh.id, {"unit"}, false, "", byTitle("Short?")->revised, again.take());
        QVERIFY(again.wait());
        QVERIFY2(again.ok, qPrintable(again.error));

        // Laid together, crowned, moved: the next state says so.
        Answer g1, g2, st, mv;
        const QString other = latest.agents.first().id == "fixture" ? latest.agents.last().id : latest.agents.first().id;
        client.session("fixture", {{"group", "g-test"}}, g1.take());
        client.session(other, {{"group", "g-test"}}, g2.take());
        client.star("fixture", true, st.take());
        QVERIFY(g1.wait() && g1.ok && g2.wait() && g2.ok && st.wait() && st.ok);
        QVERIFY(QTest::qWaitFor([&] { return latest.groups.size() == 1 && latest.agent("fixture")->starred; }, 5000));
        QCOMPARE(units(latest).size(), latest.agents.size() - 1);
        client.session("fixture", {{"before", other}}, mv.take());
        QVERIFY(mv.wait() && mv.ok);
        QVERIFY(QTest::qWaitFor([&] { return latest.agents.first().id == "fixture"; }, 5000));
        client.stop();
    }
};

QTEST_GUILESS_MAIN(TestLive)
#include "tst_live.moc"
