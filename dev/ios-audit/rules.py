"""rules.py: the layout rules of the iOS audit, one engine for every source (README of this folder: the top of device.py).

A layout dump (JSON) describes one screen at rest:

    {"name": "desk", "source": "device" | "in-app",
     "screen": {"w": 420, "h": 912, "scale": 3},              # points
     "safe": {"top": 62, "bottom": 34, "left": 0, "right": 0},
     "screenshot": "desk.png",                                 # optional, next to the dump
     "elements": [{"label": "Send", "rect": [x, y, w, h], "interactive": true, "text": false,
                   "chrome": false, "traits": ["button"], "truncated": false, "state": "rest" | "end"}],
     "apple": [{"type": "testTypeHitRegion", "rect": [x, y, w, h], "text": "...", "info": "...", "font": 11}]}

"chrome" marks floating glass the system or the app keeps above the content (tab capsule, pills, toolbars).
"state": "end" marks elements captured with every scroll view scrolled to its end (in-app probe): content that is
still under the chrome there can never be reached.

check(dump) returns the problems, each {"rule", "severity" (error | warn | info), "text", "rects": [[x, y, w, h], ...]}.
draw(dump, problems, png_in, png_out) puts numbered boxes on the screenshot. Pure Python; Pillow only for drawing.
"""
from __future__ import annotations

import html
import json
import os

MIN_TARGET = 44.0           # HIG: hit targets at least 44 x 44 pt
TINY_TARGET = 28.0          # below this on either side: an error, not a warning
OVERLAP_MIN_AREA = 25.0     # pt^2; smaller touches are rounding
UNDER_CHROME_SHARE = 0.3    # share of a text element hidden under glass that counts

APPLE = {
    # Apple's on-device audit (Accessibility Inspector's checks), mapped to our severities
    'testTypeHitRegion': ('warn', 'hit region too small (Apple audit)'),
    'testTypeTextClipped': ('warn', 'text clipped (Apple audit)'),
    'testTypeDynamicText': ('warn', 'does not scale with Dynamic Type (Apple audit)'),
    'testTypeContrast': ('info', 'low contrast (Apple audit; on glass often a sampling artefact, check by eye)'),
    'testTypeElementDetection': ('warn', 'visible element not reachable by VoiceOver (Apple audit)'),
    'testTypeSufficientElementDescription': ('warn', 'description missing or too short (Apple audit)'),
    'testTypeTrait': ('info', 'traits look wrong (Apple audit)'),
}


def area(r):
    return max(0.0, r[2]) * max(0.0, r[3])


