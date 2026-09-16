function tokens(s){return new Set(String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>2))}
function jaccard(a,b){const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return n/(A.size+B.size-n)}
function riskLevel(score){return score>=80?'critical':score>=60?'high':score>=35?'watch':'low'}
async function rootCause(pool,id){
 const [[p]]=await pool.query('SELECT * FROM problems WHERE id=?',[id]); if(!p)return null;
 const [others]=await pool.query('SELECT * FROM problems WHERE id<>? ORDER BY feedback_count DESC LIMIT 50',[id]);
 const related=others.map(x=>({...x,score:jaccard(`${p.title} ${p.description||''}`,`${x.title} ${x.description||''}`)})).filter(x=>x.score>=0.15).sort((a,b)=>b.score-a.score).slice(0,8);
 for(const r of related) await pool.query(`INSERT INTO problem_relationships(problem_id,related_problem_id,relationship_type,score,explanation) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE relationship_type=VALUES(relationship_type),score=VALUES(score),explanation=VALUES(explanation)`,[id,r.id,'related',r.score,`Shared language similarity ${Math.round(r.score*100)}%.`]);
 const category=String(p.category||'').toLowerCase();
 let hypothesis='Customer-facing issue is likely driven by a recurring process, product, or operational failure that should be investigated against the linked feedback and related problems.';
 if(category.includes('payment')) hypothesis='Likely checkout/payment authorization or transaction-state failure; inspect authorization declines, timeouts, and payment/order reconciliation.';
 else if(category.includes('delivery')) hypothesis='Likely ETA calculation or fulfillment delay; compare promised ETA, dispatch time, route/warehouse latency, and actual arrival.';
 else if(category.includes('refund')) hypothesis='Likely refund pipeline bottleneck; trace refund initiation, processor settlement, and customer-facing status updates.';
 else if(category.includes('performance')||category.includes('crash')) hypothesis='Likely application reliability defect in the affected order flow; reproduce, inspect crash/error logs, and isolate the failing screen or release.';
 const confidence=Math.min(95,35+related.length*7+Math.min(25,Number(p.feedback_count||0)*2));
 await pool.query('UPDATE problems SET root_cause_score=?,root_cause_summary=? WHERE id=?',[confidence,hypothesis,id]);
 return {problem:p,hypothesis,confidence,related};
}
async function ensureInvestigation(pool,id){
 const [[row]]=await pool.query('SELECT * FROM root_cause_investigations WHERE problem_id=?',[id]);
 if(row)return row;
 const r=await rootCause(pool,id);
 const [z]=await pool.query('INSERT INTO root_cause_investigations(problem_id,hypothesis,confidence,evidence_summary) VALUES(?,?,?,?)',[id,r?.hypothesis||'Investigate the strongest recurring signal.',r?.confidence||0,`Linked feedback: ${r?.problem?.feedback_count||0}; related problems: ${r?.related?.length||0}.`]);
 const [[created]]=await pool.query('SELECT * FROM root_cause_investigations WHERE id=?',[z.insertId]); return created;
}
async function refreshInvestigation(pool,id){const inv=await ensureInvestigation(pool,id);const r=await rootCause(pool,id);await pool.query('UPDATE root_cause_investigations SET hypothesis=?,confidence=?,evidence_summary=?,updated_at=NOW() WHERE id=?',[r.hypothesis,r.confidence,`Linked feedback: ${r.problem.feedback_count||0}; related problems: ${r.related.length}.`,inv.id]);return getInvestigation(pool,id)}
async function getInvestigation(pool,id){const inv=await ensureInvestigation(pool,id);const [tasks]=await pool.query('SELECT * FROM investigation_tasks WHERE investigation_id=? ORDER BY id DESC',[inv.id]);const [rel]=await pool.query(`SELECT pr.*,p.title,p.category,p.priority,p.status FROM problem_relationships pr JOIN problems p ON p.id=pr.related_problem_id WHERE pr.problem_id=? ORDER BY pr.score DESC LIMIT 10`,[id]);const [memory]=await pool.query(`SELECT id,description,status,actual_impact_percent,outcome_status FROM actions WHERE problem_id=? ORDER BY id DESC LIMIT 10`,[id]);return {investigation:inv,tasks,related:rel,memory}}
async function createInvestigationTask(pool,id,body){const inv=await ensureInvestigation(pool,id);const [z]=await pool.query('INSERT INTO investigation_tasks(investigation_id,title,description,owner) VALUES(?,?,?,?)',[inv.id,body.title,body.description||'',body.owner||null]);return z.insertId}
async function decision(pool,id,body){const inv=await ensureInvestigation(pool,id);const decision=String(body.decision||'inconclusive');await pool.query('UPDATE root_cause_investigations SET decision=?,decision_notes=?,status=?,updated_at=NOW() WHERE id=?',[decision,body.notes||'',decision==='confirmed'?'confirmed':decision==='rejected'?'rejected':'open',inv.id]);if(decision==='confirmed')await pool.query("UPDATE problems SET status=CASE WHEN status='resolved' THEN status ELSE 'investigating' END WHERE id=?",[id]);return getInvestigation(pool,id)}
async function prediction(pool,id){
 const [[p]]=await pool.query('SELECT * FROM problems WHERE id=?',[id]);if(!p)return null;
 const [[s]]=await pool.query(`SELECT COALESCE(SUM(CASE WHEN date>=DATE_SUB(CURDATE(),INTERVAL 6 DAY) THEN negative_count ELSE 0 END),0) recent,COALESCE(SUM(CASE WHEN date BETWEEN DATE_SUB(CURDATE(),INTERVAL 13 DAY) AND DATE_SUB(CURDATE(),INTERVAL 7 DAY) THEN negative_count ELSE 0 END),0) previous FROM daily_metrics WHERE problem_id=?`,[id]);
 const recent=Number(s.recent||0), previous=Number(s.previous||0); const trend=recent>previous*1.15?'rising':recent<previous*.85?'falling':'flat';
 const growth=previous?Math.max(-1,Math.min(2,(recent-previous)/previous)):recent?1:0; let risk=25+Number(p.feedback_count||0)*3+(p.priority==='critical'?30:p.priority==='high'?20:p.priority==='medium'?10:0)+(trend==='rising'?20:trend==='falling'?-10:0)+growth*15+(p.health==='Worsening'?15:0);risk=Math.max(0,Math.min(100,risk));
 const forecast=Math.max(0,Math.round((recent/7)*(1+growth)*7*100)/100); const level=riskLevel(risk);
 const [[hist]]=await pool.query(`SELECT AVG(CASE WHEN outcome_status='met' THEN 100 WHEN outcome_status='partial' THEN 60 WHEN outcome_status='missed' THEN 10 ELSE NULL END) forecast FROM actions WHERE problem_id=? AND outcome_status IS NOT NULL`,[id]);
 const success=hist?.forecast==null?50:Number(hist.forecast);
 const explanation=`${trend} trend; ${recent} recent negative signals vs ${previous} in the prior window; ${p.priority||'medium'} priority.`;
 await pool.query('INSERT INTO predictive_signals(problem_id,risk_score,risk_level,trend,forecast_7d,action_success_forecast,explanation) VALUES(?,?,?,?,?,?,?)',[id,risk,level,trend,forecast,success,explanation]);
 return {problem:p,risk_score:Number(risk.toFixed(1)),risk_level:level,trend,forecast_7d:forecast,action_success_forecast:Number(success.toFixed(1)),explanation};
}
async function preventiveQueue(pool){const [ps]=await pool.query(`SELECT p.*,(SELECT risk_score FROM predictive_signals s WHERE s.problem_id=p.id ORDER BY s.id DESC LIMIT 1) risk_score FROM problems p WHERE p.status NOT IN ('resolved','closed') ORDER BY COALESCE((SELECT risk_score FROM predictive_signals s WHERE s.problem_id=p.id ORDER BY s.id DESC LIMIT 1),0) DESC,p.feedback_count DESC LIMIT 20`);return ps.map(p=>({problem:p,suggested_action:p.recommended_action||`Investigate ${p.title}, assign ${p.owner||p.recommended_team||'an owner'}, and validate a targeted fix before the problem worsens.`,risk_score:Number(p.risk_score||0),owner:p.owner||p.recommended_team||null,expected_impact:Math.max(10,Math.min(50,Number(p.feedback_count||0)*3))}))}
async function createPreventive(pool,body){const [z]=await pool.query('INSERT INTO preventive_actions(problem_id,title,description,owner,due_at,expected_impact) VALUES(?,?,?,?,?,?)',[body.problem_id,body.title,body.description||'',body.owner||null,body.due_at||null,body.expected_impact||20]);return z.insertId}
async function runOperatingLoop(pool){const [ps]=await pool.query("SELECT id FROM problems WHERE status NOT IN ('resolved','closed')");let predicted=0;for(const p of ps){await rootCause(pool,p.id);await prediction(pool,p.id);predicted++}return {processed:ps.length,predicted,preventive:(await preventiveQueue(pool)).length}}
module.exports={rootCause,ensureInvestigation,refreshInvestigation,getInvestigation,createInvestigationTask,decision,prediction,preventiveQueue,createPreventive,runOperatingLoop,riskLevel};
