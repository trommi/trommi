"""device.py: the iOS layout audit on the real iPhone, from Linux, no Xcode, no sudo, nothing installed.

    ~/pymobile3-venv/bin/python dev/ios-audit/device.py --audit         # the screen the phone shows now, Apple's audit
    ~/pymobile3-venv/bin/python dev/ios-audit/device.py --audit --walk  # + what VoiceOver reads (unlabelled controls)
    ~/pymobile3-venv/bin/python dev/ios-audit/device.py --frames        # + every element's frame (~1.5 s per element)
    ~/pymobile3-venv/bin/python dev/ios-audit/device.py --audit --watch 8 --count 10
                                                                        # every 8 s, while you click through the app
                                                                        # (unchanged screens are skipped)
    ~/pymobile3-venv/bin/python dev/ios-audit/device.py --pull          # a probe build's capture (LayoutProbe.swift)
    ~/pymobile3-venv/bin/python dev/ios-audit/device.py --launch sizes  # start the probe build with
                                                                        # TROMMI_LAYOUT_AUDIT=sizes, wait, pull, check
    ~/pymobile3-venv/bin/python dev/ios-audit/rules.py <folder>         # check a folder of *.layout.json again
    python3 dev/ios-audit/test_rules.py                                 # the rules on fixed cases (no phone)

Only with the phone set aside for it: --audit, --walk and --frames drive the phone's accessibility inspector (the
engine of Xcode's Accessibility Inspector). --audit sweeps the text sizes of the front app for a few seconds; --walk
moves the inspector focus (it can scroll the screen; the daemon may still flash its box); --frames shows the inspector's green focus box on the
phone, element by element, and photographs it. Each run switches the inspector off again at its end (no box stays).
Without these flags only a screenshot is taken. Developer services over pymobiledevice3's no-root userspace tunnel;
the phone unlocked, the app in front; udid TROMMI_UDID, default the owner's phone.

What it checks: Apple's audit (hit regions, clipped text, Dynamic Type, contrast, elements VoiceOver cannot reach,
missing descriptions, each with its frame), what VoiceOver reads, and rules.py over the frames (overlap, 44 pt
targets, safe areas, text running into text, content under the floating bar); boxes drawn on the screenshot.
Out: dev/interop/out/ios-audit/<time>/ (report.html, report.json, *.annotated.png; not in git).

The probe build (finer: every element's frame, the glass chrome, scrolled-to-end states, three phone sizes) needs
LayoutProbe.swift linked into the app and one hook in TrommiApp.swift, e.g. beside PerfScript.runIfAsked(model):

    .onAppear { LayoutProbe.runIfAsked(model, root: { RootView() }, pages: [
      ("desk", { model.tab = .desk; model.deskPath = [] }), ("chat", { model.tab = .chat; model.chatPath = [] }),
      ("note", { model.tab = .note }),
      ("card", { model.tab = .desk; if let c = model.view?.fresh.first { model.deskPath = [.card(c.id)] } }),
      ("session", { model.tab = .chat; if let u = model.view?.units.first { model.chatPath = [.session(u.id)] } }),
      ("off", { model.tab = .desk; model.deskPath = [.off] }), ("settings", { model.tab = .desk; model.deskPath = [.settings("agents")] }),
      ("scribble", { model.tab = .desk; model.deskPath = [.scribble] }), ("media", { model.tab = .desk; model.deskPath = [.media] })]) }

then `xtool dev build`, install as usual (a person's step), and `device.py --launch 1` (or `sizes`). In a simulator (a Mac):
`SIMCTL_CHILD_TROMMI_LAYOUT_AUDIT=sizes xcrun simctl launch booted <bundle>`, then copy Documents/layout-audit.json from
`xcrun simctl get_app_container booted <bundle> data` and run `device.py --from <that file>`.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rules  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
UDID = os.environ.get('TROMMI_UDID', '00008150-00084C891138401C')
BUNDLE = os.environ.get('TROMMI_BUNDLE', 'XTL-70CB783D.com.trommi.ios')
PMD = os.environ.get('PYMOBILEDEVICE3', os.path.expanduser('~/pymobile3-venv/bin/pymobiledevice3'))
AUDITS = ['testTypeHitRegion', 'testTypeTextClipped', 'testTypeDynamicText', 'testTypeContrast',
          'testTypeElementDetection', 'testTypeSufficientElementDescription', 'testTypeTrait']

# safe-area insets by screen size in points (portrait); a phone not listed gets the 59/34 of the Dynamic Island phones
SAFE = {(375, 667): (20, 0), (390, 844): (47, 34), (393, 852): (59, 34), (402, 874): (62, 34), (420, 912): (62, 34),
        (428, 926): (47, 34), (430, 932): (59, 34), (440, 956): (62, 34)}


def rect(s):
    """'{{x, y}, {w, h}}' -> [x, y, w, h]"""
    nums = [float(v) for v in s.replace('{', ' ').replace('}', ' ').replace(',', ' ').split()]
    return nums[:4] if len(nums) >= 4 else [0, 0, 0, 0]


TRAITS_INTERACTIVE = {'Button', 'Link', 'Text Field', 'Search Field', 'Adjustable', 'Toggle', 'Switch Button', 'Menu', 'Tab', 'Pop Up Button'}
TRAITS = TRAITS_INTERACTIVE | {'Header', 'Image', 'Selected', 'Dimmed', 'Static Text', 'Heading', 'Not Enabled'}


def parse_caption(c):
    """'Chat, 38 unread, Button, Selected' -> ('Chat, 38 unread', {'Button', 'Selected'})"""
    parts = [p.strip() for p in (c or '').split(',')]
    traits = set()
    while parts and parts[-1] in TRAITS:
        traits.add(parts.pop())
    return ', '.join(parts), traits


def highlight_rect(base, shot, W, H, top):
    """Where the inspector's green focus box is: pixels that turned greener than they were (screen points)."""
    from PIL import Image
    b = base.convert('RGB').resize((W, H), Image.BOX).get_flattened_data()
    s = shot.convert('RGB').resize((W, H), Image.BOX).get_flattened_data()
    rows, cols = [0] * H, [0] * W
    for i, (p, q) in enumerate(zip(b, s)):
        if (q[1] - q[0]) - (p[1] - p[0]) > 6 and (q[1] - q[2]) - (p[1] - p[2]) > -2:
            y, x = divmod(i, W)
            if y >= top:
                rows[y] += 1
                cols[x] += 1
    ys = [y for y, n in enumerate(rows) if n >= 3]
    xs = [x for x, n in enumerate(cols) if n >= 3]
    if not ys or not xs:
        return None
    return [xs[0], ys[0], xs[-1] - xs[0] + 1, ys[-1] - ys[0] + 1]


