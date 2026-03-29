/**
 * Dashboard — served as HTML from OpenClaw's HTTP routes.
 *
 * Read-only. Shows status, skills, audit log, config.
 * Mutations happen through the CLI (sharkcage approve, sharkcage config, etc).
 *
 * SECURITY NOTE: The dashboard renders data from our own supervisor API
 * (localhost:18790, inside the outer ASRT sandbox). All string values
 * are escaped before rendering to prevent XSS even from malicious
 * audit log entries.
 *
 * Routes:
 *   GET /sharkcage/           -> status page
 *   GET /sharkcage/skills     -> skills page
 *   GET /sharkcage/audit      -> audit log
 *   GET /sharkcage/config     -> sandbox config
 */

const API = "http://127.0.0.1:18790";

export function registerDashboardRoutes(api: {
  registerHttpRoute(config: { method: string; path: string; handler: (req: Request) => Promise<Response> }): void;
}): void {
  api.registerHttpRoute({ method: "GET", path: "/sharkcage", handler: () => servePage("status") });
  api.registerHttpRoute({ method: "GET", path: "/sharkcage/skills", handler: () => servePage("skills") });
  api.registerHttpRoute({ method: "GET", path: "/sharkcage/audit", handler: () => servePage("audit") });
  api.registerHttpRoute({ method: "GET", path: "/sharkcage/config", handler: () => servePage("config") });
}

