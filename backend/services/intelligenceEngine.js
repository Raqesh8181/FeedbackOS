const { analyzeFeedback } = require('./feedbackAI');
const { createEmbedding } = require('./embedding');
const { cosineSimilarity } = require('./similarity');
const { analyzeProblem } = require('./problemAI');
const { SIMILARITY_THRESHOLD } = require('./problemDetection');
const { calculatePriority } = require('./priorityEngine');

const MIN_CLUSTER_SIZE = Math.max(2, Number(process.env.MIN_PROBLEM_FEEDBACK || 2));

function parseEmbedding(value) {
  try { return Array.isArray(value) ? value : JSON.parse(value); } catch { return null; }
}

function daysSince(date) {
  if (!date) return 999;
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
}

async function processFeedback(pool) {
  const [rows] = await pool.query(`SELECT id,message,sentiment,embedding FROM feedback WHERE sentiment IS NULL OR embedding IS NULL ORDER BY id`);
  let analyzed = 0, embedded = 0;
  for (const f of rows) {
    if (!f.sentiment) {
      const a = await analyzeFeedback(f.message);
      await pool.query(`UPDATE feedback SET sentiment=?,category=?,severity=?,summary=? WHERE id=?`, [a.sentiment,a.category,a.severity,a.summary,f.id]);
      analyzed++;
    }
    if (f.embedding == null) {
      const e = await createEmbedding(f.message);
      await pool.query('UPDATE feedback SET embedding=? WHERE id=?', [JSON.stringify(e),f.id]);
      embedded++;
    }
  }
  return { processed: rows.length, analyzed, embedded };
}

async function matchUnassignedFeedback(pool) {
  const [feedback] = await pool.query(`SELECT id,message,embedding,category,severity,created_at FROM feedback WHERE embedding IS NOT NULL AND sentiment='negative' AND problem_id IS NULL ORDER BY created_at DESC`);
  const [problems] = await pool.query(`SELECT id,category,severity FROM problems WHERE status <> 'resolved'`);
  let matched = 0;
  for (const f of feedback) {
    const e = parseEmbedding(f.embedding); if (!e) continue;
    let best = null;
    for (const p of problems) {
      if (p.category && f.category && p.category !== f.category) continue;
      const [members] = await pool.query(`SELECT f.embedding FROM problem_feedback pf JOIN feedback f ON f.id=pf.feedback_id WHERE pf.problem_id=? AND f.embedding IS NOT NULL`, [p.id]);
      for (const m of members) {
        const me = parseEmbedding(m.embedding); if (!me) continue;
        const score = cosineSimilarity(e, me);
        if (!best || score > best.score) best = { problemId:p.id, score };
      }
    }
    if (best && best.score >= SIMILARITY_THRESHOLD) {
      await pool.query('INSERT IGNORE INTO problem_feedback(problem_id,feedback_id,similarity_score) VALUES (?,?,?)', [best.problemId,f.id,best.score]);
      await pool.query('UPDATE feedback SET problem_id=? WHERE id=?', [best.problemId,f.id]);
      await pool.query(`UPDATE problems SET feedback_count=feedback_count+1,last_detected_at=? WHERE id=?`, [f.created_at,best.problemId]);
      matched++;
    }
  }
  return { matched };
}

