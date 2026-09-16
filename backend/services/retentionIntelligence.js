function clamp(n,min=0,max=100){return Math.max(min,Math.min(max,n));}

async function customerRows(pool, workspaceId, days=90){
  const d=Math.min(365,Math.max(30,Number(days)||90));
  const [rows]=await pool.query(`
    SELECT f.customer_name,
      COUNT(*) feedback_total,
      SUM(f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)) feedback_30d,
      SUM(f.created_at>=DATE_SUB(NOW(),INTERVAL 90 DAY)) feedback_90d,
      SUM(f.sentiment='negative' AND f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)) negative_30d,
      SUM(f.sentiment='positive' AND f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)) positive_30d,
      SUM(f.severity IN ('high','critical') AND f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)) high_risk_30d,
      MIN(f.created_at) first_feedback_at,
      MAX(f.created_at) last_feedback_at,
      COUNT(DISTINCT CASE WHEN p.status<>'resolved' THEN p.id END) unresolved_problems,
      COUNT(DISTINCT CASE WHEN p.status='resolved' THEN p.id END) resolved_problems
    FROM feedback f
    LEFT JOIN problems p ON p.id=f.problem_id
    WHERE f.workspace_id=? AND NULLIF(TRIM(f.customer_name),'') IS NOT NULL
      AND f.created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)
    GROUP BY f.customer_name ORDER BY feedback_30d DESC, feedback_total DESC`,[workspaceId,d]);
  return rows.map(r=>{
    const total30=Number(r.feedback_30d||0), neg=Number(r.negative_30d||0), pos=Number(r.positive_30d||0);
    const negativeRate=total30?neg/total30:0;
    const recurrence=Math.min(1,total30/Math.max(1,Number(r.feedback_90d||0)/3));
    const unresolved=Number(r.unresolved_problems||0);
    const severity=Math.min(1,Number(r.high_risk_30d||0)/Math.max(1,total30));
    let risk=negativeRate*45 + recurrence*20 + Math.min(1,unresolved/3)*20 + severity*15;
    if(pos>neg) risk-=10;
    const score=Math.round(clamp(100-risk));
    let status=score<30?'churn_risk':score<55?'at_risk':(pos>=Math.max(2,neg*2)&&negativeRate<0.25?'expansion':'stable');
    const signals=[];
    if(negativeRate>=0.5)signals.push('high negative feedback');
    if(unresolved>0)signals.push(`${unresolved} unresolved problem${unresolved>1?'s':''}`);
    if(total30>=5)signals.push('high feedback activity');
    if(pos>=Math.max(2,neg*2)&&negativeRate<0.25)signals.push('strong positive signal');
    return {...r,health_score:score,risk_score:Math.round(100-score),status,negative_rate:Number((negativeRate*100).toFixed(1)),signals};
  });
}

async function overview(pool, workspaceId, days=90){
  const customers=await customerRows(pool,workspaceId,days);
  const [[w]]=await pool.query('SELECT id,name,plan_status,mrr FROM workspaces WHERE id=?',[workspaceId]);
  const counts={churn_risk:0,at_risk:0,stable:0,expansion:0}; customers.forEach(c=>counts[c.status]=(counts[c.status]||0)+1);
  const paid=Number(w?.mrr||0)>0;
  const revenueAtRisk=paid&&customers.length?Number((Number(w.mrr)*((counts.churn_risk+counts.at_risk)/customers.length)).toFixed(2)):0;
  const expansionCustomers=customers.filter(c=>c.status==='expansion').slice(0,25);
  const churnCustomers=customers.filter(c=>c.status==='churn_risk').slice(0,25);
  const [reasons]=await pool.query(`SELECT COALESCE(NULLIF(f.category,''),'Uncategorized') reason,COUNT(*) count
    FROM feedback f WHERE f.workspace_id=? AND f.sentiment='negative' AND f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)
    GROUP BY reason ORDER BY count DESC LIMIT 10`,[workspaceId]);
  const [cohorts]=await pool.query(`SELECT DATE_FORMAT(first_feedback,'%Y-%m') cohort,COUNT(*) customers,ROUND(AVG(health_score),1) avg_health,SUM(status IN ('churn_risk','at_risk')) at_risk
    FROM (SELECT f.customer_name,MIN(f.created_at) first_feedback,MAX(f.created_at) last_feedback,
      ROUND(100-GREATEST(0,LEAST(100,(SUM(f.sentiment='negative' AND f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY))/GREATEST(1,SUM(f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY))))*45 +
      LEAST(1,SUM(f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY))/GREATEST(1,SUM(f.created_at>=DATE_SUB(NOW(),INTERVAL 90 DAY))/3))*20))) health_score,
      CASE WHEN (SUM(f.sentiment='negative' AND f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY))/GREATEST(1,SUM(f.created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY))))*45>55 THEN 'churn_risk' ELSE 'stable' END status
      FROM feedback f WHERE f.workspace_id=? AND NULLIF(TRIM(f.customer_name),'') IS NOT NULL GROUP BY f.customer_name) x GROUP BY cohort ORDER BY cohort DESC LIMIT 12`,[workspaceId]);
  const avg=customers.length?Number((customers.reduce((s,c)=>s+c.health_score,0)/customers.length).toFixed(1)):0;
  return {workspace:w||null,period_days:Number(days),summary:{customers:customers.length,average_health:avg,...counts,revenue_at_risk:revenueAtRisk},customers,at_risk_customers:[...churnCustomers,...customers.filter(c=>c.status==='at_risk').slice(0,25)],expansion_opportunities:expansionCustomers,churn_reasons:reasons,cohorts};
}

async function snapshot(pool, workspaceId, data){
  const [r]=await pool.query(`INSERT INTO retention_snapshots(workspace_id,period_days,customers,average_health,churn_risk,at_risk,stable,expansion,revenue_at_risk,summary_json) VALUES(?,?,?,?,?,?,?,?,?,?)`,[workspaceId,data.period_days,data.summary.customers,data.summary.average_health,data.summary.churn_risk,data.summary.at_risk,data.summary.stable,data.summary.expansion,data.summary.revenue_at_risk,JSON.stringify({churn_reasons:data.churn_reasons,cohorts:data.cohorts})]);
  return r.insertId;
}

module.exports={customerRows,overview,snapshot,clamp};
