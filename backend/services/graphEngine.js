function tokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
}
function lexicalSimilarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / Math.max(1, new Set([...A, ...B]).size);
}
function addNode(nodes, node) { if (!nodes.has(node.id)) nodes.set(node.id, node); }
function addEdge(edges, seen, edge) {
  const key = `${edge.source}|${edge.target}|${edge.type}`;
  if (seen.has(key) || edge.source === edge.target) return;
  seen.add(key); edges.push(edge);
}

async function buildIntelligenceGraph(pool, options = {}) {
  const problemLimit = Math.min(40, Math.max(5, Number(options.problemLimit || 30)));
  const feedbackLimit = Math.min(80, Math.max(10, Number(options.feedbackLimit || 60)));
  const [problems] = await pool.query(`
    SELECT id,title,description,impact,category,recommended_team,priority,severity,status,owner,
           feedback_count,health,first_detected_at,last_detected_at,resolved_at,updated_at
    FROM problems
    ORDER BY FIELD(priority,'critical','high','medium','low'), feedback_count DESC, updated_at DESC
    LIMIT ${problemLimit}`);
  if (!problems.length) return {nodes:[],edges:[],stats:{problems:0,feedback:0,customers:0,actions:0,owners:0,relationships:0},root_causes:[],generated_at:new Date().toISOString()};

  const problemIds = problems.map(p => p.id);
  const [feedback] = await pool.query(`
    SELECT f.id,f.problem_id,f.customer_name,f.source,f.message,f.sentiment,f.category,f.severity,f.created_at
    FROM feedback f
    WHERE f.problem_id IN (?)
    ORDER BY f.created_at DESC LIMIT ${feedbackLimit}`, [problemIds]);
  const [actions] = await pool.query(`
    SELECT a.id,a.problem_id,a.owner,a.description,a.status,a.expected_impact_percent,a.actual_impact_percent,a.outcome_status,a.completed_at,a.measured_at
    FROM actions a WHERE a.problem_id IN (?) ORDER BY COALESCE(a.completed_at,a.created_at) DESC LIMIT 100`, [problemIds]);

  const nodes = new Map(), edges = [], seen = new Set();
  const problemMap = new Map(problems.map(p => [Number(p.id), p]));
  for (const p of problems) {
    addNode(nodes, {id:`problem:${p.id}`,type:'problem',label:p.title,meta:{id:p.id,priority:p.priority,status:p.status,health:p.health,feedback_count:Number(p.feedback_count||0),owner:p.owner||p.recommended_team||null}});
    if (p.owner || p.recommended_team) {
      const owner = p.owner || p.recommended_team;
      const oid = `owner:${String(owner).toLowerCase()}`;
      addNode(nodes,{id:oid,type:'owner',label:owner,meta:{name:owner}});
      addEdge(edges,seen,{source:`problem:${p.id}`,target:oid,type:'owned_by',weight:1,label:'owned by'});
    }
  }

  const customerNodes = new Set();
  for (const f of feedback) {
    addNode(nodes,{id:`feedback:${f.id}`,type:'feedback',label:String(f.message||'').slice(0,85),meta:{id:f.id,source:f.source,sentiment:f.sentiment,category:f.category,created_at:f.created_at}});
    if (f.problem_id) addEdge(edges,seen,{source:`feedback:${f.id}`,target:`problem:${f.problem_id}`,type:'signals',weight:1,label:'signals'});
    if (f.customer_name) {
      const name = String(f.customer_name).trim();
      const cid = `customer:${name.toLowerCase()}`;
      addNode(nodes,{id:cid,type:'customer',label:name,meta:{name}}); customerNodes.add(cid);
      addEdge(edges,seen,{source:cid,target:`feedback:${f.id}`,type:'left_feedback',weight:1,label:'left feedback'});
    }
  }

  const ownerActionCounts = {};
  for (const a of actions) {
    addNode(nodes,{id:`action:${a.id}`,type:'action',label:a.description,meta:{id:a.id,status:a.status,owner:a.owner,expected_impact_percent:a.expected_impact_percent==null?null:Number(a.expected_impact_percent),actual_impact_percent:a.actual_impact_percent==null?null:Number(a.actual_impact_percent),outcome_status:a.outcome_status||'not measured'}});
    addEdge(edges,seen,{source:`problem:${a.problem_id}`,target:`action:${a.id}`,type:'has_action',weight:1,label:'has action'});
    if (a.owner) {
      const oid=`owner:${String(a.owner).toLowerCase()}`;
      addNode(nodes,{id:oid,type:'owner',label:a.owner,meta:{name:a.owner}});
      addEdge(edges,seen,{source:`action:${a.id}`,target:oid,type:'assigned_to',weight:1,label:'assigned to'});
      ownerActionCounts[a.owner]=(ownerActionCounts[a.owner]||0)+1;
    }
  }

  // Connect related problems using language, category, team, and overlapping customers.
  const problemCustomers = new Map();
  for (const f of feedback) {
    if (!f.problem_id || !f.customer_name) continue;
    const set = problemCustomers.get(Number(f.problem_id)) || new Set(); set.add(String(f.customer_name).toLowerCase()); problemCustomers.set(Number(f.problem_id),set);
  }
  const rootCauses=[];
  for (let i=0;i<problems.length;i++) for (let j=i+1;j<problems.length;j++) {
    const a=problems[i], b=problems[j];
    const textSim=lexicalSimilarity(`${a.title} ${a.description||''} ${a.category||''}`,`${b.title} ${b.description||''} ${b.category||''}`);
    const sameCategory=a.category && b.category && String(a.category).toLowerCase()===String(b.category).toLowerCase();
    const sameOwner=(a.owner||a.recommended_team) && (b.owner||b.recommended_team) && String(a.owner||a.recommended_team).toLowerCase()===String(b.owner||b.recommended_team).toLowerCase();
    const ca=problemCustomers.get(Number(a.id))||new Set(), cb=problemCustomers.get(Number(b.id))||new Set();
    const overlap=[...ca].filter(x=>cb.has(x)).length;
    const score=Math.min(1,textSim + (sameCategory?0.12:0) + (sameOwner?0.08:0) + Math.min(.18,overlap*.06));
    if (score >= 0.20) {
      const label = score >= .55 ? 'strongly related' : sameCategory ? 'same category' : 'related signal';
      addEdge(edges,seen,{source:`problem:${a.id}`,target:`problem:${b.id}`,type:'related_to',weight:Number(score.toFixed(3)),label});
      if (score >= .42) rootCauses.push({problem_id:Number(a.id),related_problem_id:Number(b.id),score:Number(score.toFixed(3)),reason:[textSim>=.2?'similar language':null,sameCategory?'same category':null,sameOwner?'same owner/team':null,overlap?`${overlap} shared customer${overlap>1?'s':''}`:null].filter(Boolean).join(', ')});
    }
  }
  rootCauses.sort((a,b)=>b.score-a.score);

  return {
    nodes:[...nodes.values()],
    edges,
    stats:{problems:problems.length,feedback:feedback.length,customers:customerNodes.size,actions:actions.length,owners:[...nodes.values()].filter(n=>n.type==='owner').length,relationships:edges.length},
    root_causes:rootCauses.slice(0,10),
    generated_at:new Date().toISOString()
  };
}
module.exports={buildIntelligenceGraph};
