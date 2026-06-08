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
<html><head><meta charset="utf-8"><title>Agent Audit</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;background:#f5f7fb;color:#172033}
header{height:56px;padding:0 20px;background:#fff;border-bottom:1px solid #dfe5ef;display:flex;align-items:center;justify-content:space-between}
main{display:grid;grid-template-columns:300px minmax(0,1fr) 360px;min-height:calc(100vh - 56px)}
aside{border-right:1px solid #dfe5ef;background:#fff;padding:14px;overflow:auto}
section{padding:14px;overflow:auto}
.side{border-left:1px solid #dfe5ef;background:#fff}
h1{font-size:18px;margin:0}.sub{color:#66758c;font-size:12px}.muted{color:#66758c}
h2{font-size:18px;margin:0 0 4px}h3{font-size:13px;margin:0 0 10px;text-transform:uppercase;color:#66758c;letter-spacing:.04em}
button{border:1px solid #cfd8e6;background:#fff;color:#172033;border-radius:6px;cursor:pointer;padding:8px 10px;font:inherit}
button:hover{background:#eef3f9}.primary{background:#1f6feb;color:#fff;border-color:#1f6feb}.primary:hover{background:#195fc8}
.danger{color:#9f1239}.small{font-size:12px;padding:5px 8px}.icon{width:32px;height:32px;padding:0;text-align:center}
input,select,textarea{width:100%;padding:8px;border:1px solid #cfd8e6;border-radius:6px;background:#fff;color:#172033;font:inherit}
textarea{min-height:72px;resize:vertical}.field{margin:0 0 10px}.label{display:block;font-size:12px;color:#66758c;margin:0 0 4px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.between{display:flex;justify-content:space-between;gap:12px;align-items:center}.stack{display:grid;gap:10px}
.project{width:100%;text-align:left;margin:0 0 8px;padding:10px;border-radius:6px}.project.active{border-color:#1f6feb;background:#edf5ff}
.pill{display:inline-flex;align-items:center;border:1px solid #cfd8e6;border-radius:999px;padding:2px 8px;font-size:12px;background:#fff}.active-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px}.stopped-dot{width:8px;height:8px;border-radius:50%;background:#94a3b8;margin-right:6px}.failed-dot{width:8px;height:8px;border-radius:50%;background:#ef4444;margin-right:6px}.completed-dot{width:8px;height:8px;border-radius:50%;background:#1f6feb;margin-right:6px}
.tabs{display:flex;gap:6px;border-bottom:1px solid #dfe5ef;margin:12px 0}.tab{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent}.tab.active{border-bottom-color:#1f6feb;color:#1f6feb}
.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.metric{background:#fff;border:1px solid #dfe5ef;border-radius:8px;padding:12px}.metric b{display:block;font-size:24px}.metric span{font-size:12px;color:#66758c}
.panel{background:#fff;border:1px solid #dfe5ef;border-radius:8px;padding:12px}.list{display:grid;gap:8px}.item{border:1px solid #dfe5ef;background:#fff;border-radius:6px;padding:10px;text-align:left;width:100%}.item:hover{background:#f8fafc}.item.selected{border-color:#1f6feb;background:#edf5ff}
.graph{min-height:460px;background:#fff;border:1px solid #dfe5ef;border-radius:8px;padding:16px;overflow:auto}.lane{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px;margin:0 0 14px}.lane-title{font-size:12px;color:#66758c;text-transform:uppercase;padding-top:8px}.nodes{display:flex;gap:8px;flex-wrap:wrap}.node{border:1px solid #cfd8e6;border-radius:6px;background:#fff;padding:8px 10px;max-width:240px;text-align:left}.node.fact{border-left:4px solid #16a34a}.node.intent{border-left:4px solid #f59e0b}.node.event{border-left:4px solid #8b5cf6}.node.run{border-left:4px solid #0ea5e9}.node.selected{outline:2px solid #1f6feb}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.45;background:#f8fafc;border:1px solid #dfe5ef;border-radius:6px;padding:10px;max-height:420px;overflow:auto}
.empty{padding:24px;text-align:center;color:#66758c;border:1px dashed #cfd8e6;border-radius:8px;background:#fff}.hidden{display:none}
@media(max-width:980px){main{grid-template-columns:1fr}.side,aside{border:0;border-bottom:1px solid #dfe5ef}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head>
<body>
<header><div><h1>Agent Audit</h1><div class="sub">Projects, graph state, intents, hints, and worker runs</div></div><button class="small" onclick="refresh()">Refresh</button></header>
<main>
  <aside>
    <div class="between"><h3>Projects</h3><button class="small" onclick="toggleNewProject()">New</button></div>
    <form id="new-project" class="panel hidden" onsubmit="createProject(event)">
      <div class="field"><label class="label">task.json or session dir</label><input id="new-config" required placeholder=".decx/agent_tasks/demo/task.json"></div>
      <div class="field"><label class="label">session override</label><input id="new-session" placeholder="optional"></div>
      <div class="field"><label class="label">worker override</label><input id="new-worker" placeholder="optional"></div>
      <button class="primary" type="submit">Create</button>
    </form>
    <div id="projects" class="stack">loading...</div>
  </aside>
  <section>
    <div id="detail" class="empty">Select a project.</div>
  </section>
  <section class="side">
    <div id="inspector" class="empty">Click a graph item.</div>
  </section>
</main>
<script>
let projects = [];
let current = null;
let selected = null;
let tab = localStorage.getItem('agent.tab') || 'overview';

function dot(status){ return '<span class="'+escapeAttr(status)+'-dot"></span>'; }
async function loadProjects(){
  projects = await fetch('/api/projects').then(r=>r.json());
  const box = document.getElementById('projects');
  box.innerHTML = '';
  if (!projects.length) { box.innerHTML = '<div class="empty">No projects yet</div>'; return; }
  for (const p of projects) {
    const b = document.createElement('button');
    b.className = 'project' + (current && current.project.id === p.id ? ' active' : '');
    b.innerHTML = '<div class="between"><strong>'+escapeHtml(p.session)+'</strong><span class="pill">'+dot(p.status)+escapeHtml(p.status)+'</span></div><div class="sub">'+escapeHtml(p.name || p.target)+'</div>';
    b.onclick = () => loadDetail(p.id);
    box.appendChild(b);
  }
}
async function loadDetail(id){
  current = await fetch('/api/projects/' + encodeURIComponent(id)).then(r=>r.json());
  selected = null;
  render();
  await loadProjects();
}
function render(){
  if (!current) return;
  const d = current;
  document.getElementById('detail').innerHTML =
    '<div class="between"><div><h2>'+escapeHtml(d.project.session)+'</h2><div class="muted">'+escapeHtml(d.project.goal)+'</div></div><span class="pill">'+dot(d.project.status)+escapeHtml(d.project.status)+'</span></div>' +
    '<div class="row" style="margin-top:12px">' +
    '<button class="small" onclick="setStatus(\\''+d.project.id+'\\',\\'active\\')">Resume</button>' +
    '<button class="small" onclick="setStatus(\\''+d.project.id+'\\',\\'stopped\\')">Stop</button>' +
    '<button class="small" onclick="completeProject(\\''+d.project.id+'\\')">Complete</button>' +
    '<button class="small" onclick="window.open(\\'/api/projects/'+encodeURIComponent(d.project.id)+'/export\\',\\'_blank\\')">Export</button>' +
    '</div>' +
    tabs() + tabContent(d);
  renderInspector();
}
function tabs(){
  const names = [['overview','Overview'],['graph','Graph'],['intents','Intents'],['log','Log'],['raw','Raw']];
  return '<div class="tabs">'+names.map(n => '<button class="tab '+(tab===n[0]?'active':'')+'" onclick="setTab(\\''+n[0]+'\\')">'+n[1]+'</button>').join('')+'</div>';
}
function setTab(name){ tab = name; localStorage.setItem('agent.tab', name); render(); }
function tabContent(d){
  if (tab === 'graph') return graphView(d);
  if (tab === 'intents') return intentView(d);
  if (tab === 'log') return logView(d);
  if (tab === 'raw') return panel('Project JSON', d);
  return overview(d);
}
function overview(d){
  return '<div class="metric-grid">' +
    metric('Facts', d.facts.length) + metric('Open intents', d.intents.filter(i=>i.status==='open').length) +
    metric('Events', d.events.length) + metric('Worker runs', d.workerRuns.length) +
    '</div><div class="row" style="align-items:flex-start;margin-top:12px">' +
    '<form class="panel" style="flex:1" onsubmit="addHint(event, \\''+d.project.id+'\\')"><h3>Add Hint</h3><textarea id="hint-'+d.project.id+'" placeholder="Useful context for the next step"></textarea><button class="primary" type="submit">Add Hint</button></form>' +
    '<form class="panel" style="flex:1" onsubmit="addIntent(event, \\''+d.project.id+'\\')"><h3>New Intent</h3><div class="field"><textarea id="intent-desc-'+d.project.id+'" placeholder="One concrete next task"></textarea></div><div class="row"><input id="intent-role-'+d.project.id+'" placeholder="role" value="explorer"><select id="intent-worker-'+d.project.id+'"><option value="">project worker</option><option>noop</option><option>codex</option><option>claude-code</option><option>opencode</option><option>api</option></select></div><button class="primary" type="submit">Create Intent</button></form>' +
    '</div><div style="margin-top:12px">'+listPanel('Recent activity', activity(d).slice(-8).reverse())+'</div>';
}
function graphView(d){
  return '<div class="graph">' +
    lane('Facts', d.facts.map(f => node('fact', f.id, f.description, f))) +
    lane('Intents', d.intents.map(i => node('intent', i.id, '['+i.status+'] '+i.description, i))) +
    lane('Events', d.events.map(e => node('event', e.id, e.type, e))) +
    lane('Worker Runs', d.workerRuns.map((r,idx) => node('run', String(idx+1), r.phase+'/'+r.worker+' code='+r.returncode, r))) +
    '</div>';
}
function intentView(d){
  const rows = d.intents.map(i => '<button class="item '+isSelected(i)+'" onclick="selectItem(\\'intent\\',\\''+escapeAttr(i.id)+'\\')"><div class="between"><strong>'+escapeHtml(i.id)+'</strong><span class="pill">'+escapeHtml(i.status)+'</span></div><div>'+escapeHtml(i.description)+'</div><div class="row" style="margin-top:8px">'+intentActions(i).join('')+'</div></button>').join('');
  return '<div class="list">'+(rows || '<div class="empty">No intents yet</div>')+'</div>';
}
function logView(d){ return '<div class="list">'+activity(d).reverse().map(a => '<button class="item" onclick="selectByKindId(\\''+escapeAttr(a.kind)+'\\',\\''+escapeAttr(a.id)+'\\')"><div class="between"><strong>'+escapeHtml(a.label)+'</strong><span class="sub">'+escapeHtml(a.time || '')+'</span></div><div class="muted">'+escapeHtml(a.text)+'</div></button>').join('')+'</div>'; }
function lane(title, nodes){ return '<div class="lane"><div class="lane-title">'+title+'</div><div class="nodes">'+(nodes.join('') || '<span class="muted">none</span>')+'</div></div>'; }
function node(kind,id,label,data){ return '<button class="node '+kind+' '+isSelected(data)+'" onclick="selectItem(\\''+kind+'\\',\\''+escapeAttr(id)+'\\')"><strong>'+escapeHtml(id)+'</strong><div>'+escapeHtml(label)+'</div></button>'; }
function metric(label,value){ return '<div class="metric"><b>'+value+'</b><span>'+label+'</span></div>'; }
function listPanel(title,value){ return '<div class="panel"><h3>'+title+'</h3><pre>'+escapeHtml(JSON.stringify(value,null,2))+'</pre></div>'; }
function panel(title, value){ return '<div class="panel"><h3>'+title+'</h3><pre>'+escapeHtml(JSON.stringify(value,null,2))+'</pre></div>'; }
function intentActions(i){
  if (!current) return [];
  const id = current.project.id;
  const buttons = [];
  if (i.status === 'open') buttons.push('<button class="small" onclick="event.stopPropagation();claimIntent(\\''+id+'\\',\\''+i.id+'\\')">Claim</button>');
  if (i.status === 'working') buttons.push('<button class="small" onclick="event.stopPropagation();releaseIntent(\\''+id+'\\',\\''+i.id+'\\')">Release</button>');
  if (i.status !== 'done') buttons.push('<button class="small" onclick="event.stopPropagation();concludeIntent(\\''+id+'\\',\\''+i.id+'\\')">Conclude</button>');
  return buttons;
}
function activity(d){
  return []
    .concat(d.workerRuns.map((r,idx)=>({kind:'run',id:String(idx+1),label:r.phase+'/'+r.worker,text:'return code '+r.returncode,time:r.completedAt,data:r})))
    .concat(d.events.map(e=>({kind:'event',id:e.id,label:e.type,text:e.category || e.source || '',time:e.createdAt,data:e})))
    .concat(d.reviews.map(r=>({kind:'review',id:r.id,label:'review '+(r.severity || 'info'),text:r.summary,time:r.createdAt,data:r})))
    .sort((a,b)=>String(a.time).localeCompare(String(b.time)));
}
function selectItem(kind,id){
  selected = findItem(kind,id);
  render();
}
function selectByKindId(kind,id){ selected = findItem(kind,id); renderInspector(); }
function findItem(kind,id){
  if (!current) return null;
  const map = {fact:current.facts,intent:current.intents,event:current.events,review:current.reviews};
  if (kind === 'run') return {kind:kind,id:id,data:current.workerRuns[Number(id)-1]};
  const data = (map[kind] || []).find(x => x.id === id);
  return data ? {kind:kind,id:id,data:data} : null;
}
function isSelected(data){ return selected && selected.data === data ? 'selected' : ''; }
function renderInspector(){
  const box = document.getElementById('inspector');
  if (!selected) { box.innerHTML = '<div class="empty">Click a graph item.</div>'; return; }
  box.innerHTML = '<div class="between"><h3>'+escapeHtml(selected.kind)+' '+escapeHtml(selected.id)+'</h3><button class="icon" onclick="selected=null;renderInspector()">x</button></div><pre>'+escapeHtml(JSON.stringify(selected.data,null,2))+'</pre>';
}
async function setStatus(id,status){
  await fetch('/api/projects/'+encodeURIComponent(id)+'/status',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status})});
  await loadProjects(); await loadDetail(id);
}
async function completeProject(id){
  await fetch('/api/projects/'+encodeURIComponent(id)+'/complete',{method:'POST'});
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
async function claimIntent(projectId,intentId){ await fetch('/api/projects/'+projectId+'/intents/'+intentId+'/claim',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); await loadDetail(projectId); }
async function releaseIntent(projectId,intentId){ await fetch('/api/projects/'+projectId+'/intents/'+intentId+'/release',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); await loadDetail(projectId); }
async function concludeIntent(projectId,intentId){
  const description = prompt('Conclusion fact');
  if (!description) return;
  await fetch('/api/projects/'+projectId+'/intents/'+intentId+'/conclude',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({description:description,evidence:[],source:'web-ui'})});
  await loadDetail(projectId);
}
async function createProject(event){
  event.preventDefault();
  const body = {configPath:document.getElementById('new-config').value,session:document.getElementById('new-session').value,worker:document.getElementById('new-worker').value};
  const result = await fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  if (result.error) { alert(result.error); return; }
  document.getElementById('new-project').classList.add('hidden');
  await loadProjects(); await loadDetail(result.project.id);
}
function toggleNewProject(){ document.getElementById('new-project').classList.toggle('hidden'); }
async function refresh(){ if (current) await loadDetail(current.project.id); else await loadProjects(); }
function escapeHtml(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s){ return String(s).replace(/[^a-zA-Z0-9_.:-]/g, '-'); }
loadProjects();
</script>
</body></html>`;
}
