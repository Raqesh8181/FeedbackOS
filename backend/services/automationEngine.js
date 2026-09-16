function normalizeRule(r){return {...r,enabled:Boolean(r.enabled),threshold:Number(r.threshold||0)}}

async function overview(pool){
  const [[rules]] = await pool.query(`SELECT COUNT(*) total, SUM(enabled=1) enabled FROM automation_rules`);
  const [[queue]] = await pool.query(`SELECT COUNT(*) total, SUM(status='pending') pending, SUM(status='approved') approved, SUM(status='completed') completed, SUM(status='dismissed') dismissed FROM automation_queue`);
  const [ruleRows] = await pool.query(`SELECT * FROM automation_rules ORDER BY id`);
  const [recent] = await pool.query(`SELECT q.*,r.name rule_name FROM automation_queue q LEFT JOIN automation_rules r ON r.id=q.rule_id ORDER BY q.created_at DESC LIMIT 50`);
  const [runs] = await pool.query(`SELECT * FROM automation_runs ORDER BY id DESC LIMIT 20`);
  return {rules:{total:Number(rules.total||0),enabled:Number(rules.enabled||0)},rules_list:ruleRows,queue:{total:Number(queue.total||0),pending:Number(queue.pending||0),approved:Number(queue.approved||0),completed:Number(queue.completed||0),dismissed:Number(queue.dismissed||0)},items:recent,runs};
}

async function createRule(pool,x){
  const name=String(x.name||'Untitled automation').trim();
  const type=String(x.rule_type||'escalation');
  const allowed=['escalation','owner_assignment','preventive_alert','action_followup'];
  if(!allowed.includes(type)) throw new Error('Unsupported automation rule type');
  const [r]=await pool.query(`INSERT INTO automation_rules(name,rule_type,description,threshold,action_template,enabled) VALUES(?,?,?,?,?,?)`,[name,type,x.description||'',Number(x.threshold||0),x.action_template||null,x.enabled===false?0:1]);
  return r.insertId;
}

