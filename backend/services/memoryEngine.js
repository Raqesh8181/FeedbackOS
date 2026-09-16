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

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

async function ensureBackfill(pool) {
  const [[count]] = await pool.query('SELECT COUNT(*) c FROM problem_events');
  if (Number(count.c || 0) > 0) return;
  const [problems] = await pool.query(`SELECT id,title,description,status,owner,created_at,resolved_at,updated_at FROM problems`);
  for (const p of problems) {
    await pool.query(`INSERT INTO problem_events(problem_id,event_type,title,detail,created_at) VALUES(?,?,?,?,?)`, [p.id,'problem_created','Problem detected',p.description || p.title,p.created_at]);
    if (p.owner) await pool.query(`INSERT INTO problem_events(problem_id,event_type,title,detail,created_at) VALUES(?,?,?,?,?)`, [p.id,'ownership','Owner assigned',`Owner: ${p.owner}`,p.updated_at]);
    if (p.resolved_at) await pool.query(`INSERT INTO problem_events(problem_id,event_type,title,detail,created_at) VALUES(?,?,?,?,?)`, [p.id,'resolved','Problem resolved','A resolution was recorded.',p.resolved_at]);
  }
  const [actions] = await pool.query(`SELECT id,problem_id,description,owner,status,created_at,completed_at,expected_impact_percent,actual_impact_percent,outcome_status,outcome_summary FROM actions`);
  for (const a of actions) {
    await pool.query(`INSERT INTO problem_events(problem_id,event_type,title,detail,metadata,created_at) VALUES(?,?,?,?,?,?)`, [a.problem_id,'action_created','Intervention recorded',a.description,JSON.stringify({action_id:a.id,owner:a.owner,target:a.expected_impact_percent}),a.created_at]);
    if (a.completed_at) await pool.query(`INSERT INTO problem_events(problem_id,event_type,title,detail,metadata,created_at) VALUES(?,?,?,?,?,?)`, [a.problem_id,'action_completed','Intervention completed',a.outcome_summary || `Action completed by ${a.owner || 'unassigned'}`,JSON.stringify({action_id:a.id,outcome_status:a.outcome_status,actual_impact_percent:a.actual_impact_percent}),a.completed_at]);
  }
}

function summarizeAction(a) {
  const impact = a.actual_impact_percent == null ? null : Number(a.actual_impact_percent);
  return {
    id: a.id,
    description: a.description,
    owner: a.owner || 'Unassigned',
    status: a.status,
    expected_impact_percent: a.expected_impact_percent == null ? null : Number(a.expected_impact_percent),
    actual_impact_percent: impact,
    outcome_status: a.outcome_status || 'not measured',
    completed_at: a.completed_at,
    learning: impact == null ? 'No measured outcome yet.' : impact > 0 ? `Reduced negative feedback by ${impact}%.` : impact < 0 ? `Negative feedback increased by ${Math.abs(impact)}%.` : 'No material change in negative feedback.'
  };
}

async function getProblemMemory(pool, problemId) {
  await ensureBackfill(pool);
  const [[problem]] = await pool.query(`SELECT id,title,description,impact,category,priority,severity,status,owner,feedback_count,health,first_detected_at,last_detected_at,resolved_at,updated_at FROM problems WHERE id=?`, [problemId]);
  if (!problem) return null;
  const [actionsRaw] = await pool.query(`SELECT id,problem_id,description,owner,status,created_at,completed_at,expected_impact_percent,actual_impact_percent,outcome_status,outcome_summary FROM actions WHERE problem_id=? ORDER BY created_at DESC`, [problemId]);
  const actions = actionsRaw.map(summarizeAction);
  const [events] = await pool.query(`SELECT id,event_type,title,detail,metadata,created_at FROM problem_events WHERE problem_id=? ORDER BY created_at DESC LIMIT 50`, [problemId]);
  const successful = actions.filter(a => a.outcome_status === 'met' || (a.actual_impact_percent != null && a.actual_impact_percent > 0));
  const failed = actions.filter(a => a.outcome_status === 'missed' || (a.actual_impact_percent != null && a.actual_impact_percent < 0));
  const resolutionDays = problem.resolved_at ? daysBetween(problem.first_detected_at, problem.resolved_at) : null;
  return {
    problem,
    actions,
    events,
    memory: {
      successful_interventions: successful,
      failed_interventions: failed,
      resolution_days: resolutionDays,
      has_history: actions.length > 0 || events.length > 1,
      lesson: successful.length
        ? `Historical evidence suggests ${successful[0].description.toLowerCase()}${successful[0].actual_impact_percent != null ? `, which reduced negative feedback by ${successful[0].actual_impact_percent}%` : ''}.`
        : failed.length
          ? `A previous intervention did not improve the signal: ${failed[0].description}. Treat that approach cautiously.`
          : 'No measured intervention history exists yet. Capture an outcome to create reusable memory.'
    }
  };
}

