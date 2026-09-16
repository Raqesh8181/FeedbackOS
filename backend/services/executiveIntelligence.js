function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
function priorityScore(p){return ({critical:100,high:75,medium:45,low:20}[String(p||'').toLowerCase()]||20);}
function riskLabel(score){return score>=75?'Critical':score>=50?'High':score>=30?'Watch':'Healthy';}

async function businessOverview(pool){
  const [[fb]]=await pool.query(`SELECT COUNT(*) total, COALESCE(SUM(sentiment='negative'),0) negative,
    COALESCE(SUM(sentiment='positive'),0) positive, COUNT(DISTINCT customer_name) customers FROM feedback`);
  const [[probs]]=await pool.query(`SELECT COUNT(*) total,
    COALESCE(SUM(status NOT IN ('resolved','closed')),0) open,
    COALESCE(SUM(status NOT IN ('resolved','closed') AND priority IN ('high','critical')),0) high,
    COALESCE(SUM(status='resolved'),0) resolved,
    COALESCE(SUM(priority='critical' AND status NOT IN ('resolved','closed')),0) critical FROM problems`);
  const [[actions]]=await pool.query(`SELECT COUNT(*) total,
    COALESCE(SUM(status='open'),0) open,
    COALESCE(SUM(status='in_progress'),0) in_progress,
    COALESCE(SUM(status='completed'),0) completed,
    COALESCE(SUM(actual_impact_percent>0),0) effective FROM actions`);
  const [[trend]]=await pool.query(`SELECT
    COALESCE(SUM(created_at>=DATE_SUB(NOW(),INTERVAL 7 DAY) AND sentiment='negative'),0) recent_negative,
    COALESCE(SUM(created_at>=DATE_SUB(NOW(),INTERVAL 14 DAY) AND created_at<DATE_SUB(NOW(),INTERVAL 7 DAY) AND sentiment='negative'),0) previous_negative
    FROM feedback`);
  const recent=Number(trend.recent_negative||0), prev=Number(trend.previous_negative||0);
  const change=prev?Math.round((recent-prev)/prev*100):0;
  const health=clamp(100-Math.min(55,Number(fb.negative||0)/Math.max(1,Number(fb.total||0))*100*0.65)-Math.min(25,Number(probs.high||0)*4)-Math.min(20,change>0?change*.25:0),0,100);
  return {...fb,...probs,...actions,negative_change:change,health_score:Math.round(health),health_label:riskLabel(100-health)};
}

async function attentionNow(pool){
  const [problems]=await pool.query(`SELECT id,title,priority,severity,status,owner,feedback_count,health,category,root_cause_score
    FROM problems WHERE status NOT IN ('resolved','closed') ORDER BY feedback_count DESC LIMIT 80`);
  return problems.map(p=>{
    const volume=Math.min(35,Number(p.feedback_count||0)*2);
    const root=Number(p.root_cause_score||0)*.12;
    const risk=(priorityScore(p.priority)*.55)+volume+root+(p.health==='Worsening'?12:p.health==='Stable'?3:0)+(p.owner?0:8);
    return {...p,attention_score:Math.round(risk),attention_level:riskLabel(risk)};
  }).sort((a,b)=>b.attention_score-a.attention_score).slice(0,10);
}

async function businessImpact(pool){
  const [rows]=await pool.query(`SELECT COALESCE(category,'Uncategorized') category,
    COUNT(*) feedback_count, COALESCE(SUM(sentiment='negative'),0) negative_count,
    COUNT(DISTINCT customer_name) customers FROM feedback GROUP BY COALESCE(category,'Uncategorized') ORDER BY negative_count DESC LIMIT 12`);
  return rows.map(r=>({...r,negative_rate:Math.round(Number(r.negative_count)/Math.max(1,Number(r.feedback_count))*1000)/10,
    impact_score:Math.round((Number(r.negative_count)*2+Number(r.customers)*1.5)*10)/10}));
}

async function executiveOverview(pool){
  const overview=await businessOverview(pool);
  const attention=await attentionNow(pool);
  const impact=await businessImpact(pool);
  let portfolio={active:0,fund_now:0,defer:0,sequence:0};
  try{
    const [items]=await pool.query(`SELECT portfolio_decision FROM strategic_initiatives WHERE status NOT IN ('completed','cancelled')`);
    portfolio.active=items.length; portfolio.fund_now=items.filter(x=>x.portfolio_decision==='Fund Now').length;
    portfolio.defer=items.filter(x=>x.portfolio_decision==='Defer').length; portfolio.sequence=items.filter(x=>x.portfolio_decision==='Sequence').length;
  }catch(e){}
  let automation={pending:0,approved:0};
  try{const [[q]]=await pool.query(`SELECT COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(status='approved'),0) approved FROM automation_queue`); automation={pending:Number(q.pending),approved:Number(q.approved)}}catch(e){}
  return {overview,attention,impact,portfolio,automation,generated_at:new Date().toISOString()};
}

async function snapshot(pool,title,summary){
  const [r]=await pool.query(`INSERT INTO executive_snapshots(title,summary) VALUES(?,?)`,[title||'Executive Snapshot',summary||'']);
  return {id:r.insertId};
}
async function snapshots(pool){
  const [r]=await pool.query(`SELECT * FROM executive_snapshots ORDER BY id DESC LIMIT 20`); return r;
}
module.exports={businessOverview,attentionNow,businessImpact,executiveOverview,snapshot,snapshots};
