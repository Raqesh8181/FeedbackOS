const crypto = require('crypto');
const { analyzeFeedbackDetailed } = require('./feedbackAI');

const ALLOWED_SENTIMENTS = new Set(['positive','neutral','negative']);
const ALLOWED_SEVERITIES = new Set(['low','medium','high','critical']);
const PROMPT_VERSION = 'feedback-analysis-v1';

function validateAnalysis(a) {
  if (!a || typeof a !== 'object') throw new Error('AI returned no structured output');
  const sentiment = String(a.sentiment || '').toLowerCase();
  const severity = String(a.severity || '').toLowerCase();
  const category = String(a.category || '').trim();
  const summary = String(a.summary || '').trim();
  if (!ALLOWED_SENTIMENTS.has(sentiment)) throw new Error('AI returned invalid sentiment');
  if (!ALLOWED_SEVERITIES.has(severity)) throw new Error('AI returned invalid severity');
  if (!category || category.length > 100) throw new Error('AI returned invalid category');
  if (!summary || summary.length > 1000) throw new Error('AI returned invalid summary');
  return { sentiment, severity, category, summary };
}

function confidenceFor(a) {
  let score = 0.55;
  if (a.category) score += 0.1;
  if (a.summary) score += 0.1;
  if (a.sentiment && a.severity) score += 0.15;
  if (String(a.summary || '').length <= 240) score += 0.05;
  return Math.min(0.99, score);
}

function estimateCost(usage) {
  const inRate = Number(process.env.OPENAI_INPUT_COST_PER_1M || 0);
  const outRate = Number(process.env.OPENAI_OUTPUT_COST_PER_1M || 0);
  return ((Number(usage?.input_tokens || 0) / 1e6) * inRate) + ((Number(usage?.output_tokens || 0) / 1e6) * outRate);
}

async function governedAnalyze({ pool, workspaceId, userId = null, feedbackId = null, message, operation = 'feedback_analysis' }) {
  const started = Date.now();
  const inputHash = crypto.createHash('sha256').update(String(message)).digest('hex');
  let runId = null;
  try {
    const [r] = await pool.query(`INSERT INTO ai_runs(workspace_id,feedback_id,user_id,operation,model,prompt_version,input_hash,status,started_at) VALUES(?,?,?,?,?,?,?,?,NOW())`, [workspaceId, feedbackId, userId, operation, process.env.OPENAI_MODEL || 'gpt-5-mini', PROMPT_VERSION, inputHash, 'running']);
    runId = r.insertId;
    const result = await analyzeFeedbackDetailed(message);
    const analysis = validateAnalysis(result.analysis);
    const confidence = confidenceFor(analysis);
    const cost = estimateCost(result.usage);
    await pool.query(`UPDATE ai_runs SET status='completed',finished_at=NOW(),duration_ms=?,sentiment=?,category=?,severity=?,summary=?,confidence=?,input_tokens=?,output_tokens=?,total_tokens=?,estimated_cost_usd=? WHERE id=? AND workspace_id=?`, [Date.now()-started, analysis.sentiment, analysis.category, analysis.severity, analysis.summary, confidence, Number(result.usage?.input_tokens || 0), Number(result.usage?.output_tokens || 0), Number(result.usage?.total_tokens || 0), cost, runId, workspaceId]);
    return { analysis, confidence, usage: result.usage || {}, model: result.model, run_id: runId, prompt_version: PROMPT_VERSION };
  } catch (error) {
    if (runId) await pool.query(`UPDATE ai_runs SET status='failed',finished_at=NOW(),duration_ms=?,error_message=? WHERE id=? AND workspace_id=?`, [Date.now()-started, String(error.message).slice(0,1000), runId, workspaceId]).catch(()=>{});
    throw Object.assign(error, { ai_run_id: runId });
  }
}

module.exports = { governedAnalyze, validateAnalysis, confidenceFor, estimateCost, PROMPT_VERSION };
