// Generated from hub/admin-view.mjs (CSS, JS, BELL, SPRITE: the same bytes, so the CSP hashes match) and from
// hub/store.mjs (COLUMN_CLASSES, TABLE_NOTES: what each column of hub.db holds). Do not edit.
// Regenerate: node hub-rs/crates/hub/gen-admin-assets.mjs
pub const CSS: &str = r##"
/* The look of the web app: colours, type, radii and the ink focus ring are copied from app/web/public/app.css
   (:root and :root[data-theme="dark"]), the three fonts are its fonts/f1, f7, f3 (served by this listener as
   /fonts/*.woff2). Copied, not linked: the page stays one stylesheet pinned by hash. Dark follows the system here. */
@font-face{font-family:"Bricolage Grotesque";font-weight:600 800;font-display:swap;src:url(/fonts/display.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Sans";font-weight:400 600;font-display:swap;src:url(/fonts/sans.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;font-display:swap;src:url(/fonts/mono.woff2) format("woff2")}
:root{color-scheme:light;--bg:#f5f6f2;--surface:#fff;--surface-2:#fafbf8;--sunken:#eceee8;--fg:#141c18;--muted:#5c6862;--faint:#8a958f;--line:#e1e5df;--line-strong:#c9d0c8;
--accent:#1b6a57;--accent-soft:#dcefe8;--warn:#b4551b;--bad:#b3261e;--bad-soft:#fbe0de;
--display:"Bricolage Grotesque","Avenir Next","Segoe UI",sans-serif;--font:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0e1311;--surface:#171d1a;--surface-2:#1c2420;--sunken:#111715;--fg:#e9eeea;--muted:#9aa8a0;--faint:#6c7a73;--line:#252f2a;--line-strong:#35423b;
--accent:#6fd0b5;--accent-soft:#17332b;--warn:#f2a56c;--bad:#ff8a80;--bad-soft:#41191a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--font);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4,p{margin:0}
h1{font:800 1.7rem/1.15 var(--display);letter-spacing:-.01em}
h2{font:700 1.2rem/1.2 var(--display)}
h3{font:600 .95rem/1.3 var(--font)}
h4{font:600 .72rem/1.3 var(--font);letter-spacing:.07em;text-transform:uppercase;color:var(--faint);margin:22px 0 8px}
button,input,select{font:inherit;color:inherit}
input[type=search],input[type=password],input[type=text]{background:var(--surface);border:1px solid var(--line-strong);border-radius:8px;padding:7px 11px;min-width:0}
input::placeholder{color:var(--faint)}
:focus{outline:none}
:is(a,button,input,summary,label):focus-visible{outline:2px solid var(--fg);outline-offset:2px}
button{min-height:36px;background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;padding:0 16px;font-size:.84rem;font-weight:600;cursor:pointer;white-space:nowrap}
button:hover{border-color:var(--fg)}
button.primary{background:var(--fg);border-color:var(--fg);color:var(--bg)}
button.danger{background:var(--bad);border-color:var(--bad);color:var(--surface)}button.danger:hover{filter:brightness(1.08)}
::selection{background:var(--accent-soft)}
.mono,.id,.opaque,code{font-family:var(--mono);font-size:.8rem}
.muted{color:var(--muted)}.null{color:var(--faint)}.opaque{color:var(--muted)}.err{color:var(--bad)}.ok{color:var(--accent)}
p.err{padding:9px 14px;border-radius:12px;background:var(--bad-soft);font-size:.84rem;font-weight:500;margin:0 0 14px}
.sprite{position:absolute;width:0;height:0}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:8px;height:52px;padding:0 20px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;margin-right:16px;white-space:nowrap}
.brand svg{width:26px;height:26px;color:var(--accent)}
.brand b{font:800 1.1rem/1 var(--display)}
.brand small{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.top nav{display:flex;gap:2px;min-width:0}
.top nav a{padding:6px 12px;border-radius:999px;color:var(--muted);font-size:.9rem;font-weight:500;white-space:nowrap}
.top nav a:hover{color:var(--fg);background:var(--sunken);text-decoration:none}
.top nav a.on{background:var(--sunken);color:var(--fg);font-weight:600}
.who{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:.84rem;color:var(--muted);white-space:nowrap}
.who form{margin:0}.who button{min-height:32px;padding:0 13px}
.page{max-width:1280px;margin:0 auto;padding:28px 24px 56px}
.head{display:flex;align-items:baseline;gap:6px 14px;flex-wrap:wrap;margin-bottom:20px}
.head .seg{align-self:center}
.seg{display:inline-flex;padding:3px;border-radius:999px;background:var(--sunken)}
.seg a{padding:3px 14px;border-radius:999px;color:var(--muted);font-size:.84rem;font-weight:600}
.seg a:hover{color:var(--fg);text-decoration:none}
.seg a.on{background:var(--surface);color:var(--fg);box-shadow:0 1px 2px rgb(20 30 25/.14)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:12px}
.tile,.chart,.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;min-width:0}
.tile{padding:14px 16px 12px}
.tile .k{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.tile .v{font:800 1.7rem/1.3 var(--display);font-variant-numeric:tabular-nums;white-space:nowrap}
.tile .v small{font:500 .84rem var(--font);color:var(--muted);margin-left:4px}
.tile .s{font-size:.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spark{display:block;width:100%;height:28px;margin-top:8px}
.line{fill:none;stroke:var(--accent);stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round}
.area{fill:var(--accent);opacity:.1;stroke:none}
.grid line{stroke:var(--line);stroke-width:1}
.hair{stroke:var(--faint);stroke-width:1;visibility:hidden}
.dot{stroke:var(--accent);stroke-width:8;stroke-linecap:round;visibility:hidden}
.hover .hair,.hover .dot{visibility:visible}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:12px}
.chart{margin:0;padding:14px 16px 12px}
.chart header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px}
.readout{font-size:.78rem;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.hover .readout{color:var(--fg)}
.plotwrap{position:relative;margin-left:54px}
.plot{display:block;width:100%;height:150px;touch-action:pan-y;cursor:crosshair}
.ylab{position:absolute;left:-54px;width:48px;text-align:right;font-size:.7rem;color:var(--faint);transform:translateY(-50%);font-variant-numeric:tabular-nums;white-space:nowrap}
.y100{top:0}.y50{top:50%}.y0{top:100%}
.xlabs{display:flex;justify-content:space-between;margin:6px 0 0 54px;font-size:.7rem;color:var(--faint)}
.empty{display:flex;align-items:center;justify-content:center;height:150px;padding:0 12px;text-align:center;color:var(--faint);font-size:.84rem;border:1px dashed var(--line-strong);border-radius:8px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px;margin-top:12px}
.card{padding:16px 18px}
.card+.card{margin-top:12px}.cols .card+.card{margin-top:0}
.card h3{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:.84rem}
.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.tlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0 18px;margin:0 -8px;padding:0;list-style:none;font-size:.84rem}
.tlist a{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 8px;border-radius:8px;color:var(--fg)}
.tlist a:hover{background:var(--sunken);text-decoration:none}
.n{color:var(--faint);font-variant-numeric:tabular-nums;font-size:.78rem;font-weight:500}
.cm{display:inline-flex;align-items:center;gap:4px;font:600 .72rem/1.3 var(--font);letter-spacing:0;text-transform:none;white-space:nowrap;color:var(--muted)}
.cm svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.cm-e2e{color:var(--accent)}.cm-plain{color:var(--warn)}.cm-none{color:var(--bad)}
.grid th .cm,.kv dt .cm{display:flex;margin-top:2px;font-weight:500}
.sum{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;font-size:.78rem;color:var(--muted)}
.sum b{font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px 28px;margin:0;padding:0;list-style:none;font-size:.84rem;color:var(--muted)}
.legend .cm{display:flex;font-size:.9rem;margin-bottom:3px}.legend .cm svg{width:17px;height:17px}
.schema{scroll-margin-top:64px}
.schema header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.schema h2 a{color:var(--fg)}
.schema .scroll{margin-top:10px}
.schema .grid th{position:static}.schema .grid td{white-space:normal;max-width:none}.schema .grid td:nth-child(-n+4){white-space:nowrap}
.schema .grid tr:last-child td{border-bottom:0}
.data{display:grid;grid-template-columns:280px minmax(0,1fr);height:calc(100dvh - 52px)}
.data.with-detail{grid-template-columns:280px minmax(0,1fr) minmax(330px,420px)}
.tree{overflow:auto;background:var(--surface-2);border-right:1px solid var(--line);padding:8px 10px 32px;font-size:.84rem}
.tree ul{list-style:none;margin:0;padding:0}
.tree ul ul{margin-left:11px;padding-left:7px;border-left:1px solid var(--line-strong)}
.tree .grp{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);padding:14px 8px 5px}
.tree .lbl{font-size:.78rem;color:var(--faint);padding:8px 8px 2px}
.tree a.node{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 8px;border-radius:8px;color:var(--fg);white-space:nowrap}
.tree a.node span:first-child{overflow:hidden;text-overflow:ellipsis}
.tree a.node:hover{background:var(--sunken);text-decoration:none}
.tree a.node.on{background:var(--accent-soft);font-weight:600}
.tree a.node.on .n{color:var(--muted)}
.tree summary{list-style:none;cursor:pointer}.tree summary::-webkit-details-marker{display:none}
.tree summary a.node{justify-content:flex-start;font-weight:600}.tree summary a.node .n{margin-left:auto}
.tree summary a.node::before{content:"";align-self:center;flex:none;border:4px solid transparent;border-left:5px solid var(--faint);border-right:0;margin-right:-1px}
.tree details[open]>summary a.node::before{transform:rotate(90deg)}
.tree .find{display:flex;padding:2px 4px 6px}.tree .find input{flex:1;font-size:.8rem;padding:5px 10px}
.pane{display:flex;flex-direction:column;min-width:0;min-height:0}
.panehead{padding:16px 20px 12px;border-bottom:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;gap:10px}
.crumbs{font-size:.78rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:5px}
.crumbs span+span::before{content:"/";margin-right:5px;color:var(--faint)}
.titlerow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.titlerow .muted{font-size:.84rem}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{display:inline-flex;gap:4px;align-items:center;background:var(--accent-soft);border-radius:999px;padding:2px 4px 2px 12px;font-size:.78rem;font-weight:500;max-width:100%}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip a{color:var(--fg);padding:0 7px;border-radius:999px}.chip a:hover{background:var(--surface);text-decoration:none}
.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tools form{display:flex;gap:6px;margin:0;flex:1 1 240px;max-width:440px}.tools input[type=search]{flex:1;padding:6px 11px;font-size:.84rem}
.pager{display:flex;gap:6px;align-items:center;margin-left:auto;font-size:.78rem;color:var(--muted);white-space:nowrap}
.pager a,.pager .off{border:1px solid var(--line-strong);border-radius:999px;padding:4px 12px;background:var(--surface);color:var(--fg);font-weight:600}
.pager a:hover{border-color:var(--fg);text-decoration:none}.pager .off{color:var(--faint);border-color:var(--line)}
.tablewrap{flex:1;min-height:0;overflow:auto;background:var(--surface)}
table.grid{border-collapse:separate;border-spacing:0;font-size:.84rem;min-width:100%}
.grid th{position:sticky;top:0;z-index:2;background:var(--surface);border-bottom:1.5px solid var(--fg);text-align:left;font-weight:600;padding:8px 12px 7px;white-space:nowrap;vertical-align:bottom}
.grid th a{color:var(--fg)}.grid th a.on{color:var(--accent)}
.grid td{padding:6px 12px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:24em;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
.grid tr[data-href]{cursor:pointer}.grid tbody tr[data-href]:hover td{background:var(--surface-2)}
.grid tr.sel td,.grid tbody tr.sel:hover td{background:var(--accent-soft)}
.grid td.num{text-align:right;font-variant-numeric:tabular-nums}
.grid td.open{padding-right:2px}.grid td.open a{color:var(--faint)}
.grid td.none{padding:44px 12px;text-align:center;color:var(--faint);border-bottom:0}
.tag{display:inline-block;font-size:.72rem;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--sunken);color:var(--muted)}
.detail{overflow:auto;border-left:1px solid var(--line);background:var(--surface);padding:16px 20px 32px}
.detail header{display:flex;justify-content:space-between;align-items:center;gap:8px}
.detail .close{font-size:1.3rem;line-height:1;padding:3px 9px;border-radius:999px;color:var(--muted)}.detail .close:hover{background:var(--sunken);color:var(--fg);text-decoration:none}
.detail .kv{gap:8px 16px}.detail .kv dt{font-family:var(--mono);font-size:.76rem;color:var(--fg)}
.rel{list-style:none;margin:0 -8px;padding:0;display:flex;flex-direction:column;font-size:.84rem}
.rel a{display:block;padding:4px 8px;border-radius:8px}.rel a:hover{background:var(--sunken);text-decoration:none}
.note{font-size:.78rem;color:var(--muted);margin:8px 0 0}
.treetoggle{display:none}
#tt{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.login{max-width:400px;margin:14vh auto 0;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:28px}
.login .brand{margin:0 0 20px}
.login h1{font-size:1.35rem;margin-bottom:4px}.login form{display:flex;flex-direction:column;gap:14px;margin-top:18px}
.login label,.form label{display:flex;flex-direction:column;gap:5px;font-size:.84rem;font-weight:500;color:var(--muted)}
.notice{max-width:460px;margin:12vh auto 0;text-align:center}.notice h1{margin-bottom:8px}.notice p{color:var(--muted);margin-bottom:18px}
.scroll{overflow:auto}
.two{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:12px;align-items:start}.two .card+.card{margin-top:0}
.mini th:not(:first-child){text-align:right}.card .tools{margin-top:12px}.card .grid th{position:static}.card .grid tr:last-child td{border-bottom:0}.card h4:first-of-type{margin-top:14px}
.side{display:flex;align-items:center;gap:8px;margin-bottom:2px}.side .cm svg{width:20px;height:20px}.side .cm{font-size:0}
.unseen{list-style:none;margin:10px 0 0;padding:0;font-size:.84rem}
.unseen li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:10px 0;border-top:1px solid var(--line)}
.unseen li b{font-weight:600}.unseen li .mono{grid-column:1/-1;color:var(--faint);font-size:.74rem}
@media (max-width:820px){.two{grid-template-columns:minmax(0,1fr)}}
.confirm{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:18px}.confirm input{width:7em}
.form{max-width:460px;display:flex;flex-direction:column;gap:14px}
@media (max-width:820px){
.cols{grid-template-columns:minmax(0,1fr)}
.top{padding:0 10px;gap:4px}.brand small,.brand b,.who .login-name{display:none}.brand{margin-right:2px}
.top nav{overflow-x:auto;scrollbar-width:none}.top nav a{padding:6px 9px;font-size:.84rem}.who{gap:6px;padding-left:4px}.who button{padding:0 11px}
.page{padding:20px 16px 40px}
h1{font-size:1.35rem}
.tile .v{font-size:1.35rem}.tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tile{padding:12px 13px 10px}
.data,.data.with-detail{display:flex;flex-direction:column;height:auto}
.treetoggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);background:var(--surface-2);font-size:.84rem;cursor:pointer}
.treetoggle::after{content:"";flex:none;border:5px solid transparent;border-top:6px solid var(--muted);border-bottom:0}
.tree{display:none;border-right:0;border-bottom:1px solid var(--line);max-height:60vh}
#tt:checked~.data .tree,.tree:target{display:block}.tree:focus{outline:none}
.plot,.empty{height:120px}
.detail{order:1;border-left:0;border-bottom:1px solid var(--line);padding:16px 16px 24px}
.pane{order:2}.panehead{padding:14px 16px 12px}
.tablewrap{max-height:75vh}
.pager{margin-left:0}
.card{padding:14px}
.login{margin:8vh 16px 0;padding:22px}
}"##;
pub const JS: &str = r##"(()=>{for(const f of document.querySelectorAll('.chart[data-pts]')){const p=JSON.parse(f.dataset.pts);if(!p.length)continue;const plot=f.querySelector('.plot'),hair=f.querySelector('.hair'),dot=f.querySelector('.dot'),out=f.querySelector('.readout'),rest=out.textContent;
const show=e=>{const r=plot.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;let lo=0,hi=p.length-1;while(lo<hi){const m=(lo+hi)>>1;if(p[m][0]<x)lo=m+1;else hi=m}if(lo>0&&x-p[lo-1][0]<p[lo][0]-x)lo--;const X=p[lo][0]*1000,Y=p[lo][1]*200;
for(const [k,v] of [['x1',X],['x2',X]]){hair.setAttribute(k,v);dot.setAttribute(k,v)}dot.setAttribute('y1',Y);dot.setAttribute('y2',Y);f.classList.add('hover');out.textContent=p[lo][2]};
plot.addEventListener('pointermove',show);plot.addEventListener('pointerdown',show);plot.addEventListener('pointerleave',()=>{f.classList.remove('hover');out.textContent=rest})}
for(const tr of document.querySelectorAll('tr[data-href]'))tr.addEventListener('click',e=>{if(e.target.closest('a')||getSelection().toString())return;location.href=tr.dataset.href});
const rf=document.getElementById('roomfilter');if(rf)rf.addEventListener('input',()=>{const q=rf.value.trim().toLowerCase();for(const li of document.querySelectorAll('[data-room]'))li.hidden=!!q&&!li.dataset.room.startsWith(q)})})();"##;
pub const BELL: &str = r##"<svg viewBox="1.5 2.5 23 19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.1 19Q12.3 18.6 16.7 19L21 19.3"/><path d="M4.8 18.9Q5.2 15.1 5.7 13.7Q6.2 12.3 7.5 11.3Q8.7 10.3 10.3 9.5Q12 8.8 13.7 9.3Q15.3 9.8 16.4 11Q17.5 12.2 18.1 13.7Q18.6 15.2 18.8 17L18.9 18.8"/><path d="M11.8 8.6L12.2 6.9"/><path d="M10 6.6Q11.8 6 12.8 6.4L13.8 6.8"/><path d="M18.5 7.3Q19.5 5.8 19.8 5.2L20 4.5"/><path d="M20.6 10.3Q21.5 9.4 22.3 8.9L23.1 8.5"/></svg>"##;
pub const SPRITE: &str = r##"<svg class="sprite" aria-hidden="true"><symbol id="c-e2e" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.2 11V8a3.8 3.8 0 0 1 7.6 0v3"/></symbol><symbol id="c-plain" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></symbol><symbol id="c-hash" viewBox="0 0 24 24"><path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9.2h16M3.5 14.8h16"/></symbol><symbol id="c-none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3.2"/><path d="M12 8v4.5M12 16v.1"/></symbol></svg>"##;
/// (table, column, class, note); class: e2e (end-to-end encrypted), plain (the hub reads it), hash (hash, salt or signature).
pub const COLUMN_CLASSES: &[(&str, &str, &str, &str)] = &[
    ("rooms", "room_id", "plain", "room identifier"),
    ("rooms", "founded_at", "plain", ""),
    ("rooms", "last_entry_number", "plain", ""),
    ("rooms", "last_envelope_number", "plain", ""),
    ("member_entries", "room_id", "plain", ""),
    ("member_entries", "entry_number", "plain", ""),
    ("member_entries", "previous_entry_hash", "hash", "chain link"),
    ("member_entries", "entry_hash", "hash", ""),
    ("member_entries", "entry_action", "plain", ""),
    ("member_entries", "signer_device_id", "plain", ""),
    ("member_entries", "signed_entry", "plain", "signed member entry (devices, roles, public keys): not encrypted"),
    ("member_entries", "received_at", "plain", ""),
    ("devices", "room_id", "plain", ""),
    ("devices", "device_id", "plain", ""),
    ("devices", "device_role", "plain", "human or agent"),
    ("devices", "key_signing_public", "plain", "public key"),
    ("devices", "key_exchange_public", "plain", "public key"),
    ("devices", "added_entry_number", "plain", ""),
    ("devices", "removed_entry_number", "plain", ""),
    ("devices", "removal_cut_sequence", "plain", ""),
    ("devices", "removal_cut_hash", "hash", ""),
    ("sealed_room_keys", "room_id", "plain", ""),
    ("sealed_room_keys", "key_epoch", "plain", ""),
    ("sealed_room_keys", "device_id", "plain", "the recipient"),
    ("sealed_room_keys", "key_sealed", "e2e", "room key sealed for one device"),
    ("key_back_links", "room_id", "plain", ""),
    ("key_back_links", "key_epoch", "plain", ""),
    ("key_back_links", "key_back_link", "e2e", "the previous room key under the next one"),
    ("session_grants", "room_id", "plain", ""),
    ("session_grants", "session_id", "plain", ""),
    ("session_grants", "grant_number", "plain", ""),
    ("session_grants", "previous_grant_hash", "hash", "chain link"),
    ("session_grants", "grant_hash", "hash", ""),
    ("session_grants", "session_key_epoch", "plain", ""),
    ("session_grants", "signer_device_id", "plain", ""),
    ("session_grants", "signed_grant", "plain", "signed grant (ids, epoch, assigned agents, commitments): not encrypted"),
    ("session_grants", "received_at", "plain", ""),
    ("sealed_session_keys", "room_id", "plain", ""),
    ("sealed_session_keys", "session_id", "plain", ""),
    ("sealed_session_keys", "session_key_epoch", "plain", ""),
    ("sealed_session_keys", "device_id", "plain", "the recipient"),
    ("sealed_session_keys", "key_sealed", "e2e", "session key sealed for one device"),
    ("session_key_back_links", "room_id", "plain", ""),
    ("session_key_back_links", "session_id", "plain", ""),
    ("session_key_back_links", "session_key_epoch", "plain", ""),
    ("session_key_back_links", "key_back_link", "e2e", "the previous session key under the next one"),
    ("invites", "room_id", "plain", ""),
    ("invites", "invite_id", "plain", ""),
    ("invites", "device_role", "plain", ""),
    ("invites", "inviter_device_id", "plain", ""),
    ("invites", "signed_offer", "plain", "signed offer: never the secret of the link"),
    ("invites", "expires_at", "plain", ""),
    ("invites", "signed_reveal", "plain", "signed answer of the inviter"),
    ("invites", "answered_request_hash", "hash", ""),
    ("invites", "used_at", "plain", ""),
    ("invites", "added_device_id", "plain", ""),
    ("invites", "burned_at", "plain", ""),
    ("join_requests", "room_id", "plain", ""),
    ("join_requests", "invite_id", "plain", ""),
    ("join_requests", "request_hash", "hash", ""),
    ("join_requests", "device_id", "plain", ""),
    ("join_requests", "signed_request", "plain", "signed request of the newcomer"),
    ("join_requests", "received_at", "plain", ""),
    ("envelopes", "room_id", "plain", ""),
    ("envelopes", "envelope_number", "plain", ""),
    ("envelopes", "sender_device_id", "plain", ""),
    ("envelopes", "sender_sequence", "plain", ""),
    ("envelopes", "previous_envelope_hash", "hash", "chain link"),
    ("envelopes", "envelope_hash", "hash", ""),
    ("envelopes", "key_epoch", "plain", ""),
    ("envelopes", "recipient_device_id", "plain", ""),
    ("envelopes", "object_id", "plain", ""),
    ("envelopes", "object_state", "plain", "open, answered, closed"),
    ("envelopes", "urgency", "plain", ""),
    ("envelopes", "answered_at", "plain", ""),
    ("envelopes", "envelope_kind", "plain", ""),
    ("envelopes", "timeline_kind", "plain", ""),
    ("envelopes", "timeline_id", "plain", ""),
    ("envelopes", "send_push", "plain", ""),
    ("envelopes", "attachment_ids", "plain", ""),
    ("envelopes", "padded_size", "plain", "size after padding"),
    ("envelopes", "sent_at", "plain", ""),
    ("envelopes", "received_at", "plain", ""),
    ("envelopes", "envelope_header", "plain", "cleartext header, signed: the hub routes by it"),
    ("envelopes", "envelope_nonce", "plain", "AES-GCM nonce"),
    ("envelopes", "encrypted_body", "e2e", "what is written and drawn: messages, card titles, options and answers, canvases, names of sessions, desks and devices"),
    ("envelopes", "encrypted_body_hash", "hash", "SHA-256 of the ciphertext"),
    ("envelopes", "envelope_signature", "hash", "signature of the sender"),
    ("envelopes", "void_code", "plain", "why a refused envelope was kept void"),
    ("objects", "room_id", "plain", ""),
    ("objects", "object_id", "plain", ""),
    ("objects", "object_state", "plain", ""),
    ("objects", "urgency", "plain", ""),
    ("objects", "answered_at", "plain", ""),
    ("objects", "owner_device_id", "plain", ""),
    ("objects", "first_envelope_number", "plain", ""),
    ("objects", "latest_head_envelope_number", "plain", ""),
    ("timelines", "room_id", "plain", ""),
    ("timelines", "timeline_kind", "plain", ""),
    ("timelines", "timeline_id", "plain", ""),
    ("timelines", "last_envelope_number", "plain", ""),
    ("timelines", "item_count", "plain", ""),
    ("attachments", "room_id", "plain", ""),
    ("attachments", "attachment_id", "plain", ""),
    ("attachments", "object_id", "plain", ""),
    ("attachments", "uploader_device_id", "plain", ""),
    ("attachments", "total_size", "plain", "bytes of the encrypted file"),
    ("attachments", "chunk_count", "plain", ""),
    ("attachments", "stored_at", "plain", ""),
    ("attachments", "referenced_at", "plain", ""),
    ("agent_leases", "room_id", "plain", ""),
    ("agent_leases", "device_id", "plain", ""),
    ("agent_leases", "process_instance", "plain", "random id of the running connector"),
    ("agent_leases", "lease_generation", "plain", ""),
    ("agent_leases", "expires_at", "plain", ""),
    ("push_subscriptions", "room_id", "plain", ""),
    ("push_subscriptions", "device_id", "plain", ""),
    ("push_subscriptions", "endpoint", "plain", "address at the push service, with the device token: a secret"),
    ("push_subscriptions", "subscription", "plain", "the keys the hub needs to send a push: a secret"),
    ("push_subscriptions", "created_at", "plain", ""),
    ("push_subscriptions", "level", "plain", "all or knocking"),
    ("live_activities", "room_id", "plain", ""),
    ("live_activities", "device_id", "plain", "the iPhone"),
    ("live_activities", "environment", "plain", "sandbox or production"),
    ("live_activities", "topic", "plain", "bundle id"),
    ("live_activities", "tag", "plain", "random tag of the room on that device"),
    ("live_activities", "start_token", "plain", "APNs push-to-start token: a secret the hub needs to send"),
    ("live_activities", "activity_token", "plain", "APNs token of the running activity: a secret the hub needs to send"),
    ("live_activities", "started_at", "plain", ""),
    ("live_activities", "sent", "plain", "the counts last sent (working:waiting)"),
    ("live_activities", "sent_at", "plain", ""),
    ("live_activities", "created_at", "plain", ""),
    ("shares", "share_id", "plain", ""),
    ("shares", "room_id", "plain", ""),
    ("shares", "attachment_id", "plain", ""),
    ("shares", "share_secret_hash", "hash", "SHA-256 of the secret in the link"),
    ("shares", "expires_at", "plain", ""),
    ("shares", "created_by_device_id", "plain", ""),
    ("shares", "created_at", "plain", ""),
    ("test_rooms", "room_id", "plain", ""),
    ("test_rooms", "expires_at", "plain", ""),
    ("accounts", "room_id", "plain", ""),
    ("accounts", "email", "plain", "the address in plaintext"),
    ("accounts", "email_verified_at", "plain", ""),
    ("accounts", "created_at", "plain", ""),
    ("accounts", "updated_at", "plain", ""),
    ("accounts", "revision", "plain", ""),
    ("accounts", "auth_salt", "hash", "salt"),
    ("accounts", "auth_hash", "hash", "scrypt of the client's auth key, never the password"),
    ("accounts", "key_wrapped", "e2e", "the room's recovery code under a key only the password gives"),
    ("accounts", "kdf", "plain", "KDF parameters"),
    ("accounts", "recovery_salt", "hash", "salt"),
    ("accounts", "recovery_hash", "hash", "scrypt of the Emergency Kit's auth key"),
    ("accounts", "recovery_wrapped", "e2e", "the recovery code under the Emergency Kit words"),
    ("accounts", "code_salt", "hash", "salt"),
    ("accounts", "code_hash", "hash", "salted SHA-256 of the pending email code"),
    ("accounts", "code_expires_at", "plain", ""),
    ("accounts", "code_attempts", "plain", ""),
];
/// (table, note)
pub const TABLE_NOTES: &[(&str, &str)] = &[
    ("envelopes", "Truth. The hub reads the header (who, when, which card, how big) and never the body."),
    ("member_entries", "Truth. The signed member list: who is in the room, with which public keys."),
    ("objects", "Derived from signed header fields of envelopes; can be rebuilt at any time."),
    ("timelines", "Derived from signed header fields of envelopes; can be rebuilt at any time."),
    ("attachments", "Bookkeeping only. The files are encrypted on the client and lie beside hub.db, not in it."),
    ("accounts", "Sign-in by email. The hub can check a login, it cannot open the room with it."),
    ("live_activities", "What the hub needs to show an iPhone's Live Activity. It sends two numbers (agents working, cards waiting), never content."),
    ("push_subscriptions", "What the hub needs to ring a device. A push carries room, envelope number and urgency, never content."),
];