def inter(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    return [x1, y1, x2 - x1, y2 - y1] if x2 > x1 and y2 > y1 else None


def contains(a, b, slack=0.5):
    return a[0] - slack <= b[0] and a[1] - slack <= b[1] and a[0] + a[2] + slack >= b[0] + b[2] and a[1] + a[3] + slack >= b[1] + b[3]


def same(a, b, slack=1.0):
    return all(abs(a[i] - b[i]) <= slack for i in range(4))


def name(e):
    return (e.get('label') or e.get('text_value') or '(no label)').replace('\n', ' ')[:60]


def check(dump):
    W, H = dump['screen']['w'], dump['screen']['h']
    safe = dump.get('safe', {})
    top, bottom = safe.get('top', 0), safe.get('bottom', 0)
    els = [e for e in dump.get('elements', []) if area(e['rect']) > 0]
    chrome = [e for e in els if e.get('chrome')]
    out = []

    def add(rule, sev, text, *rects):
        out.append({'rule': rule, 'severity': sev, 'text': text, 'rects': [list(map(float, r)) for r in rects]})

    inter_els = [e for e in els if e.get('interactive')]
    # R1: interactive elements overlapping each other (a tap can land on the wrong one)
    for i, a in enumerate(inter_els):
        for b in inter_els[i + 1:]:
            if a.get('state', 'rest') != b.get('state', 'rest'):
                continue
            ab = inter(a['rect'], b['rect'])
            if not ab or area(ab) < OVERLAP_MIN_AREA or same(a['rect'], b['rect']):
                continue
            if contains(a['rect'], b['rect']) or contains(b['rect'], a['rect']):
                add('nested-controls', 'info', f'"{name(a)}" and "{name(b)}": one control inside another', a['rect'], b['rect'])
            else:
                both_chrome = a.get('chrome') and b.get('chrome')
                add('overlap', 'warn' if both_chrome else 'error', f'"{name(a)}" overlaps "{name(b)}" ({area(ab):.0f} pt²)', a['rect'], b['rect'])
    # R2: tap targets under 44 pt
    for e in inter_els:
        w, h = e.get('hit', e['rect'])[2:4]
        if w < MIN_TARGET or h < MIN_TARGET:
            sev = 'error' if min(w, h) < TINY_TARGET else 'warn'
            add('small-target', sev, f'"{name(e)}" is {w:.0f}×{h:.0f} pt (at least 44×44)', e.get('hit', e['rect']))
    # R3: under the status bar / Dynamic Island or the home indicator (not chrome, which is meant to sit there)
    zones = [('status bar / Dynamic Island', [0, 0, W, top]), ('home indicator', [0, H - bottom, W, bottom])]
    for e in els:
        if e.get('chrome') or e.get('state') == 'end':
            continue
        for zname, z in zones:
            if z[3] <= 0:
                continue
            zi = inter(e['rect'], z)
            if zi and area(zi) >= 0.5 * area(e['rect']):
                add('safe-area', 'error' if e.get('interactive') else 'warn', f'"{name(e)}" lies under the {zname}', e['rect'], z)
    # R4: content under floating glass
    for e in els:
        if e.get('chrome'):
            continue
        for c in chrome:
            ci = inter(e['rect'], c['rect'])
            if not ci:
                continue
            share = area(ci) / max(1.0, area(e['rect']))
            at_end = e.get('state') == 'end'
            if e.get('interactive') and share > 0.15:
                add('under-chrome', 'error' if at_end else 'info',
                    f'"{name(e)}" is {share:.0%} under "{name(c)}"' + (' even scrolled to the end: unreachable' if at_end else ' (at rest)'), e['rect'], c['rect'])
            elif e.get('text') and share > UNDER_CHROME_SHARE and at_end:
                add('under-chrome', 'warn', f'text "{name(e)}" stays {share:.0%} under "{name(c)}" scrolled to the end', e['rect'], c['rect'])
    # R7: text drawn over other text (a banner or badge over a row, a label running into its neighbour)
    texts = [e for e in els if e.get('text') and not e.get('interactive')]
    for i, a in enumerate(texts):
        for b in texts[i + 1:]:
            if a.get('state', 'rest') != b.get('state', 'rest') or same(a['rect'], b['rect']):
                continue
            ab = inter(a['rect'], b['rect'])
            if ab and area(ab) >= OVERLAP_MIN_AREA and not (contains(a['rect'], b['rect']) or contains(b['rect'], a['rect'])):
                add('text-over-text', 'warn', f'text "{name(a)}" runs into text "{name(b)}"', a['rect'], b['rect'])
    # VoiceOver walk (device): a focusable element whose spoken caption has no words before its trait
    for cap in dump.get('focus', []):
        words = [w.strip() for w in (cap or '').split(',')]
        if words and words[0] in ('Button', 'Link', 'Image', ''):
            add('no-label', 'warn', f'VoiceOver reads only "{cap}": the control has no label')
    # R5: clipped text the probe could see (UILabel), R6: interactive without a label
    for e in els:
        if e.get('truncated'):
            add('clipped', 'warn', f'"{name(e)}" is truncated', e['rect'])
        if e.get('interactive') and not (e.get('label') or '').strip():
            add('no-label', 'warn', 'a control without an accessibility label', e['rect'])
    # Apple's audit, as it came
    seen = []
    for a in dump.get('apple', []):
        sev, word = APPLE.get(a.get('type'), ('info', a.get('type', 'Apple audit')))
        r = a.get('rect') or [0, 0, 0, 0]
        key = (a.get('type'), tuple(round(v) for v in r))
        if key in seen:
            continue
        seen.append(key)
        detail = a.get('text') or ''
        info = a.get('info') or ''
        # Dynamic Type findings are measured while the audit sweeps the text sizes: their frames belong to another layout
        boxed = area(r) > 0 and a.get('type') != 'testTypeDynamicText'
        add('apple:' + a.get('type', '?').replace('testType', ''), sev, f'{word}' + (f': "{detail[:70]}"' if detail else '') + (f' — {info[:120]}' if info else ''), *([r] if boxed else []))
    order = {'error': 0, 'warn': 1, 'info': 2}
    out.sort(key=lambda p: (order[p['severity']], p['rule']))
    return out


COLORS = {'error': (229, 57, 53), 'warn': (245, 166, 35), 'info': (66, 133, 244)}


def draw(dump, problems, png_in, png_out, min_severity='warn'):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.open(png_in).convert('RGB')
    s = img.width / dump['screen']['w']
    d = ImageDraw.Draw(img, 'RGBA')
    font = None
    for f in ('DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
        try:
            font = ImageFont.truetype(f, int(11 * s))
            break
        except OSError:
            pass
    if font is None:
        try:
            font = ImageFont.load_default(size=int(11 * s))
        except TypeError:
            font = ImageFont.load_default()
    keep = {'error': 0, 'warn': 1, 'info': 2}
    for n, p in enumerate(problems, 1):
        if keep[p['severity']] > keep[min_severity]:
            continue
        c = COLORS[p['severity']]
        for k, r in enumerate(p['rects'][:1] if p['rule'] in ('safe-area',) else p['rects']):
            box = [r[0] * s, r[1] * s, (r[0] + r[2]) * s, (r[1] + r[3]) * s]
            d.rectangle(box, outline=c + (255,), width=max(2, int(s)), fill=c + (28,))
            if k == 0:
                tag = str(n)
                tw = d.textlength(tag, font=font)
                d.rectangle([box[0], box[1] - 15 * s, box[0] + tw + 6 * s, box[1]], fill=c + (230,))
                d.text((box[0] + 3 * s, box[1] - 14 * s), tag, fill=(255, 255, 255), font=font)
    img.save(png_out)


def report_html(title, pages):
    """pages: [{"name", "png" (annotated, relative), "problems", "dump"}] -> one HTML page."""
    rows = []
    for pg in pages:
        items = ''.join(f'<li class="{p["severity"]}"><b>{i}</b> <span>{html.escape(p["rule"])}</span> {html.escape(p["text"])}</li>'
                        for i, p in enumerate(pg['problems'], 1))
        counts = {s: sum(1 for p in pg['problems'] if p['severity'] == s) for s in ('error', 'warn', 'info')}
        rows.append(f'''<section><h2>{html.escape(pg["name"])} <small>{counts["error"]} errors · {counts["warn"]} warnings · {counts["info"]} notes · {html.escape(pg["dump"].get("source", ""))} {pg["dump"]["screen"]["w"]:.0f}×{pg["dump"]["screen"]["h"]:.0f}</small></h2>
<div class="pair"><img src="{html.escape(pg["png"])}" alt="{html.escape(pg["name"])}"><ol>{items or "<li>nothing found</li>"}</ol></div></section>''')
    return f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>
<style>:root{{--bg:#f5f6f2;--fg:#141c18;--mut:#5c6862}}@media (prefers-color-scheme:dark){{:root{{--bg:#0e1311;--fg:#e9eeea;--mut:#9aa8a0}}}}
body{{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 16px 40px}}h1{{font-size:22px}}h2{{font-size:17px}}small{{color:var(--mut);font-weight:400}}
.pair{{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}}img{{width:320px;max-width:100%;border-radius:18px;border:1px solid #8884}}ol{{list-style:none;padding:0;margin:0;flex:1;min-width:260px}}
li{{padding:4px 0;border-bottom:1px solid #8882}}li b{{display:inline-block;min-width:22px;text-align:center;color:#fff;border-radius:4px;margin-right:6px}}li span{{color:var(--mut);margin-right:6px}}
li.error b{{background:#e53935}}li.warn b{{background:#f5a623}}li.info b{{background:#4285f4}}</style>
<h1>{html.escape(title)}</h1>{''.join(rows)}'''


def run_dir(folder, title='iOS layout audit'):
    """Check every *.layout.json in a folder (with its screenshot), write *.annotated.png, report.json and report.html."""
    pages = []
    for f in sorted(os.listdir(folder)):
        if not f.endswith('.layout.json'):
            continue
        dump = json.load(open(os.path.join(folder, f)))
        probs = check(dump)
        base = f[:-len('.layout.json')]
        png = dump.get('screenshot') or base + '.png'
        annotated = base + '.annotated.png'
        if os.path.exists(os.path.join(folder, png)):
            draw(dump, probs, os.path.join(folder, png), os.path.join(folder, annotated))
        else:
            annotated = ''
        pages.append({'name': dump.get('name', base), 'png': annotated, 'problems': probs, 'dump': dump})
    json.dump([{'name': p['name'], 'problems': p['problems']} for p in pages], open(os.path.join(folder, 'report.json'), 'w'), indent=1)
    open(os.path.join(folder, 'report.html'), 'w').write(report_html(title, pages))
    return pages


if __name__ == '__main__':
    import sys
    pages = run_dir(sys.argv[1] if len(sys.argv) > 1 else '.')
    for p in pages:
        e = sum(1 for x in p['problems'] if x['severity'] == 'error')
        w = sum(1 for x in p['problems'] if x['severity'] == 'warn')
        print(f'{p["name"]}: {e} errors, {w} warnings')
