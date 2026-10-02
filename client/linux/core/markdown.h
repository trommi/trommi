// The light markdown agents write: paragraphs, bullet lists, **bold**,
// `code`, fenced code blocks, tables and bare links. Parses to plain values; the
// view decides how they look. Follows rich() and inline() in
// client/web/js/ui.js.
#pragma once

#include <QList>
#include <QString>

namespace trommi {

struct Inline {
    enum Kind { Text, Bold, Code, Link } kind = Text;
    QString text;
    bool operator==(const Inline &) const = default;
};

struct Block {
    enum Kind { Paragraph, Bullets, CodeBlock, Table } kind = Paragraph;
    QList<Inline> inlines;       // Paragraph
    QList<QList<Inline>> items;  // Bullets
    QString code;                // CodeBlock
    QList<QList<QList<Inline>>> rows; // Table: the head row first, then the others
    bool operator==(const Block &) const = default;
};

QList<Inline> parseInline(const QString &text);
QList<Block> parseMarkdown(const QString &text);

// Inlines as the small HTML subset Qt's rich text draws, with everything
// the agent wrote escaped: no markup of its own gets through.
struct HtmlStyle {
    QString monoFamily = "monospace";
    QString codeBackground; // empty: none
    QString linkColor;      // empty: the default
};
QString toHtml(const QList<Inline> &inlines, const HtmlStyle &style = {});

} // namespace trommi