def moved(a, b, top_share):
    """Did the screen scroll between two pictures? (a few changed pixels, a clock or a badge, do not count)"""
    from PIL import Image
    w, h = 105, 228
    pa = a.convert('L').resize((w, h), Image.BOX).get_flattened_data()
    pb = b.convert('L').resize((w, h), Image.BOX).get_flattened_data()
    start = int(top_share * h) * w
    changed = sum(1 for x, y in zip(pa[start:], pb[start:]) if abs(x - y) > 30)
    return changed > 0.04 * (len(pa) - start)


async def session(out, n, audit, walk, frames, walk_max=80):
    """One connection: the screenshot; with audit Apple's audit; with walk the VoiceOver walk (each element's frame
    with frames). The inspector is always switched off again at the end (no focus box left on the phone)."""
    import io
    from PIL import Image
    from pymobiledevice3.remote import userspace_tunnel
    from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit, Direction, deserialize_object
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot
    rsd = await userspace_tunnel.establish_userspace_rsd(serial=UDID, remotepairing_fallback=False)
    issues, walked = [], []
    try:
        async with DvtProvider(rsd) as dvt, Screenshot(dvt) as shooter:
            png = await shooter.get_screenshot()
            open(os.path.join(out, f'{n:02d}.png'), 'wb').write(png)
            base = Image.open(io.BytesIO(png))
            scale = 3 if base.width >= 1080 else 2
            W, H = round(base.width / scale), round(base.height / scale)
            top = SAFE.get((W, H), (59, 34))[0]
            if not (audit or walk):
                return issues, walked, (W, H, scale)
            async with AccessibilityAudit(rsd) as ax:
                try:
                    if audit:
                        for i in await ax.run_audit(AUDITS):
                            f = i._fields
                            issues.append({'type': f.get('auditTestTypeValue_v1') or i.issue_type, 'rect': rect(f.get('ElementRectValue_v1') or ''),
                                           'text': f.get('ElementTextValue_v1') or '', 'font': f.get('FontSizeValue_v1'),
                                           'info': ' '.join(f.get('ElementLongDescExtraInfo_v1') or []).strip(),
                                           'fg': f.get('ForegroundColorValue_v1'), 'bg': f.get('BackgroundColorValue_v1')})
                    if walk:
                        await walk_focus(ax, shooter, walked, out, n, W, H, top, frames, walk_max, Direction, deserialize_object, Image, io)
                finally:
                    await ax.set_show_visuals(False)
                    await ax.set_app_monitoring_enabled(False)
    finally:
        try:
            await rsd.close()
        except Exception:
            pass
    return issues, walked, (W, H, scale)