async function detectNewProblems(pool) {
  const [rows] = await pool.query(`SELECT id,message,embedding,sentiment,category,severity,created_at FROM feedback WHERE embedding IS NOT NULL AND sentiment='negative' AND problem_id IS NULL ORDER BY created_at DESC`);
  const used = new Set(), clusters = [];
  for (const seed of rows) {
    if (used.has(seed.id)) continue;
    const se = parseEmbedding(seed.embedding); if (!se) continue;
    const members = [{...seed,similarity:1}];
    for (const candidate of rows) {
      if (candidate.id===seed.id || used.has(candidate.id)) continue;
      if (seed.category && candidate.category && seed.category !== candidate.category) continue;
      const ce=parseEmbedding(candidate.embedding); if(!ce) continue;
      const score=cosineSimilarity(se,ce);
      if(score>=SIMILARITY_THRESHOLD) members.push({...candidate,similarity:score});
    }
    if(members.length>=MIN_CLUSTER_SIZE){ clusters.push(members); members.forEach(x=>used.add(x.id)); }
  }
  let created=0;
  for(const members of clusters){
    const messages=members.map(x=>x.message);
    let analysis;
    if(process.env.OPENAI_API_KEY) analysis=await analyzeProblem(messages);
    else {
      const rank={low:1,medium:2,high:3,critical:4};
      const severity=members.reduce((best,m)=>(rank[m.severity]||1)>(rank[best]||1)?m.severity:best,'low');
      const category=members.find(x=>x.category)?.category||'general';
      analysis={title:`${category[0]?.toUpperCase()||''}${category.slice(1)} recurring issue`,description:'A recurring customer issue detected from similar negative feedback.',impact:'Repeated customer friction may increase support volume and reduce trust.',category,recommended_team:'Product',severity,priority:severity};
    }
    const confidence=Math.min(0.99,Math.max(0.5,members.slice(1).reduce((a,x)=>a+x.similarity,0)/(Math.max(1,members.length-1))));
    const times=members.map(x=>new Date(x.created_at).getTime());
    const [r]=await pool.query(`INSERT INTO problems(title,description,impact,category,recommended_team,priority,severity,status,feedback_count,confidence,health,first_detected_at,last_detected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [analysis.title,analysis.description,analysis.impact,analysis.category,analysis.recommended_team,analysis.priority,analysis.severity,'detected',members.length,confidence,'Insufficient data',new Date(Math.min(...times)),new Date(Math.max(...times))]);
    for(const m of members) await pool.query('INSERT IGNORE INTO problem_feedback(problem_id,feedback_id,similarity_score) VALUES (?,?,?)',[r.insertId,m.id,m.similarity]);
    await pool.query('UPDATE feedback SET problem_id=? WHERE id IN (?)',[r.insertId,members.map(x=>x.id)]);
    created++;
  }
  return { clusters:clusters.length, created };
}

async function updateHealth(pool) {
  const [problems]=await pool.query(`SELECT id FROM problems WHERE status <> 'resolved'`);
  for(const p of problems){
    const [[stats]]=await pool.query(`SELECT
      COALESCE(SUM(CASE WHEN date>=DATE_SUB(CURDATE(),INTERVAL 6 DAY) THEN negative_count ELSE 0 END),0) recent,
      COALESCE(SUM(CASE WHEN date BETWEEN DATE_SUB(CURDATE(),INTERVAL 13 DAY) AND DATE_SUB(CURDATE(),INTERVAL 7 DAY) THEN negative_count ELSE 0 END),0) previous,
      COUNT(*) days
      FROM daily_metrics WHERE problem_id=?`,[p.id]);
    let health='Insufficient data';
    if(Number(stats.days)>=3){
      const r=Number(stats.recent), q=Number(stats.previous);
      if(q===0) health=r>0?'Worsening':'Stable';
      else { const change=(r-q)/q; health=change>0.2?'Worsening':change<-0.2?'Improving':'Stable'; }
    }
    await pool.query('UPDATE problems SET health=? WHERE id=?',[health,p.id]);
  }
  return { updated:problems.length };
}

async function recalculatePriorities(pool) {
  const [problems]=await pool.query('SELECT id,severity,feedback_count,last_detected_at FROM problems WHERE status <> \'resolved\'');
  for(const p of problems){
    const result=calculatePriority({frequency:Number(p.feedback_count||0),severity:p.severity,recencyDays:daysSince(p.last_detected_at)});
    await pool.query('UPDATE problems SET priority=? WHERE id=?',[result.priority,p.id]);
  }
  return { updated:problems.length };
}

async function runIntelligence(pool, rebuildMetrics) {
  const processed=await processFeedback(pool);
  const matched=await matchUnassignedFeedback(pool);
  const detected=await detectNewProblems(pool);
  await rebuildMetrics();
  const priorities=await recalculatePriorities(pool);
  const health=await updateHealth(pool);
  return { processed, matched, detected, priorities, health };
}

module.exports={runIntelligence,processFeedback,matchUnassignedFeedback,detectNewProblems,updateHealth,recalculatePriorities};
