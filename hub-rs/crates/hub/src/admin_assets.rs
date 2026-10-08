// Generated from hub/admin-view.mjs (CSS, JS, BELL): the same bytes, so the CSP hashes match.
// Regenerate: node hub-rs/crates/hub/gen-admin-assets.mjs
pub const CSS: &str = r##"
:root{color-scheme:light;--bg:#f5f5f3;--panel:#fff;--panel2:#fafaf8;--line:#e4e3df;--line2:#efeeea;--text:#1c1c1a;--muted:#6c6b66;--faint:#9a9993;
--accent:#2a78d6;--accent-ink:#1d5fae;--accent-weak:#e9f1fb;--hover:#f2f1ed;--bad:#c4372d;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141413;--panel:#1c1c1b;--panel2:#191918;--line:#302f2c;--line2:#262624;--text:#ebeae6;--muted:#a3a29b;--faint:#73726c;
--accent:#3987e5;--accent-ink:#7db2f0;--accent-weak:#1c2a3c;--hover:#242422;--bad:#f08a80}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent-ink);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4{margin:0;font-weight:600}h2{font-size:16px}h3{font-size:14px}
h4{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}
button,input,select{font:inherit;color:inherit}
input[type=search],input[type=password],input[type=text]{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:5px 9px;min-width:0}
input:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:5px 11px;cursor:pointer}
button:hover{background:var(--hover)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.mono,.id,.opaque,code{font-family:var(--mono);font-size:12px}
.muted{color:var(--muted)}.null{color:var(--faint);font-style:italic}.opaque{color:var(--muted)}.err{color:var(--bad)}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:6px;height:48px;padding:0 16px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:6px;font-weight:650;margin-right:14px;white-space:nowrap}
.brand svg{width:20px;height:20px;color:var(--accent)}
.brand small{font-weight:500;color:var(--muted)}
.top nav{display:flex;gap:2px}
.top nav a{padding:5px 10px;border-radius:7px;color:var(--text)}
.top nav a:hover{background:var(--hover);text-decoration:none}
.top nav a.on{background:var(--accent-weak);color:var(--accent-ink);font-weight:550}
.who{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted);white-space:nowrap}
.who form{margin:0}.who button{padding:3px 9px;font-size:12px}
.page{max-width:1440px;margin:0 auto;padding:18px 16px 40px}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.head h1{font-size:18px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.seg a{padding:4px 12px;color:var(--text);font-size:13px}.seg a+a{border-left:1px solid var(--line)}
.seg a.on{background:var(--accent-weak);color:var(--accent-ink);font-weight:600}.seg a:hover{text-decoration:none;background:var(--hover)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;margin-bottom:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px 8px;min-width:0}
.tile .k{font-size:12px;color:var(--muted)}
.tile .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em;line-height:1.25;white-space:nowrap}
.tile .v small{font-size:13px;font-weight:500;color:var(--muted);margin-left:3px}
.tile .s{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spark{display:block;width:100%;height:30px;margin-top:6px}
.line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.area{fill:var(--accent);opacity:.12;stroke:none}
.grid line{stroke:var(--line2);stroke-width:1}
.hair{stroke:var(--muted);stroke-width:1;visibility:hidden}
.dot{stroke:var(--accent);stroke-width:9;stroke-linecap:round;visibility:hidden}
.hover .hair,.hover .dot{visibility:visible}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:10px}
.chart{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px 10px;min-width:0}
.chart header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px}
.chart h3{font-size:13px}
.readout{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.hover .readout{color:var(--text)}
.plotwrap{position:relative;margin-left:52px}
.plot{display:block;width:100%;height:150px;touch-action:pan-y;cursor:crosshair}
.ylab{position:absolute;left:-52px;width:46px;text-align:right;font-size:11px;color:var(--faint);transform:translateY(-50%);font-variant-numeric:tabular-nums;white-space:nowrap}
.y100{top:0}.y50{top:50%}.y0{top:100%}
.xlabs{display:flex;justify-content:space-between;margin:4px 0 0 52px;font-size:11px;color:var(--faint)}
.empty{display:flex;align-items:center;justify-content:center;height:150px;color:var(--faint);font-size:13px;border:1px dashed var(--line);border-radius:8px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:10px;margin-top:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card h3{margin-bottom:8px}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:0;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.tlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:2px 14px;margin:0;padding:0;list-style:none;font-size:13px}
.tlist a{display:flex;justify-content:space-between;gap:8px;padding:3px 6px;border-radius:6px;color:var(--text)}
.tlist a:hover{background:var(--hover);text-decoration:none}
.n{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.data{display:grid;grid-template-columns:272px minmax(0,1fr);height:calc(100dvh - 48px)}
.data.with-detail{grid-template-columns:272px minmax(0,1fr) minmax(320px,400px)}
.tree{overflow:auto;background:var(--panel2);border-right:1px solid var(--line);padding:10px 8px 30px;font-size:13px}
.tree ul{list-style:none;margin:0;padding:0}
.tree ul ul{margin-left:9px;padding-left:7px;border-left:1px solid var(--line)}
.tree .grp{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:12px 6px 4px}
.tree .lbl{font-size:12px;color:var(--muted);padding:6px 6px 2px}
.tree a.node{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:3px 6px;border-radius:6px;color:var(--text);white-space:nowrap}
.tree a.node span:first-child{overflow:hidden;text-overflow:ellipsis}
.tree a.node:hover{background:var(--hover);text-decoration:none}
.tree a.node.on{background:var(--accent-weak);color:var(--accent-ink);font-weight:550}
.tree a.node.on .n{color:var(--accent-ink)}
.tree summary{list-style:none;cursor:pointer}.tree summary::-webkit-details-marker{display:none}
.tree summary a.node::before{content:"▸";color:var(--faint);font-size:10px;margin-right:-2px}
.tree details[open]>summary a.node::before{content:"▾"}
.tree summary a.node{justify-content:flex-start}.tree summary a.node .n{margin-left:auto}
.tree .find{display:flex;gap:6px;padding:4px 4px 2px}.tree .find input{flex:1;font-size:12px;padding:4px 8px}
.pane{display:flex;flex-direction:column;min-width:0;min-height:0}
.panehead{padding:12px 16px 10px;border-bottom:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;gap:8px}
.crumbs{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px}
.crumbs span+span::before{content:"›";margin-right:4px;color:var(--faint)}
.titlerow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{display:inline-flex;gap:6px;align-items:center;background:var(--accent-weak);color:var(--accent-ink);border-radius:999px;padding:1px 4px 1px 10px;font-size:12px;max-width:100%}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip a{color:inherit;padding:0 6px;border-radius:999px}.chip a:hover{background:var(--panel);text-decoration:none}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tools form{display:flex;gap:6px;margin:0;flex:1 1 220px;max-width:420px}.tools input[type=search]{flex:1}
.pager{display:flex;gap:6px;align-items:center;margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap}
.pager a,.pager .off{border:1px solid var(--line);border-radius:7px;padding:3px 9px;background:var(--panel);color:var(--text)}
.pager a:hover{background:var(--hover);text-decoration:none}.pager .off{color:var(--faint)}
.tablewrap{flex:1;min-height:0;overflow:auto;background:var(--panel)}
table.grid{border-collapse:separate;border-spacing:0;font-size:12.5px;min-width:100%}
.grid th{position:sticky;top:0;z-index:2;background:var(--panel2);border-bottom:1px solid var(--line);text-align:left;font-weight:600;padding:6px 10px;white-space:nowrap;font-size:12px}
.grid th a{color:var(--text)}.grid th a.on{color:var(--accent-ink)}
.grid td{padding:4px 10px;border-bottom:1px solid var(--line2);white-space:nowrap;max-width:24em;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
.grid tr[data-href]{cursor:pointer}.grid tbody tr:hover td{background:var(--hover)}
.grid tr.sel td{background:var(--accent-weak)}
.grid td.num{text-align:right;font-variant-numeric:tabular-nums}
.grid td.open{padding:4px 2px 4px 10px;color:var(--faint)}
.tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:5px;background:var(--line2);color:var(--muted)}
.detail{overflow:auto;border-left:1px solid var(--line);background:var(--panel);padding:12px 16px 30px}
.detail header{display:flex;justify-content:space-between;align-items:center;gap:8px}
.detail .close{font-size:18px;line-height:1;padding:2px 8px;border-radius:6px;color:var(--muted)}.detail .close:hover{background:var(--hover);text-decoration:none}
.detail .kv{font-size:12.5px}.detail .kv dt{font-family:var(--mono);font-size:11.5px}
.rel{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font-size:13px}
.rel a{display:block;padding:3px 6px;border-radius:6px}.rel a:hover{background:var(--hover);text-decoration:none}
.note{font-size:12px;color:var(--muted);margin:6px 0 0}
.treetoggle{display:none}
#tt{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.login{max-width:380px;margin:12vh auto 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px}
.login h1{font-size:17px;margin-bottom:4px}.login form{display:flex;flex-direction:column;gap:10px;margin-top:14px}
.login label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.form{max-width:440px;display:flex;flex-direction:column;gap:12px}.form label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
@media (max-width:820px){
.cols{grid-template-columns:minmax(0,1fr)}
.top{padding:0 8px;gap:2px}.brand small,.brand b,.who .login-name{display:none}.brand{margin-right:2px}
.top nav{overflow-x:auto;scrollbar-width:none}.top nav a{padding:5px 7px;font-size:13px;white-space:nowrap}.who button{padding:3px 7px}
.page{padding:14px 12px 30px}
.tile .v{font-size:21px}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
.data,.data.with-detail{display:flex;flex-direction:column;height:auto}
.treetoggle{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--line);background:var(--panel2);font-size:13px;cursor:pointer}
.treetoggle::after{content:"▾";color:var(--muted)}
.tree{display:none;border-right:0;border-bottom:1px solid var(--line);max-height:60vh}
#tt:checked~.data .tree,.tree:target{display:block}.tree:focus{outline:none}
.plot,.empty{height:120px}
.detail{order:1;border-left:0;border-bottom:1px solid var(--line)}
.pane{order:2}
.tablewrap{max-height:75vh}
.pager{margin-left:0}
}"##;
pub const JS: &str = r##"(()=>{for(const f of document.querySelectorAll('.chart[data-pts]')){const p=JSON.parse(f.dataset.pts);if(!p.length)continue;const plot=f.querySelector('.plot'),hair=f.querySelector('.hair'),dot=f.querySelector('.dot'),out=f.querySelector('.readout'),rest=out.textContent;
const show=e=>{const r=plot.getBoundingClientRect(),x=(e.clientX-r.left)/r.width;let lo=0,hi=p.length-1;while(lo<hi){const m=(lo+hi)>>1;if(p[m][0]<x)lo=m+1;else hi=m}if(lo>0&&x-p[lo-1][0]<p[lo][0]-x)lo--;const X=p[lo][0]*1000,Y=p[lo][1]*200;
for(const [k,v] of [['x1',X],['x2',X]]){hair.setAttribute(k,v);dot.setAttribute(k,v)}dot.setAttribute('y1',Y);dot.setAttribute('y2',Y);f.classList.add('hover');out.textContent=p[lo][2]};
plot.addEventListener('pointermove',show);plot.addEventListener('pointerdown',show);plot.addEventListener('pointerleave',()=>{f.classList.remove('hover');out.textContent=rest})}
for(const tr of document.querySelectorAll('tr[data-href]'))tr.addEventListener('click',e=>{if(e.target.closest('a')||getSelection().toString())return;location.href=tr.dataset.href});
const rf=document.getElementById('roomfilter');if(rf)rf.addEventListener('input',()=>{const q=rf.value.trim().toLowerCase();for(const li of document.querySelectorAll('[data-room]'))li.hidden=!!q&&!li.dataset.room.startsWith(q)})})();"##;
pub const BELL: &str = r##"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17h16"/><path d="M6 17a6 6 0 0 1 12 0"/><path d="M12 11v-1"/><circle cx="12" cy="8.6" r="1.1"/><path d="M3 20h18"/></svg>"##;
