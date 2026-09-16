function clamp(n,a=0,b=100){return Math.max(a,Math.min(b,Number(n)||0));}

async function overview(pool){
  const [[fb]]=await pool.query(`SELECT COUNT(*) total, SUM(sentiment='negative') negative, COUNT(DISTINCT customer_name) customers FROM feedback`);
  const [[pr]]=await pool.query(`SELECT COUNT(*) active, SUM(priority IN ('high','critical')) high, SUM(owner IS NULL OR owner='') unowned, COALESCE(SUM(feedback_count),0) reports FROM problems WHERE status NOT IN ('resolved','closed')`);
  const [[ac]]=await pool.query(`SELECT COUNT(*) open_actions FROM actions WHERE status NOT IN ('completed','cancelled')`);
  const [[auto]]=await pool.query(`SELECT COUNT(*) pending FROM automation_queue WHERE status='pending'`);
  const [[pred]]=await pool.query(`SELECT COUNT(*) signals, COALESCE(AVG(risk_score),0) avg_risk FROM predictive_signals WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
  const [[init]]=await pool.query(`SELECT COUNT(*) active_initiatives FROM strategic_initiatives WHERE status NOT IN ('completed','cancelled')`);
  const [[journey]]=await pool.query(`SELECT COUNT(*) mapped FROM feedback WHERE journey_stage IS NOT NULL AND journey_stage<>''`);
  const [[features]]=await pool.query(`SELECT COUNT(*) mapped FROM feedback WHERE feature_name IS NOT NULL AND feature_name<>''`);
  const neg=Number(fb.negative||0), total=Number(fb.total||0);
  const health=clamp(100-(neg/Math.max(total,1))*55-(Number(pr.high||0)*4)-(Number(auto.pending||0)*2)-(Number(pred.avg_risk||0)*0.12));
  return {health_score:Math.round(health),health_label:health>=80?'Healthy':health>=60?'Watch':health>=40?'At risk':'Critical', feedback:{total,negative}, customers:Number(fb.customers||0), problems:{active:Number(pr.active||0),high:Number(pr.high||0),unowned:Number(pr.unowned||0),reports:Number(pr.reports||0)}, actions:{open:Number(ac.open_actions||0)}, automation:{pending:Number(auto.pending||0)}, prediction:{signals:Number(pred.signals||0),avg_risk:Number(pred.avg_risk||0)}, strategy:{active_initiatives:Number(init.active_initiatives||0)}, journey:{mapped:Number(journey.mapped||0)}, features:{mapped:Number(features.mapped||0)}};
}

async function attention(pool){
  const [rows]=await pool.query(`SELECT id,title,priority,status,owner,feedback_count,COALESCE(root_cause_score,0) root_cause_score,COALESCE(resolution_effectiveness,0) resolution_effectiveness FROM problems WHERE status NOT IN ('resolved','closed') ORDER BY FIELD(priority,'critical','high','medium','low'), feedback_count DESC LIMIT 25`);
  return rows.map(p=>{const impact=Number(p.feedback_count||0);const risk=Number(p.root_cause_score||0);const unresolved=100-Math.max(0,Number(p.resolution_effectiveness||0));const score=clamp(impact*3+risk*.45+unresolved*.25+(p.owner?0:15));return {...p,attention_score:Math.round(score),attention_level:score>=100?'Critical':score>=60?'High':score>=30?'Watch':'Monitor',next_action:p.owner?'Investigate / execute action':'Assign an accountable owner'};}).sort((a,b)=>b.attention_score-a.attention_score).slice(0,10);
}

async function run(pool){
  const before=await overview(pool); const items=await attention(pool);
  const actions=[];
  for(const p of items.slice(0,5)) actions.push({entity_type:'problem',entity_id:p.id,title:p.title,priority:p.priority,score:p.attention_score,next_action:p.next_action});
  const summary=`Health ${before.health_score}. ${before.problems.active} active problems, ${before.problems.high} high-priority, ${before.automation.pending} automation items pending. ${items[0]?`Top attention: ${items[0].title}.`:'No immediate problem requires escalation.'}`;
  const [r]=await pool.query(`INSERT INTO os_runs(trigger_type,health_score,items_created,summary) VALUES(?,?,?,?)`,['manual',before.health_score,actions.length,summary]);
  for(const x of actions){
    await pool.query(`INSERT INTO os_decisions(run_id,entity_type,entity_id,title,priority,score,next_action,status) VALUES(?,?,?,?,?,?,?,'proposed')`,[r.insertId,x.entity_type,x.entity_id,x.title,x.priority,x.score,x.next_action]);
  }
  return {run_id:r.insertId,summary,items:actions};
}

async function queue(pool){
 const [rows]=await pool.query(`SELECT d.*,r.created_at run_created_at FROM os_decisions d LEFT JOIN os_runs r ON r.id=d.run_id WHERE d.status IN ('proposed','approved') ORDER BY d.score DESC,d.id DESC LIMIT 30`);
 const [[c]]=await pool.query(`SELECT SUM(status='proposed') proposed,SUM(status='approved') approved,SUM(status='completed') completed,SUM(status='dismissed') dismissed FROM os_decisions`);
 return {items:rows,counts:{proposed:Number(c.proposed||0),approved:Number(c.approved||0),completed:Number(c.completed||0),dismissed:Number(c.dismissed||0)}};
}

async function updateDecision(pool,id,status,reviewed_by){
 if(!['proposed','approved','dismissed','completed'].includes(status)) throw new Error('Invalid decision status');
 await pool.query(`UPDATE os_decisions SET status=?,reviewed_by=?,reviewed_at=NOW(),completed_at=CASE WHEN ?='completed' THEN NOW() ELSE completed_at END WHERE id=?`,[status,reviewed_by||'human',status,id]);
 const [[row]]=await pool.query(`SELECT * FROM os_decisions WHERE id=?`,[id]); return row;
}

async function snapshot(pool,title,summary){
 const o=await overview(pool); const [r]=await pool.query(`INSERT INTO os_snapshots(title,summary,health_score) VALUES(?,?,?)`,[title||'FeedbackOS Operating Snapshot',summary||`Health ${o.health_score}; ${o.problems.active} active problems; ${o.actions.open} open actions.`,o.health_score]); return {id:r.insertId,...o};
}
async function snapshots(pool){const [r]=await pool.query(`SELECT * FROM os_snapshots ORDER BY id DESC LIMIT 20`);return r;}
module.exports={overview,attention,run,queue,updateDecision,snapshot,snapshots};