async def walk_focus(ax, shooter, walked, out, n, W, H, top, frames, walk_max, Direction, deserialize_object, Image, io):
    await ax.set_app_monitoring_enabled(True)
    await ax.set_monitored_event_type()
    await ax.set_show_visuals(False)   # monitoring alone switches the green focus box on
    seen, ref = set(), None
    await ax.move_focus(Direction.First)
    while len(walked) < walk_max:
        try:
            name, args = await asyncio.wait_for(ax._event_queue.get(), timeout=3)
        except asyncio.TimeoutError:
            break
        if name != 'hostInspectorCurrentElementChanged:':
            continue
        p = deserialize_object(ax._extract_event_payload(args))
        el = p[0] if isinstance(p, list) else p
        ident = el.platform_identifier
        if ident in seen:
            break
        seen.add(ident)
        item = {'caption': el.caption or ''}
        if frames:
            # the focus may have scrolled the screen: a picture without the box, one with it, the difference
            await asyncio.sleep(0.35)
            plain = Image.open(io.BytesIO(await shooter.get_screenshot()))
            await ax.set_show_visuals(True)
            await asyncio.sleep(0.5)
            shot = Image.open(io.BytesIO(await shooter.get_screenshot()))
            await ax.set_show_visuals(False)
            item['rect'] = highlight_rect(plain, shot, W, H, top)
            if ref is None:
                ref = plain
                plain.save(os.path.join(out, f'{n:02d}-frames.png'))
            item['moved'] = moved(ref, plain, top / H)
        walked.append(item)
        await ax.move_focus_next()


def capture(out, n, audit=False, walk=False, frames=False, chrome_labels=(), state='rest'):
    png = f'{n:02d}.png'
    issues, walked, (w, h, scale) = asyncio.run(session(out, n, audit, walk or frames, frames))
    top, bottom = SAFE.get((w, h), (59, 34))
    elements = []
    # Apple's clipped-text and hit-region findings are elements with a trustworthy frame; its Dynamic Type findings are
    # not (it measures them while it sweeps the text sizes, the frames belong to another layout)
    for i in issues:
        if rules.area(i['rect']) > 0 and i['type'] in ('testTypeTextClipped', 'testTypeHitRegion'):
            elements.append({'label': i['text'], 'rect': i['rect'], 'text': i['type'] == 'testTypeTextClipped', 'interactive': False, 'source': i['type'], 'state': state})
    for it in walked:
        if not it.get('rect') or it.get('moved'):
            continue
        label, traits = parse_caption(it['caption'])
        interactive = bool(traits & TRAITS_INTERACTIVE)
        r = it['rect']
        in_bar = r[1] + r[3] / 2 < top + 50   # the navigation bar's items float in glass at the top
        chrome = in_bar or any(label.startswith(c) for c in chrome_labels if c) and r[1] > h * 0.75
        elements.append({'label': label, 'rect': r, 'traits': sorted(traits), 'interactive': interactive, 'text': not interactive,
                         'chrome': chrome, 'source': 'voiceover', 'state': state})
    def dedupe(els):
        uniq = []
        for e in els:
            if not any(rules.same(e['rect'], u['rect']) and e.get('interactive') == u.get('interactive') for u in uniq):
                uniq.append(e)
        return uniq
    screen = {'w': w, 'h': h, 'scale': scale}
    safe = {'top': top, 'bottom': bottom, 'left': 0, 'right': 0}
    apple_els = [e for e in elements if e.get('source', '').startswith('testType')]
    vo_els = [e for e in elements if e.get('source') == 'voiceover']
    json.dump({'name': f'screen {n}: Apple audit', 'source': 'device, Apple audit', 'screen': screen, 'safe': safe, 'screenshot': png,
               'elements': dedupe(apple_els), 'apple': issues, 'at': time.strftime('%H:%M:%S')},
              open(os.path.join(out, f'{n:02d}.layout.json'), 'w'), indent=1)
    if walked:
        json.dump({'name': f'screen {n}: VoiceOver frames', 'source': 'device, VoiceOver walk' + (' with frames' if frames else ''), 'screen': screen, 'safe': safe,
                   'screenshot': f'{n:02d}-frames.png' if frames else png, 'elements': dedupe(vo_els), 'focus': [x['caption'] for x in walked],
                   'skipped': sum(1 for x in walked if x.get('moved')), 'at': time.strftime('%H:%M:%S')},
                  open(os.path.join(out, f'{n:02d}-frames.layout.json'), 'w'), indent=1)
    return hashlib.sha1(open(os.path.join(out, png), 'rb').read()).hexdigest()