function servePage(view: string): Promise<Response> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sharkcage</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e5e5e5}
.L{display:flex;min-height:100vh}
nav{width:200px;padding:24px 16px;border-right:1px solid #222;flex-shrink:0}
nav .logo{font-size:20px;font-weight:700;margin-bottom:4px}
nav .tag{font-size:11px;color:#888;margin-bottom:28px}
nav a{display:block;padding:8px 12px;color:#999;text-decoration:none;border-radius:6px;font-size:14px;margin-bottom:2px}
nav a:hover{background:#1a1a1a;color:#e5e5e5}
main{flex:1;padding:32px;max-width:1100px}
h1{font-size:26px;font-weight:700;margin-bottom:4px}
.sub{color:#888;margin-bottom:28px;font-size:14px}
.G{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}
.C{padding:18px;background:#111;border-radius:8px;border:1px solid #222}
.C .l{font-size:11px;color:#888;margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px}
.C .v{font-size:22px;font-weight:700}
.ok{color:#22c55e}.w{color:#f59e0b}.er{color:#ef4444}.m{color:#888}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px;color:#666;border-bottom:1px solid #333;font-weight:500}
td{padding:8px;border-bottom:1px solid #1a1a1a}
.bl{background:#1a0000}
.mn{font-family:ui-monospace,"SF Mono",monospace}
.d{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.bg{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600}
.bg-ok{background:#1a3d1a;color:#22c55e}
.bg-w{background:#3d3d1a;color:#f59e0b}
.empty{padding:32px;text-align:center;color:#666;background:#111;border-radius:8px;border:1px solid #222}
.eb{padding:16px;background:#1a0000;border:1px solid #5c1a1a;border-radius:8px;margin-bottom:20px}
pre{font-family:ui-monospace,monospace;font-size:13px;color:#aaa;white-space:pre-wrap;background:#0d0d0d;padding:16px;border-radius:6px;overflow-x:auto}
.S{margin-bottom:32px}
h2{font-size:18px;font-weight:600;margin-bottom:12px}
.r{text-align:right}
.el{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>
<div class="L">
<nav>
<div class="logo">sharkcage</div>
<div class="tag">OpenClaw, but you trust it.</div>
<a href="/sharkcage">Status</a>
<a href="/sharkcage/skills">Skills</a>
<a href="/sharkcage/audit">Audit Log</a>
<a href="/sharkcage/config">Config</a>
</nav>
<main id="app">Loading...</main>
</div>
<script>
const A="${API}";
// Escape HTML to prevent XSS from any data source
function esc(s){if(s==null)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
async function api(p){try{const r=await fetch(A+p);if(!r.ok)throw new Error("API "+r.status);return await r.json()}catch(e){return{_error:e.message}}}
function card(l,v,c){return'<div class="C"><div class="l">'+esc(l)+'</div><div class="v '+(c||'')+'">'+esc(v)+'</div></div>'}
function fmtUp(s){return s<60?Math.floor(s)+"s":s<3600?Math.floor(s/60)+"m":Math.floor(s/3600)+"h "+Math.floor((s%3600)/60)+"m"}
const V="${view}";
const app=document.getElementById("app");
const views={
status:async()=>{
const[st,stats]=await Promise.all([api("/api/status"),api("/api/audit/stats")]);
let h='<h1>Status</h1><div class="sub">System overview</div>';
if(st._error){h+='<div class="eb">Not connected: '+esc(st._error)+'<br><span class="m">Start with: sharkcage start</span></div>';app.innerHTML=h;return}
h+='<div class="G">'+card("Status",st.status,st.status==="running"?"ok":"er")+card("ASRT Sandbox",st.asrt?"Active":"Disabled",st.asrt?"ok":"w")+card("Skills",st.approvedSkills+"/"+st.skills+" approved")+card("Uptime",fmtUp(st.uptime))+'</div>';
if(!stats._error){h+='<div class="G">'+card("Total Calls",stats.total)+card("OK",stats.ok,"ok")+card("Blocked",stats.blocked,stats.blocked>0?"er":"m")+card("Errors",stats.errors,stats.errors>0?"w":"m")+'</div>';
const sk=Object.entries(stats.bySkill||{});if(sk.length){h+='<div class="S"><h2>By Skill</h2><table><thead><tr><th>Skill</th><th class="r">Calls</th><th class="r">Blocked</th></tr></thead><tbody>';for(const[n,d]of sk)h+='<tr><td>'+esc(n)+'</td><td class="r">'+d.calls+'</td><td class="r '+(d.blocked>0?"er":"m")+'">'+d.blocked+'</td></tr>';h+='</tbody></table></div>'}}
app.innerHTML=h},
skills:async()=>{
const sk=await api("/api/skills");
let h='<h1>Skills</h1><div class="sub">Installed skills and approval status</div>';
if(sk._error){h+='<div class="eb">'+esc(sk._error)+'</div>';app.innerHTML=h;return}
if(!sk.length){h+='<div class="empty">No skills installed. Run: sharkcage plugin add &lt;url&gt;</div>';app.innerHTML=h;return}
for(const s of sk){const b=s.approved?'#1a3d1a':'#3d3d1a';const bg=s.approved?'<span class="bg bg-ok">Approved</span>':'<span class="bg bg-w">Pending</span>';
h+='<div class="C" style="border-color:'+b+';margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div><span style="font-size:17px;font-weight:600">'+esc(s.name)+'</span><span class="m" style="margin-left:8px;font-size:13px">v'+esc(s.version)+'</span></div>'+bg+'</div><div class="m" style="font-size:13px;margin-bottom:8px">'+esc(s.description)+'</div><div class="m" style="font-size:12px">'+s.capabilities+' capabilities';if(s.approvedAt)h+=' &middot; '+new Date(s.approvedAt).toLocaleDateString();h+='</div></div>'}
app.innerHTML=h},
audit:async()=>{
const en=await api("/api/audit?tail=200");
let h='<h1>Audit Log</h1><div class="sub">Every tool call, every block, full provenance</div>';
if(en._error){h+='<div class="eb">'+esc(en._error)+'</div>';app.innerHTML=h;return}
if(!en.length){h+='<div class="empty">No audit entries yet.</div>';app.innerHTML=h;return}
h+='<div style="overflow-x:auto"><table><thead><tr><th>Time</th><th>Status</th><th>Skill</th><th>Tool</th><th class="r">Duration</th><th>Detail</th></tr></thead><tbody>';
for(const e of en.reverse()){const cl=e.blocked?' class="bl"':'';const dc=e.blocked?"#ef4444":e.error?"#f59e0b":"#22c55e";const st=e.blocked?"BLOCKED":e.error?"ERROR":"OK";const det=e.blocked?(e.blockReason||''):e.error?e.error.substring(0,100):'';
h+='<tr'+cl+'><td class="mn" style="white-space:nowrap">'+esc(e.timestamp.slice(11,19))+'</td><td><span class="d" style="background:'+dc+'"></span>'+st+'</td><td style="font-weight:500">'+esc(e.skill)+'</td><td class="mn">'+esc(e.tool)+'</td><td class="r mn">'+e.durationMs+'ms</td><td class="m el">'+esc(det)+'</td></tr>'}
h+='</tbody></table></div>';app.innerHTML=h},
config:async()=>{
const cfg=await api("/api/config");
let h='<h1>Configuration</h1><div class="sub">Gateway sandbox and runtime config (read-only)</div>';
if(cfg._error){h+='<div class="eb">'+esc(cfg._error)+'</div>';app.innerHTML=h;return}
if(cfg.sandbox){h+='<div class="S"><h2>Gateway Sandbox (Outer ASRT)</h2><pre>'+esc(JSON.stringify(cfg.sandbox,null,2))+'</pre></div>'}
if(cfg.gateway){h+='<div class="S"><h2>Gateway Config</h2><pre>'+esc(JSON.stringify(cfg.gateway,null,2))+'</pre></div>'}
h+='<div class="m" style="font-size:12px;margin-top:16px">To modify: sharkcage config add-service | sharkcage config remove-service</div>';
app.innerHTML=h}
};
views[V]();
</script>
</body>
</html>`;

  return Promise.resolve(new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
}