async function run(pool){
  const [rules]=await pool.query(`SELECT * FROM automation_rules WHERE enabled=1 ORDER BY id`);
  let created=0, skipped=0; const details=[];
  for(const rule of rules){
    let candidates=[];
    if(rule.rule_type==='escalation'){
      const threshold=Number(rule.threshold||3);
      [candidates]=await pool.query(`SELECT id,title,priority,status,owner,recommended_team,feedback_count,health FROM problems WHERE status NOT IN ('resolved','closed') AND (priority IN ('high','critical') OR feedback_count>=?) ORDER BY feedback_count DESC LIMIT 50`,[threshold]);
    } else if(rule.rule_type==='owner_assignment'){
      [candidates]=await pool.query(`SELECT id,title,priority,status,owner,recommended_team,feedback_count FROM problems WHERE status NOT IN ('resolved','closed') AND (owner IS NULL OR owner='') AND recommended_team IS NOT NULL AND recommended_team<>'' ORDER BY feedback_count DESC LIMIT 50`);
    } else if(rule.rule_type==='preventive_alert'){
      const threshold=Number(rule.threshold||60);
      [candidates]=await pool.query(`SELECT p.id,p.title,p.priority,p.status,p.owner,p.recommended_team,p.feedback_count,COALESCE(s.risk_score,0) risk_score FROM problems p JOIN (SELECT problem_id,MAX(id) max_id FROM predictive_signals GROUP BY problem_id) m ON m.problem_id=p.id JOIN predictive_signals s ON s.id=m.max_id WHERE p.status NOT IN ('resolved','closed') AND s.risk_score>=? ORDER BY s.risk_score DESC LIMIT 50`,[threshold]);
    } else if(rule.rule_type==='action_followup'){
      [candidates]=await pool.query(`SELECT p.id,p.title,p.priority,p.status,p.owner,p.recommended_team,p.feedback_count,COUNT(a.id) actions FROM problems p LEFT JOIN actions a ON a.problem_id=p.id AND a.status IN ('open','in_progress') WHERE p.status NOT IN ('resolved','closed') GROUP BY p.id HAVING actions=0 ORDER BY p.feedback_count DESC LIMIT 50`);
    }
    for(const c of candidates){
      const entityType='problem', entityId=c.id;
      const exists=await pool.query(`SELECT id FROM automation_queue WHERE rule_id=? AND entity_type=? AND entity_id=? AND status IN ('pending','approved') LIMIT 1`,[rule.id,entityType,entityId]);
      if(exists[0].length){skipped++;continue}
      let title='',description='',recommendedAction='Review and approve this automation.';
      if(rule.rule_type==='escalation'){title=`Escalate: ${c.title}`;description=rule.action_template||`Escalate ${c.title} to ${c.recommended_team||'the accountable team'} because it is high impact or recurring.`;recommendedAction='Escalate for human review';}
      if(rule.rule_type==='owner_assignment'){title=`Assign owner: ${c.title}`;description=rule.action_template||`Assign an accountable owner from ${c.recommended_team}.`;recommendedAction='Assign owner';}
      if(rule.rule_type==='preventive_alert'){title=`Preventive alert: ${c.title}`;description=rule.action_template||`Problem risk score has crossed the automation threshold.`;recommendedAction='Review preventive action';}
      if(rule.rule_type==='action_followup'){title=`Action gap: ${c.title}`;description=rule.action_template||`This active problem has no open or in-progress action.`;recommendedAction='Create or assign action';}
      await pool.query(`INSERT INTO automation_queue(rule_id,entity_type,entity_id,title,description,recommended_action,payload,status) VALUES(?,?,?,?,?,?,?,?)`,[rule.id,entityType,entityId,title,description,recommendedAction,JSON.stringify(c),'pending']);
      created++;
    }
    details.push({rule_id:rule.id,rule:rule.name,candidates:candidates.length});
  }
  const [z]=await pool.query(`INSERT INTO automation_runs(trigger_type,rules_evaluated,items_created,items_skipped,summary) VALUES(?,?,?,?,?)`,['manual',rules.length,created,skipped,`Evaluated ${rules.length} rules; created ${created} review items.`]);
  return {run_id:z.insertId,rules_evaluated:rules.length,created,skipped,details};
}

async function updateQueue(pool,id,x){
  const status=x.status;
  if(!['pending','approved','completed','dismissed'].includes(status)) throw new Error('Invalid automation queue status');
  await pool.query(`UPDATE automation_queue SET status=?,reviewed_by=?,reviewed_at=NOW(),completed_at=CASE WHEN ?='completed' THEN NOW() ELSE completed_at END WHERE id=?`,[status,x.reviewed_by||'Human reviewer',status,id]);
  return {ok:true};
}

async function seedDefaults(pool){
  const [[x]]=await pool.query('SELECT COUNT(*) count FROM automation_rules');
  if(Number(x.count)) return false;
  const defaults=[
    ['High-impact escalation','escalation','Create a review item for high/critical or recurring open problems.',3,'Escalate to the accountable team for human review.'],
    ['Unowned problem assignment','owner_assignment','Create a review item when an open problem has a recommended team but no owner.',0,'Assign an accountable owner before work begins.'],
    ['High-risk prevention alert','preventive_alert','Create a review item when predictive risk crosses the configured threshold.',60,'Review and approve a preventive action.'],
    ['Action gap follow-up','action_followup','Create a review item for active problems without an open action.',0,'Create or assign a concrete action.']
  ];
  for(const d of defaults) await pool.query(`INSERT INTO automation_rules(name,rule_type,description,threshold,action_template,enabled) VALUES(?,?,?,?,?,1)`,d);
  return true;
}

module.exports={overview,createRule,run,updateQueue,seedDefaults};