async function getWorkspaceMemory(pool) {
  await ensureBackfill(pool);
  const [problems] = await pool.query(`SELECT id,title,description,category,priority,status,owner,feedback_count,health,first_detected_at,resolved_at FROM problems ORDER BY updated_at DESC`);
  const [actions] = await pool.query(`SELECT a.id,a.problem_id,a.description,a.owner,a.status,a.created_at,a.completed_at,a.expected_impact_percent,a.actual_impact_percent,a.outcome_status,p.title,p.category FROM actions a LEFT JOIN problems p ON p.id=a.problem_id ORDER BY a.created_at DESC`);
  const measured = actions.filter(a => a.actual_impact_percent != null);
  const successful = measured.filter(a => Number(a.actual_impact_percent) > 0);
  const failed = measured.filter(a => Number(a.actual_impact_percent) < 0);
  const patterns = {};
  for (const a of measured) {
    const key = a.category || 'General';
    patterns[key] ||= {category:key,count:0,avg_impact:0,positive:0};
    patterns[key].count++;
    patterns[key].avg_impact += Number(a.actual_impact_percent || 0);
    if (Number(a.actual_impact_percent) > 0) patterns[key].positive++;
  }
  const actionPatterns = Object.values(patterns).map(x => ({...x,avg_impact:Number((x.avg_impact/x.count).toFixed(1)),success_rate:Number((x.positive/x.count*100).toFixed(1))})).sort((a,b)=>b.avg_impact-a.avg_impact);
  const recurring = problems.filter(p => Number(p.feedback_count||0) >= 3).slice(0,10);
  return {
    metrics: {historical_actions: actions.length, measured_actions: measured.length, successful_actions: successful.length, failed_actions: failed.length, success_rate: measured.length ? Number((successful.length/measured.length*100).toFixed(1)) : 0},
    lessons: successful.slice(0,5).map(a => `${a.category || 'General'}: “${a.description}” produced a ${Number(a.actual_impact_percent).toFixed(1)}% negative-feedback reduction.`),
    cautions: failed.slice(0,5).map(a => `${a.category || 'General'}: “${a.description}” was associated with a ${Math.abs(Number(a.actual_impact_percent)).toFixed(1)}% increase in negative feedback.`),
    action_patterns: actionPatterns.slice(0,8),
    recurring_problems: recurring,
    recent_cases: problems.slice(0,8)
  };
}

async function findSimilarCases(pool, problemId) {
  await ensureBackfill(pool);
  const [[target]] = await pool.query(`SELECT id,title,description,category,priority,status,owner,feedback_count,health,resolved_at FROM problems WHERE id=?`, [problemId]);
  if (!target) return [];
  const [candidates] = await pool.query(`SELECT id,title,description,category,priority,status,owner,feedback_count,health,resolved_at FROM problems WHERE id<>? ORDER BY updated_at DESC LIMIT 100`, [problemId]);
  return candidates.map(p => ({...p,similarity:Number(lexicalSimilarity(`${target.title} ${target.description||''} ${target.category||''}`, `${p.title} ${p.description||''} ${p.category||''}`).toFixed(3))})).filter(p=>p.similarity>=0.15).sort((a,b)=>b.similarity-a.similarity).slice(0,5);
}

module.exports = { ensureBackfill, getProblemMemory, getWorkspaceMemory, findSimilarCases };
