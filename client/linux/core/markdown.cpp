#include "markdown.h"

#include <QRegularExpression>
#include <QStringList>

namespace trommi {

QList<Inline> parseInline(const QString &text)
{
    static const QRegularExpression re(QStringLiteral("(`[^`\\n]+`)|(\\*\\*[^*\\n]+\\*\\*)|(https?://[^\\s<>)]+)"));
    QList<Inline> out;
    auto plain = [&](const QString &t) {
        if (!t.isEmpty()) out.append({Inline::Text, t});
    };
    qsizetype last = 0;
    auto it = re.globalMatch(text);
    while (it.hasNext()) {
        const auto m = it.next();
        plain(text.mid(last, m.capturedStart() - last));
        if (m.hasCaptured(1)) {
            const QString c = m.captured(1);
            out.append({Inline::Code, c.mid(1, c.size() - 2)});
        } else if (m.hasCaptured(2)) {
            const QString b = m.captured(2);
            out.append({Inline::Bold, b.mid(2, b.size() - 4)});
        } else {
            out.append({Inline::Link, m.captured(3)});
        }
        last = m.capturedEnd();
    }
    plain(text.mid(last));
    return out;
}

QList<Block> parseMarkdown(const QString &text)
{
    static const QRegularExpression fence(QStringLiteral("```[^\\n]*\\n?"));
    static const QRegularExpression blank(QStringLiteral("\\n{2,}"));
    static const QRegularExpression bullet(QStringLiteral("^\\s*[-*]\\s+"));
    QList<Block> out;
    const QStringList chunks = text.split(fence);
    for (int i = 0; i < chunks.size(); i++) {
        if (i % 2) { // between two fences
            QString code = chunks[i];
            if (code.endsWith('\n')) code.chop(1);
            Block b;
            b.kind = Block::CodeBlock;
            b.code = code;
            out.append(b);
            continue;
        }
        for (const QString &part : chunks[i].split(blank)) {
            QStringList lines;
            for (const QString &l : part.split('\n'))
                if (!l.trimmed().isEmpty()) lines.append(l);
            if (lines.isEmpty()) continue;
            bool all = true;
            for (const QString &l : lines)
                if (!bullet.match(l).hasMatch()) all = false;
            Block b;
            // A table as agents write it: rows of cells between pipes, a rule of dashes under the first.
            static const QRegularExpression piped(QStringLiteral("^\\s*\\|.*\\|\\s*$"));
            static const QRegularExpression rule(QStringLiteral("^\\s*\\|?[\\s:|-]*-[\\s:|-]*\\|?\\s*$"));
            bool table = lines.size() > 1 && rule.match(lines[1]).hasMatch();
            for (const QString &l : lines)
                if (!piped.match(l).hasMatch()) table = false;
            if (table) {
                b.kind = Block::Table;
                for (int r = 0; r < lines.size(); r++) {
                    if (r == 1) continue;
                    QString l = lines[r].trimmed();
                    if (l.startsWith('|')) l.remove(0, 1);
                    if (l.endsWith('|')) l.chop(1);
                    QList<QList<Inline>> cells;
                    for (const QString &cell : l.split('|')) cells.append(parseInline(cell.trimmed()));
                    b.rows.append(cells);
                }
            } else if (all) {
                b.kind = Block::Bullets;
                for (QString l : lines) b.items.append(parseInline(l.remove(bullet)));
            } else {
                b.kind = Block::Paragraph;
                b.inlines = parseInline(lines.join('\n'));
            }
            out.append(b);
        }
    }
    return out;
}

static QString escaped(const QString &t)
{
    QString e = t.toHtmlEscaped();
    e.replace('\n', QStringLiteral("<br>"));
    return e;
}

QString toHtml(const QList<Inline> &inlines, const HtmlStyle &style)
{
    QString html;
    for (const Inline &in : inlines) {
        const QString t = escaped(in.text);
        switch (in.kind) {
        case Inline::Text:
            html += t;
            break;
        case Inline::Bold:
            html += "<b>" + t + "</b>";
            break;
        case Inline::Code: {
            QString css = "font-family:'" + style.monoFamily.toHtmlEscaped() + "';";
            if (!style.codeBackground.isEmpty()) css += "background-color:" + style.codeBackground + ";";
            html += "<span style=\"" + css + "\">&nbsp;" + t + "&nbsp;</span>";
            break;
        }
        case Inline::Link: {
            const QString color = style.linkColor.isEmpty() ? QString() : " style=\"color:" + style.linkColor + ";\"";
            html += "<a href=\"" + t + "\"" + color + ">" + t + "</a>";
            break;
        }
        }
    }
    return html;
}

} // namespace trommi
