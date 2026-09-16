const pool = require('../db');

const STAGES = ['discovery','signup','onboarding','activation','purchase','delivery','usage','support','refund','retention'];

function inferStage(text = '', category = '', source = '') {
  const s = `${text} ${category} ${source}`.toLowerCase();
  const rules = [
    ['refund', ['refund','money back','reimbursement','chargeback']],
    ['delivery', ['delivery','shipping','shipment','courier','eta','arrived','late package','tracking']],
    ['purchase', ['checkout','payment','pay','purchase','order','cart','transaction','billing']],
    ['support', ['support','agent','ticket','help desk','customer service','response time','contact']],
    ['onboarding', ['onboarding','getting started','setup','set up','welcome','configuration']],
    ['signup', ['sign up','signup','register','registration','login','log in','password','verification']],
    ['activation', ['activate','activation','trial','first use','first time']],
    ['usage', ['crash','bug','slow','error','feature','dashboard','app','screen','performance','cannot use','doesn’t work', "doesn't work"]],
    ['retention', ['cancel','cancellation','churn','renewal','renew','leave','leaving','unsubscribe']],
    ['discovery', ['pricing page','compare','comparison','discover','search','website','landing page','information']]
  ];
  for (const [stage, words] of rules) if (words.some(w => s.includes(w))) return stage;
  return 'usage';
}

function stageScore(text, category, source) {
  const s = `${text} ${category} ${source}`.toLowerCase();
  let score = 0.55;
  if (s.length > 80) score += 0.1;
  if (category) score += 0.1;
  if (['support','survey','review','app_store'].includes(String(source).toLowerCase())) score += 0.05;
  return Math.min(0.95, Number(score.toFixed(2)));
}

function health(negative, total) {
  const rate = total ? negative / total : 0;
  if (rate >= 0.5) return 'At risk';
  if (rate >= 0.25) return 'Watch';
  return 'Healthy';
}

async function classifyUnclassified(limit = 500) {
  const [rows] = await pool.query(`SELECT id,message,category,source FROM feedback WHERE journey_stage IS NULL OR journey_stage='' LIMIT ?`, [Math.min(2000, Math.max(1, Number(limit) || 500))]);
  let updated = 0;
  for (const f of rows) {
    const stage = inferStage(f.message, f.category, f.source);
    const confidence = stageScore(f.message, f.category, f.source);
    await pool.query(`UPDATE feedback SET journey_stage=?, journey_stage_confidence=? WHERE id=?`, [stage, confidence, f.id]);
    updated++;
  }
  return updated;
}

async function overview() {
  await classifyUnclassified();
  const [[summary]] = await pool.query(`SELECT COUNT(*) total_feedback, COUNT(DISTINCT NULLIF(TRIM(customer_name),'')) customers, COALESCE(SUM(sentiment='negative'),0) negative_feedback FROM feedback`);
  const [stages] = await pool.query(`SELECT journey_stage stage, COUNT(*) feedback_count, COALESCE(SUM(sentiment='negative'),0) negative_count, COUNT(DISTINCT NULLIF(TRIM(customer_name),'')) customers, AVG(journey_stage_confidence) confidence FROM feedback WHERE journey_stage IS NOT NULL AND journey_stage<>'' GROUP BY journey_stage ORDER BY FIELD(journey_stage,'discovery','signup','onboarding','activation','purchase','delivery','usage','support','refund','retention'), feedback_count DESC`);
  const [customers] = await pool.query(`SELECT TRIM(customer_name) customer, COUNT(*) feedback_count, COALESCE(SUM(sentiment='negative'),0) negative_count, COUNT(DISTINCT journey_stage) stages, MIN(created_at) first_seen, MAX(created_at) last_seen FROM feedback WHERE customer_name IS NOT NULL AND TRIM(customer_name)<>'' GROUP BY TRIM(customer_name) ORDER BY negative_count DESC, feedback_count DESC LIMIT 30`);
  const stageRows = stages.map(x => ({...x, feedback_count:Number(x.feedback_count), negative_count:Number(x.negative_count), customers:Number(x.customers), negative_rate:Number(x.feedback_count)?Number((x.negative_count/x.feedback_count*100).toFixed(1)):0, confidence:Number(Number(x.confidence||0).toFixed(2)), health:health(Number(x.negative_count),Number(x.feedback_count))}));
  const customerRows = customers.map(x => ({...x, feedback_count:Number(x.feedback_count), negative_count:Number(x.negative_count), stages:Number(x.stages), negative_rate:Number(x.feedback_count)?Number((x.negative_count/x.feedback_count*100).toFixed(1)):0, health:health(Number(x.negative_count),Number(x.feedback_count))}));
  const atRiskStages = stageRows.filter(x=>x.health==='At risk').length;
  return {summary:{total_feedback:Number(summary.total_feedback||0),customers:Number(summary.customers||0),negative_feedback:Number(summary.negative_feedback||0),at_risk_stages:atRiskStages},stages:stageRows,customers:customerRows};
}

async function customerJourney(name) {
  const customer = String(name||'').trim(); if (!customer) return null;
  await classifyUnclassified();
  const [feedback] = await pool.query(`SELECT id,message,sentiment,category,severity,problem_id,journey_stage,journey_stage_confidence,created_at FROM feedback WHERE TRIM(customer_name)=? ORDER BY created_at ASC`, [customer]);
  if (!feedback.length) return null;
  const stages = feedback.reduce((m,f)=>{ const k=f.journey_stage||'usage'; (m[k]??=[]).push(f); return m; },{});
  const timeline = feedback.map(f=>({date:f.created_at,stage:f.journey_stage||'usage',message:f.message,sentiment:f.sentiment,severity:f.severity,problem_id:f.problem_id}));
  const negatives = feedback.filter(f=>f.sentiment==='negative').length;
  const ordered = [...new Set(feedback.map(f=>f.journey_stage).filter(Boolean))];
  const stageCounts = ordered.map(stage=>({stage,count:stages[stage].length,negative:stages[stage].filter(f=>f.sentiment==='negative').length}));
  return {summary:{customer,feedback_count:feedback.length,negative_count:negatives,negative_rate:Number((negatives/feedback.length*100).toFixed(1)),stages:ordered.length,first_seen:feedback[0].created_at,last_seen:feedback[feedback.length-1].created_at,health:health(negatives,feedback.length)},stageCounts,timeline};
}

async function stageDetail(stage) {
  const value=String(stage||'').trim().toLowerCase(); if(!STAGES.includes(value)) return null;
  await classifyUnclassified();
  const [feedback] = await pool.query(`SELECT id,customer_name,message,sentiment,category,severity,problem_id,created_at FROM feedback WHERE journey_stage=? ORDER BY created_at DESC LIMIT 150`,[value]);
  return {stage:value,feedback_count:feedback.length,negative_count:feedback.filter(f=>f.sentiment==='negative').length,feedback};
}

module.exports = { STAGES, inferStage, classifyUnclassified, overview, customerJourney, stageDetail };
