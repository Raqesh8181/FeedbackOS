function teamName(problem) {
  return problem.recommended_team || problem.owner || 'Unassigned';
}

async function overview(pool) {
  const [teams] = await pool.query(`
    SELECT
      COALESCE(NULLIF(p.recommended_team,''), NULLIF(p.owner,''), 'Unassigned') AS team,
      COUNT(DISTINCT p.id) AS problems,
      SUM(p.status NOT IN ('resolved','closed')) AS open_problems,
      SUM(p.priority IN ('high','critical') AND p.status NOT IN ('resolved','closed')) AS high_priority,
      COALESCE(SUM(p.feedback_count),0) AS feedback_count,
      COUNT(DISTINCT CASE WHEN p.status='resolved' THEN p.id END) AS resolved_problems
    FROM problems p
    GROUP BY COALESCE(NULLIF(p.recommended_team,''), NULLIF(p.owner,''), 'Unassigned')
    ORDER BY high_priority DESC, open_problems DESC, feedback_count DESC
  `);
  const [actions] = await pool.query(`
    SELECT COALESCE(NULLIF(team,''), NULLIF(owner,''), 'Unassigned') AS team,
      COUNT(*) total_actions,
      SUM(status IN ('open','in_progress')) open_actions,
      SUM(status='completed') completed_actions,
      AVG(CASE WHEN actual_impact_percent IS NOT NULL THEN actual_impact_percent END) avg_actual_impact
    FROM actions GROUP BY COALESCE(NULLIF(team,''), NULLIF(owner,''), 'Unassigned')
  `);
  const actionMap={};
  for(const a of actions) actionMap[a.team]=a;
  const items=teams.map(t=>{
    const a=actionMap[t.team]||{};
    const openProblems=Number(t.open_problems||0), high=Number(t.high_priority||0), openActions=Number(a.open_actions||0);
    const loadScore=Math.min(100, openProblems*12+high*18+openActions*5);
    const accountability= t.team==='Unassigned' ? 'Needs owner' : high>0 && openActions===0 ? 'Action gap' : openProblems>5 ? 'Overloaded' : 'On track';
    return {...t,...a,load_score:loadScore,accountability};
  });
  const [[summary]]=await pool.query(`
    SELECT
      COUNT(*) total_problems,
      SUM(status NOT IN ('resolved','closed')) open_problems,
      SUM(priority IN ('high','critical') AND status NOT IN ('resolved','closed')) high_priority,
      SUM(owner IS NULL OR owner='') unowned_problems
    FROM problems
  `);
  const [[actionSummary]]=await pool.query(`
    SELECT COUNT(*) total_actions, SUM(status IN ('open','in_progress')) open_actions,
      SUM(status='completed') completed_actions,
      AVG(CASE WHEN actual_impact_percent IS NOT NULL THEN actual_impact_percent END) avg_actual_impact
    FROM actions
  `);
  return {summary:{...summary,...actionSummary,teams:items.length},teams:items};
}

async function teamDetail(pool, team) {
  const [problems]=await pool.query(`
    SELECT p.id,p.title,p.priority,p.status,p.owner,p.recommended_team,p.feedback_count,
      p.first_detected_at,p.last_detected_at
    FROM problems p
    WHERE COALESCE(NULLIF(p.recommended_team,''), NULLIF(p.owner,''), 'Unassigned')=?
    ORDER BY FIELD(p.priority,'critical','high','medium','low'), p.feedback_count DESC
    LIMIT 100`,[team]);
  const [actions]=await pool.query(`
    SELECT a.id,a.problem_id,a.owner,a.team,a.description,a.status,a.created_at,a.completed_at,
      a.actual_impact_percent,a.outcome_status
    FROM actions a
    WHERE COALESCE(NULLIF(a.team,''), NULLIF(a.owner,''), 'Unassigned')=?
    ORDER BY FIELD(a.status,'in_progress','open','completed'), a.created_at DESC
    LIMIT 100`,[team]);
  return {team,problems,actions};
}

async function ownerOverview(pool) {
  const [rows]=await pool.query(`
    SELECT COALESCE(NULLIF(owner,''),'Unassigned') owner,
      COUNT(*) problems,
      SUM(status NOT IN ('resolved','closed')) open_problems,
      SUM(priority IN ('high','critical') AND status NOT IN ('resolved','closed')) high_priority,
      COALESCE(SUM(feedback_count),0) feedback_count
    FROM problems GROUP BY COALESCE(NULLIF(owner,''),'Unassigned')
    ORDER BY high_priority DESC,open_problems DESC,feedback_count DESC LIMIT 100`);
  return rows;
}

module.exports={overview,teamDetail,ownerOverview};
