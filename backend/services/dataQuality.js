const crypto = require('crypto');

function normalizeMessage(message) {
  return String(message || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}
function fingerprint(message) { return crypto.createHash('sha256').update(normalizeMessage(message)).digest('hex'); }
function qualityScore({total, duplicate, issues, lowConfidence, aiFailures}) {
  if (!total) return 100;
  const penalties = duplicate * 4 + issues * 3 + lowConfidence * 2 + aiFailures * 5;
  return Math.max(0, Math.min(100, 100 - (penalties / total * 100)));
}
async function scan(pool, workspaceId) {
  const [[run]] = await pool.query('SELECT id FROM quality_runs WHERE workspace_id=? ORDER BY id DESC LIMIT 1',[workspaceId]);
  const [rows] = await pool.query(`SELECT id,message,source,customer_name,sentiment,category,severity,summary,embedding,problem_id,created_at FROM feedback WHERE workspace_id=? ORDER BY id DESC LIMIT 10000`,[workspaceId]);
  const seen = new Map();
  let duplicate=0, issues=0, lowConfidence=0, aiFailures=0;
  const flags=[];
  for (const f of rows) {
    const fp=fingerprint(f.message);
    const previous=seen.get(fp);
    if(previous){ duplicate++; flags.push({feedback_id:f.id,flag_type:'duplicate',severity:'warning',detail:`Same normalized message as feedback #${previous}`,fingerprint:fp}); }
    else seen.set(fp,f.id);
    if(String(f.message||'').trim().length < 12){ issues++; flags.push({feedback_id:f.id,flag_type:'too_short',severity:'warning',detail:'Feedback message is shorter than 12 characters.',fingerprint:fp}); }
    if(!f.source){ issues++; flags.push({feedback_id:f.id,flag_type:'missing_source',severity:'warning',detail:'Feedback source is missing.',fingerprint:fp}); }
    if(!f.sentiment || !f.category || !f.severity){ aiFailures++; flags.push({feedback_id:f.id,flag_type:'classification_missing',severity:'critical',detail:'Sentiment, category, or severity classification is missing.',fingerprint:fp}); }
    if(f.sentiment && !f.summary){ lowConfidence++; flags.push({feedback_id:f.id,flag_type:'missing_summary',severity:'info',detail:'Classification exists but summary is missing.',fingerprint:fp}); }
    if(f.embedding && String(f.embedding).length < 5){ lowConfidence++; flags.push({feedback_id:f.id,flag_type:'invalid_embedding',severity:'warning',detail:'Embedding payload appears invalid.',fingerprint:fp}); }
  }
  const dedup=new Map(); for(const f of flags) dedup.set(`${f.feedback_id}:${f.flag_type}`,f);
  const finalFlags=[...dedup.values()];
  for(const f of finalFlags){ await pool.query(`INSERT INTO feedback_quality_flags(workspace_id,feedback_id,flag_type,severity,detail,fingerprint,status) VALUES(?,?,?,?,?,?, 'open') ON DUPLICATE KEY UPDATE severity=VALUES(severity),detail=VALUES(detail),fingerprint=VALUES(fingerprint),status=IF(status='resolved','resolved','open')`,[workspaceId,f.feedback_id,f.flag_type,f.severity,f.detail,f.fingerprint]); }
  const total=rows.length, valid=Math.max(0,total-finalFlags.filter(f=>f.severity!=='info').length), score=qualityScore({total,duplicate,issues,lowConfidence,aiFailures});
  const [r]=await pool.query(`INSERT INTO quality_runs(workspace_id,status,total_feedback,valid_feedback,duplicate_count,quality_issue_count,low_confidence_count,ai_failure_count,score,detail,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,NOW())`,[workspaceId,'completed',total,valid,duplicate,issues,lowConfidence,aiFailures,score,JSON.stringify({flags:finalFlags.length})]);
  return {run_id:r.insertId,total_feedback:total,valid_feedback:valid,duplicates:duplicate,quality_issues:issues,low_confidence:lowConfidence,ai_failures:aiFailures,open_flags:finalFlags.length,score:Number(score.toFixed(2))};
}
module.exports={normalizeMessage,fingerprint,qualityScore,scan};
