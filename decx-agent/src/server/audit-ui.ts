import { readFileSync } from "fs";
import * as path from "path";

export function auditUiHtml(): string {
  try {
    return readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "static", "index.html"), "utf-8");
  } catch {
    return fallbackAuditUiHtml();
  }
}

function fallbackAuditUiHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>DECX Agent</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
header{padding:16px 24px;background:#fff;border-bottom:1px solid #e2e8f0}
main{display:grid;grid-template-columns:320px 1fr;min-height:calc(100vh - 58px)}
aside{border-right:1px solid #e2e8f0;background:#fff;padding:16px;overflow:auto}
section{padding:16px;overflow:auto}
button{display:block;width:100%;text-align:left;padding:10px 12px;margin:0 0 8px;border:1px solid #e2e8f0;background:#fff;border-radius:6px;cursor:pointer}
button:hover{background:#f1f5f9}
input,select{padding:8px;border:1px solid #cbd5e1;border-radius:6px}
form{margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;min-height:120px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h2,h3{margin:0 0 10px}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px}
.muted{color:#64748b}
</style></head>
<body>
<header><h2>DECX Agent Audit</h2></header>
<main><aside><h3>Projects</h3><div id="projects">loading...</div></aside><section><div id="detail" class="muted">Select a project.</div></section></main>
<script>
async function loadProjects(){
  const projects = await fetch('/api/projects').then(r=>r.json());
  const box = document.getElementById('projects');
  box.innerHTML = '';
  for (const p of projects) {
    const b = document.createElement('button');
    b.textContent = p.session + ' [' + p.status + ']';
    b.onclick = () => loadDetail(p.id);
    box.appendChild(b);
  }
}
async function loadDetail(id){
  const d = await fetch('/api/projects/' + encodeURIComponent(id)).then(r=>r.json());
  document.getElementById('detail').innerHTML = '<h2>'+escapeHtml(d.project.session)+'</h2><p class="muted">'+escapeHtml(d.project.goal)+'</p>' +
    '<p>Status: <strong>'+escapeHtml(d.project.status)+'</strong></p>' +
    '<div class="row"><button style="width:auto" onclick="setStatus(\\''+d.project.id+'\\',\\'active\\')">Resume</button>' +
    '<button style="width:auto" onclick="setStatus(\\''+d.project.id+'\\',\\'stopped\\')">Stop</button></div>' +
    '<form class="row" onsubmit="addHint(event, \\''+d.project.id+'\\')"><input id="hint-'+d.project.id+'" placeholder="Add hint" style="min-width:260px"> <button style="width:auto">Add Hint</button></form>' +
    '<form class="row" onsubmit="addIntent(event, \\''+d.project.id+'\\')">' +
    '<input id="intent-desc-'+d.project.id+'" placeholder="Create intent" style="min-width:300px">' +
    '<input id="intent-role-'+d.project.id+'" placeholder="role" value="explorer" style="width:120px">' +
    '<select id="intent-worker-'+d.project.id+'"><option value="">project worker</option><option>noop</option><option>codex</option><option>claude-code</option><option>opencode</option><option>api</option></select>' +
    '<button style="width:auto">Create Intent</button></form>' +
    '<div class="grid">' +
    panel('Facts', d.facts) + panel('Intents', d.intents) + panel('Hints', d.hints) +
    panel('Events', d.events) + panel('Reviews', d.reviews) + panel('Artifacts', d.artifacts) +
    panel('Worker Runs', d.workerRuns) + panel('Workflow Nodes', d.workflowNodes) + panel('Workflow Edges', d.workflowEdges) +
    '</div>';
}
async function setStatus(id,status){
  await fetch('/api/projects/'+encodeURIComponent(id)+'/status',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status})});
  await loadProjects(); await loadDetail(id);
}
async function addHint(event,id){
  event.preventDefault();
  const input = document.getElementById('hint-'+id);
  if (!input.value.trim()) return;
  await fetch('/api/projects/'+encodeURIComponent(id)+'/hints',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:input.value,creator:'web-ui'})});
  input.value = '';
  await loadDetail(id);
}
async function addIntent(event,id){
  event.preventDefault();
  const desc = document.getElementById('intent-desc-'+id);
  const role = document.getElementById('intent-role-'+id);
  const worker = document.getElementById('intent-worker-'+id);
  if (!desc.value.trim()) return;
  const body = {description:desc.value,role:role.value || 'explorer',creator:'web-ui'};
  if (worker.value) body.worker = worker.value;
  await fetch('/api/projects/'+encodeURIComponent(id)+'/intents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  desc.value = '';
  await loadDetail(id);
}
function panel(title, value){ return '<div class="panel"><h3>'+title+'</h3><pre>'+escapeHtml(JSON.stringify(value,null,2))+'</pre></div>'; }
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
loadProjects();
</script>
</body></html>`;
}