def split(doc, out):
    """A probe's layout-audit.json -> one *.layout.json and *.png per capture."""
    for k, d in enumerate(doc.get('dumps', []), 1):
        base = f'{k:02d}-' + ''.join(ch if ch.isalnum() or ch in '-_' else '-' for ch in d.get('name', 'x'))
        if d.get('png'):
            open(os.path.join(out, base + '.png'), 'wb').write(base64.b64decode(d.pop('png')))
            d['screenshot'] = base + '.png'
        json.dump(d, open(os.path.join(out, base + '.layout.json'), 'w'), indent=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', default=os.path.join(ROOT, 'dev/interop/out/ios-audit', time.strftime('%Y%m%d-%H%M%S')))
    ap.add_argument('--watch', type=float, default=0, help='seconds between captures')
    ap.add_argument('--count', type=int, default=1)
    ap.add_argument('--audit', action='store_true', help="run Apple's accessibility audit of the front app (it sweeps text sizes on the phone for a moment)")
    ap.add_argument('--walk', action='store_true', help='walk the VoiceOver focus (reads what each element is called)')
    ap.add_argument('--frames', action='store_true', help="find every element's frame: the inspector's focus box is shown on the phone and photographed per element (about 1 s each)")
    ap.add_argument('--chrome', default='Chat,Desk,Note', help='labels of the floating bottom bar\'s items (comma separated)')
    ap.add_argument('--at-end', action='store_true', help='you scrolled the screen to its end: content still under the bar is unreachable (errors)')
    ap.add_argument('--pull', action='store_true', help="fetch the probe build's Documents/layout-audit.json")
    ap.add_argument('--launch', metavar='MODE', help='start the probe build with TROMMI_LAYOUT_AUDIT=MODE (1 or sizes), then pull')
    ap.add_argument('--from', dest='src', metavar='FILE', help='a layout-audit.json copied from a simulator')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.launch:
        subprocess.run([PMD, 'developer', 'dvt', 'launch', '--udid', UDID, '--env', f'TROMMI_LAYOUT_AUDIT={a.launch}', BUNDLE], check=True, timeout=120)
        print('started; the probe walks the pages (about 15 s per page) ...')
        time.sleep(90 if a.launch == 'sizes' else 40)
        a.pull = True
    if a.pull or a.src:
        src = a.src or os.path.join(a.out, 'layout-audit.json')
        if not a.src:
            subprocess.run([PMD, 'apps', 'pull', '--documents', '--udid', UDID, BUNDLE, 'layout-audit.json', src], check=True, timeout=120)
        split(json.load(open(src)), a.out)
    else:
        seen = set()
        for n in range(1, a.count + 1):
            h = capture(a.out, n, a.audit, a.walk, a.frames, [c.strip() for c in a.chrome.split(',')], 'end' if a.at_end else 'rest')
            dropped = h in seen
            if dropped:
                for ext in ('.png', '.layout.json', '-frames.png', '-frames.layout.json'):
                    if os.path.exists(os.path.join(a.out, f'{n:02d}{ext}')):
                        os.remove(os.path.join(a.out, f'{n:02d}{ext}'))
            seen.add(h)
            print(f'capture {n}/{a.count}' + (' (unchanged, dropped)' if dropped else ''))
            if n < a.count:
                time.sleep(a.watch)
    pages = rules.run_dir(a.out, 'Trommi iOS layout audit')
    for p in pages:
        c = {s: sum(1 for x in p['problems'] if x['severity'] == s) for s in ('error', 'warn', 'info')}
        print(f'{p["name"]}: {c["error"]} errors, {c["warn"]} warnings, {c["info"]} notes')
    print(os.path.join(a.out, 'report.html'))


if __name__ == '__main__':
    main()
