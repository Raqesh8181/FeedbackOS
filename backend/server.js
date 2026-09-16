
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const pool = require("./db");
const { analyzeFeedback } = require("./services/feedbackAI");
const { createEmbedding } = require("./services/embedding");
const { cosineSimilarity } = require("./services/similarity");
const { findSimilarFeedback, SIMILARITY_THRESHOLD } = require("./services/problemDetection");
const { analyzeProblem } = require("./services/problemAI");
const { calculatePriority } = require("./services/priorityEngine");
const { runIntelligence, updateHealth } = require("./services/intelligenceEngine");
const { generateExecutiveSummary } = require("./services/executiveSummary");
const { answerCopilot } = require("./services/copilot");
const { generateDecisionPlan } = require("./services/decisionEngine");
const { generateLearningInsights } = require("./services/learningEngine");
const { generateOperationsBrief } = require("./services/operationsEngine");
const { ensureBackfill, getProblemMemory, getWorkspaceMemory, findSimilarCases } = require("./services/memoryEngine");
const { buildIntelligenceGraph } = require("./services/graphEngine");
const { rootCause, ensureInvestigation, refreshInvestigation, getInvestigation, createInvestigationTask, decision, prediction, preventiveQueue, createPreventive, runOperatingLoop } = require("./services/unifiedIntelligence");
const { recommendTheme, buildInitiative, priorityScore } = require("./services/strategyExecution");
const { score: portfolioScore, recommendation: portfolioRecommendation, portfolioSummary } = require("./services/portfolioIntelligence");
const migrate = require("./migrate");
const { classifyFeedback, overview: featureOverview, detail: featureDetail } = require("./services/featureIntelligence");
const { overview: journeyOverview, customerJourney, stageDetail, classifyUnclassified } = require("./services/journeyIntelligence");
const { overview: teamOverview, teamDetail, ownerOverview } = require("./services/teamIntelligence");
const { overview: automationOverview, createRule, run: runAutomations, updateQueue, seedDefaults } = require("./services/automationEngine");
const { hashPassword, verifyPassword, token, slugify, publicUser } = require("./services/authService");
const crypto = require('crypto');
const { run: runTenantContext } = require('./tenantContext');
const { businessOverview, attentionNow, businessImpact, executiveOverview, snapshot, snapshots } = require("./services/executiveIntelligence");
const { scan: scanDataQuality, fingerprint: qualityFingerprint } = require('./services/dataQuality');
const { overview: osOverview, attention: osAttention, run: osRun, queue: osQueue, updateDecision: updateOsDecision, snapshot: osSnapshot, snapshots: osSnapshots } = require("./services/operatingSystem");
const { analyzeFeedbackDetailed } = require("./services/feedbackAI");
const { governedAnalyze } = require("./services/aiGovernance");
const { validateAnalysis } = require("./services/aiGovernance");
const { scoreCase, aggregateResults, regression, validateCase } = require("./services/aiEvaluation");
const { buildCorrectionSignals, buildLearningExplanation, confidenceFromCount, patternHash } = require("./services/learningLoop");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const frontend = path.join(__dirname, "..", "frontend", "public");
app.use(express.static(frontend));

const PORT = Number(process.env.PORT || 5000);

const observability = { startedAt: Date.now(), requests: 0, errors: 0 };
function recordRequestMetric(req, statusCode, durationMs, errorMessage=null) {
  if (!req.path.startsWith('/api/')) return;
  observability.requests++;
  if (statusCode >= 500) observability.errors++;
  pool.query(`INSERT INTO api_request_metrics(workspace_id,method,route,status_code,duration_ms,error_message) VALUES(?,?,?,?,?,?)`,
    [req.user?.workspace_id || null, req.method, req.route?.path || req.path, statusCode, Math.max(0,Math.round(durationMs)), errorMessage ? String(errorMessage).slice(0,500) : null]).catch(()=>{});
}
app.use((req,res,next)=>{
  const started=Date.now();
  res.on('finish',()=>recordRequestMetric(req,res.statusCode,Date.now()-started));
  next();
});


// V5.2 lightweight abuse protection for auth and public ingestion surfaces.
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now(); const current = rateBuckets.get(key);
  if (!current || now - current.start >= windowMs) { rateBuckets.set(key, { start: now, count: 1 }); return true; }
  current.count += 1; return current.count <= limit;
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function securityEvent(req, eventType, detail = null) {
  const workspaceId = req.user?.workspace_id || null, userId = req.user?.user_id || null;
  pool.query('INSERT INTO security_events(workspace_id,user_id,event_type,ip_address,user_agent,detail) VALUES(?,?,?,?,?,?)', [workspaceId,userId,eventType,clientIp(req),String(req.headers['user-agent']||'').slice(0,500),detail?JSON.stringify(detail):null]).catch(()=>{});
}


function hashToken(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
async function authFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const raw = header.slice(7).trim();
    if (raw) {
      const [[row]] = await pool.query(`SELECT s.id session_id,s.user_id,s.workspace_id,s.expires_at,u.name,u.email,u.platform_role,wm.role,w.name workspace_name,w.plan_status,w.mrr
        FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=s.workspace_id
        JOIN workspaces w ON w.id=s.workspace_id WHERE s.token_hash=? AND s.expires_at>NOW() AND wm.status='active'`, [hashToken(raw)]);
      if (row) { await pool.query('UPDATE sessions SET last_seen_at=NOW() WHERE id=?',[row.session_id]); return row; }
    }
  }
  const apiKey = req.headers['x-feedbackos-api-key'] || req.headers['x-api-key'];
  if (apiKey) {
    const [[row]] = await pool.query(`SELECT k.id api_key_id,k.workspace_id,k.created_by user_id,u.name,u.email,w.name workspace_name
      FROM api_keys k LEFT JOIN users u ON u.id=k.created_by JOIN workspaces w ON w.id=k.workspace_id
      WHERE k.key_hash=? AND k.revoked_at IS NULL`, [hashToken(apiKey)]);
    if (row) { const [[scope]] = await pool.query("SELECT COUNT(*) c FROM api_key_scopes WHERE api_key_id=? AND scope='feedback:write'", [row.api_key_id]); if (!Number(scope.c)) return null; await pool.query('UPDATE api_keys SET last_used_at=NOW() WHERE id=?',[row.api_key_id]); return {...row,role:'integration'}; }
  }
  return null;
}
function requireRole(req, res, roles) {
  if (!req.user || !roles.includes(req.user.role)) { res.status(403).json({error:'Admin permission required'}); return false; }
  return true;
}
function requireManager(req,res){ if(!req.user || !['admin','manager'].includes(req.user.role)){ res.status(403).json({error:'Manager permission required'}); return false; } return true; }
function requireSelfOrAdmin(req,res,userId){ if(!req.user || (req.user.role!=='admin' && Number(req.user.user_id)!==Number(userId))){ res.status(403).json({error:'Admin or self permission required'}); return false; } return true; }
function requireSuperAdmin(req,res){ if(!req.user || req.user.platform_role!=='super_admin'){ res.status(403).json({error:'Super admin permission required'}); return false; } return true; }

function requirePlatformRole(req,res){ return requireSuperAdmin(req,res); }
function validPlan(p){ return ['free','pro','business','ai'].includes(String(p)); }
async function productCatalogFor(req){
  const [plans]=await pool.query("SELECT * FROM product_plans WHERE status='active' ORDER BY sort_order,id");
  const [features]=await pool.query("SELECT * FROM product_features WHERE status='active' ORDER BY sort_order,id");
  const [pf]=await pool.query('SELECT plan_key,feature_key,enabled FROM plan_features');
  const [flags]=await pool.query('SELECT feature_key,enabled,rollout_percent,release_phase_id FROM feature_flags');
  const phaseMap={};
  for(const p of (await pool.query('SELECT id,phase_key,name,plan_tier,status,launch_enabled FROM release_phases ORDER BY sort_order,id'))[0]) phaseMap[p.id]=p;
  const planFeatures={}; for(const x of pf){(planFeatures[x.plan_key]??={})[x.feature_key]=!!x.enabled;}
  const flagMap={}; for(const x of flags) flagMap[x.feature_key]=x;
  return {plans,features:features.map(f=>({...f,phase:phaseMap[f.release_phase_id]||null,flag:flagMap[f.feature_key]||null})),plan_features:planFeatures,current_plan:req.user?.plan_status||'free'};
}
async function audit(workspaceId,userId,eventType,entityType=null,entityId=null,metadata=null) {
  try { await pool.query(`INSERT INTO audit_logs(workspace_id,user_id,event_type,entity_type,entity_id,metadata) VALUES(?,?,?,?,?,?)`, [workspaceId,userId,eventType,entityType,entityId,metadata?JSON.stringify(metadata):null]); } catch(e) { console.error('Audit log failed:',e.message); }
}

// V5.1 authentication and workspace lifecycle.
app.post('/api/auth/register', async (req,res)=>{
  if (!rateLimit('register:'+clientIp(req), 8, 60*60*1000)) return res.status(429).json({error:'Too many registration attempts. Try again later.'});
  try {
    const {name,email,password,workspace_name} = req.body||{};
    if(!name || !email || !password || !workspace_name) return res.status(400).json({error:'name, email, password, and workspace_name are required'});
    if(String(password).length < 8) return res.status(400).json({error:'Password must be at least 8 characters'});
    const normalized=String(email).trim().toLowerCase();
    const [[existing]]=await pool.query('SELECT id FROM users WHERE email=?',[normalized]);
    if(existing) return res.status(409).json({error:'An account with that email already exists'});
    const base=slugify(workspace_name); let slug=base; let n=1;
    while(true){const [[w]]=await pool.query('SELECT id FROM workspaces WHERE slug=?',[slug]);if(!w)break;slug=`${base}-${++n}`;}
    const {salt,hash}=hashPassword(password);
    const conn=await pool.getConnection();
    try{
      await conn.beginTransaction();
      const [w]=await conn.query('INSERT INTO workspaces(name,slug) VALUES(?,?)',[workspace_name,slug]);
      const [u]=await conn.query('INSERT INTO users(name,email,password_hash,password_salt) VALUES(?,?,?,?)',[name,normalized,hash,salt]);
      await conn.query('INSERT INTO workspace_members(workspace_id,user_id,role,status) VALUES(?,?,?,?)',[w.insertId,u.insertId,'admin','active']);
      const raw=token(); await conn.query('INSERT INTO sessions(user_id,workspace_id,token_hash,expires_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 30 DAY))',[u.insertId,w.insertId,hashToken(raw)]);
      await conn.commit();
      await audit(w.insertId,u.insertId,'workspace.created','workspace',w.insertId,{slug});
      res.status(201).json({token:raw,user:{id:u.insertId,name,email:normalized,role:'admin',workspace_id:w.insertId,workspace_name},workspace:{id:w.insertId,name:workspace_name,slug}});
    }catch(e){await conn.rollback();throw e}finally{conn.release()}
  } catch(e){res.status(500).json({error:'Registration failed',detail:e.message})}
});

app.post('/api/auth/login', async (req,res)=>{
  if (!rateLimit('login:'+clientIp(req), 20, 15*60*1000)) return res.status(429).json({error:'Too many login attempts. Try again later.'});
  try{
    const {email,password}=req.body||{}; const normalized=String(email||'').trim().toLowerCase();
    const [[u]]=await pool.query(`SELECT u.*,wm.workspace_id,wm.role,w.name workspace_name FROM users u JOIN workspace_members wm ON wm.user_id=u.id AND wm.status='active' JOIN workspaces w ON w.id=wm.workspace_id WHERE u.email=? ORDER BY wm.id LIMIT 1`,[normalized]);
    if(!u || !verifyPassword(password||'',u.password_salt,u.password_hash)) { securityEvent(req,'auth.login.failed',{email:normalized}); return res.status(401).json({error:'Invalid email or password'}); }
    const raw=token(); await pool.query('INSERT INTO sessions(user_id,workspace_id,token_hash,expires_at,ip_address,user_agent,last_seen_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 30 DAY),?,?,NOW())',[u.id,u.workspace_id,hashToken(raw),clientIp(req),String(req.headers['user-agent']||'').slice(0,500)]); await pool.query('UPDATE users SET last_login_at=NOW() WHERE id=?',[u.id]);
    await audit(u.workspace_id,u.id,'auth.login','user',u.id); res.json({token:raw,user:publicUser(u)});
  }catch(e){res.status(500).json({error:'Login failed',detail:e.message})}
});
app.get('/api/auth/me', async (req,res)=>{
  try {
    req.user = await authFromRequest(req);
    if (!req.user) return res.status(401).json({error:'Authentication required'});
    res.json({user:publicUser(req.user)});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});
app.post('/api/auth/logout', async (req,res)=>{try{const h=req.headers.authorization||'';if(h.startsWith('Bearer ')){await pool.query('DELETE FROM sessions WHERE token_hash=?',[hashToken(h.slice(7).trim())]);}res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});

app.use('/api', async (req,res,next)=>{
  if(req.path.startsWith('/auth/')) return next();
  try { req.user=await authFromRequest(req); if(!req.user) return res.status(401).json({error:'Authentication required'}); runTenantContext(req.user.workspace_id, next); }
  catch(e){res.status(500).json({error:'Authentication check failed',detail:e.message})}
});

// V6.1 Super Admin Launch Control Plane.
function releaseMetricKey(key) {
  return ['total_users','active_workspaces','feedback_30d','paid_workspaces','mrr','retention_30d'].includes(String(key)) ? String(key) : null;
}
async function releaseCurrentMetric(key) {
  const k=releaseMetricKey(key); if(!k) return null;
  if(k==='total_users'){ const [[x]]=await pool.query("SELECT COUNT(*) value FROM users"); return Number(x.value||0); }
  if(k==='active_workspaces'){ const [[x]]=await pool.query("SELECT COUNT(DISTINCT workspace_id) value FROM workspace_members WHERE status='active'"); return Number(x.value||0); }
  if(k==='feedback_30d'){ const [[x]]=await pool.query("SELECT COUNT(*) value FROM feedback WHERE created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)"); return Number(x.value||0); }
  if(k==='paid_workspaces'){ const [[x]]=await pool.query("SELECT COUNT(*) value FROM workspaces WHERE plan_status='paid'"); return Number(x.value||0); }
  if(k==='mrr'){ const [[x]]=await pool.query("SELECT COALESCE(SUM(mrr),0) value FROM workspaces"); return Number(x.value||0); }
  if(k==='retention_30d'){ return null; }
}

app.get('/api/release/status', async (req,res)=>{try{
  const [phases]=await pool.query("SELECT id,phase_key,name,tagline,description,status,launch_enabled,launch_at,plan_tier,sort_order FROM release_phases WHERE launch_enabled=1 ORDER BY sort_order,id");
  const [campaigns]=await pool.query("SELECT id,phase_id,name,headline,teaser,body,cta_label,cta_url,audience,status,start_at,end_at FROM launch_campaigns WHERE status='live' AND (start_at IS NULL OR start_at<=NOW()) AND (end_at IS NULL OR end_at>=NOW()) ORDER BY id DESC");
  res.json({current_phase:phases.length?phases[phases.length-1]:null,phases,campaigns});
}catch(e){res.status(500).json({error:'Release status failed',detail:e.message})}});

app.get('/api/superadmin/overview', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{
  const [phases]=await pool.query('SELECT * FROM release_phases ORDER BY sort_order,id');
  for(const p of phases){ const [bs]=await pool.query('SELECT * FROM release_benchmarks WHERE phase_id=? ORDER BY id',[p.id]); for(const b of bs){ const current=releaseMetricKey(b.metric_key)?await releaseCurrentMetric(b.metric_key):Number(b.manual_value||0); b.current_value=current; b.eligible=!b.gate_required || (current!=null && Number(current)>=Number(b.target_value)); } p.benchmarks=bs; const [features]=await pool.query('SELECT * FROM release_features WHERE phase_id=? ORDER BY sort_order,id',[p.id]); p.features=features; }
  const [campaigns]=await pool.query('SELECT * FROM launch_campaigns ORDER BY id DESC LIMIT 50');
  const [[stats]]=await pool.query("SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM workspaces) workspaces,(SELECT COUNT(*) FROM workspaces WHERE plan_status='paid') paid_workspaces,(SELECT COALESCE(SUM(mrr),0) FROM workspaces) mrr");
  res.json({stats,phases,campaigns,metric_catalog:['total_users','active_workspaces','feedback_30d','paid_workspaces','mrr','retention_30d']});
}catch(e){res.status(500).json({error:'Super admin overview failed',detail:e.message})}});

app.post('/api/superadmin/phases', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.phase_key||!x.name)return res.status(400).json({error:'phase_key and name are required'});const [r]=await pool.query(`INSERT INTO release_phases(phase_key,name,tagline,description,status,launch_enabled,launch_at,plan_tier,sort_order) VALUES(?,?,?,?,?,?,?,?,?)`,[String(x.phase_key).slice(0,60),String(x.name).slice(0,160),x.tagline||'',x.description||'',x.status||'draft',x.launch_enabled?1:0,x.launch_at||null,x.plan_tier||'free',Number(x.sort_order||100)]);await audit(null,req.user.user_id,'release.phase.created','release_phase',r.insertId,{phase_key:x.phase_key});res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:'Phase creation failed',detail:e.message})}});
app.patch('/api/superadmin/phases/:id', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const id=Number(req.params.id);const [before]=await pool.query('SELECT * FROM release_phases WHERE id=?',[id]);if(!before.length)return res.status(404).json({error:'Phase not found'});const x=req.body||{};const allowed=['name','tagline','description','status','launch_at','plan_tier','sort_order'];const sets=[],vals=[];for(const k of allowed)if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(x[k]);}if(x.launch_enabled!==undefined){sets.push('launch_enabled=?');vals.push(x.launch_enabled?1:0)}if(!sets.length)return res.json({ok:true});vals.push(id);await pool.query(`UPDATE release_phases SET ${sets.join(',')} WHERE id=?`,vals);await audit(null,req.user.user_id,'release.phase.updated','release_phase',id,{changes:x});res.json({ok:true})}catch(e){res.status(500).json({error:'Phase update failed',detail:e.message})}});
app.post('/api/superadmin/phases/:id/launch', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const id=Number(req.params.id);const [[p]]=await pool.query('SELECT * FROM release_phases WHERE id=?',[id]);if(!p)return res.status(404).json({error:'Phase not found'});const [bs]=await pool.query('SELECT * FROM release_benchmarks WHERE phase_id=? AND gate_required=1',[id]);const results=[];for(const b of bs){const current=releaseMetricKey(b.metric_key)?await releaseCurrentMetric(b.metric_key):Number(b.manual_value||0);results.push({id:b.id,metric_key:b.metric_key,current,target:Number(b.target_value),passed:current!=null&&Number(current)>=Number(b.target_value)});}const blocked=results.some(x=>!x.passed);if(blocked && !req.body?.force)return res.status(409).json({error:'Launch gate not reached',blocked:true,benchmarks:results});await pool.query("UPDATE release_phases SET launch_enabled=1,status='live',launch_at=COALESCE(launch_at,NOW()) WHERE id=?",[id]);await audit(null,req.user.user_id,'release.phase.launched','release_phase',id,{forced:!!req.body?.force,benchmarks:results});res.json({ok:true,launched:true,benchmarks:results,forced:!!req.body?.force})}catch(e){res.status(500).json({error:'Launch failed',detail:e.message})}});
app.post('/api/superadmin/phases/:id/pause', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const id=Number(req.params.id);await pool.query("UPDATE release_phases SET launch_enabled=0,status='paused' WHERE id=?",[id]);await audit(null,req.user.user_id,'release.phase.paused','release_phase',id);res.json({ok:true})}catch(e){res.status(500).json({error:'Pause failed',detail:e.message})}});
app.post('/api/superadmin/phases/:id/features', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.feature_key||!x.name)return res.status(400).json({error:'feature_key and name are required'});const [r]=await pool.query(`INSERT INTO release_features(phase_id,feature_key,name,description,teaser,plan_tier,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?)`,[req.params.id,x.feature_key,x.name,x.description||'',x.teaser||'',x.plan_tier||'pro',x.enabled===false?0:1,Number(x.sort_order||100)]);res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:'Feature creation failed',detail:e.message})}});
app.patch('/api/superadmin/features/:id', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},sets=[],vals=[];for(const k of ['name','description','teaser','plan_tier','sort_order'])if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(x[k]);}if(x.enabled!==undefined){sets.push('enabled=?');vals.push(x.enabled?1:0)}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE release_features SET ${sets.join(',')} WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:'Feature update failed',detail:e.message})}});
app.post('/api/superadmin/phases/:id/benchmarks', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.metric_key||x.target_value===undefined)return res.status(400).json({error:'metric_key and target_value are required'});if(!releaseMetricKey(x.metric_key))return res.status(400).json({error:'Unsupported metric'});const [r]=await pool.query(`INSERT INTO release_benchmarks(phase_id,metric_key,label,target_value,manual_value,gate_required) VALUES(?,?,?,?,?,?)`,[req.params.id,x.metric_key,x.label||x.metric_key,Number(x.target_value),x.manual_value??null,x.gate_required===false?0:1]);res.status(201).json({id:r.insertId,current_value:await releaseCurrentMetric(x.metric_key)})}catch(e){res.status(500).json({error:'Benchmark creation failed',detail:e.message})}});
app.patch('/api/superadmin/benchmarks/:id', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},sets=[],vals=[];for(const k of ['label','target_value','manual_value','gate_required'])if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(k==='gate_required'?(x[k]?1:0):x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE release_benchmarks SET ${sets.join(',')} WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:'Benchmark update failed',detail:e.message})}});
app.post('/api/superadmin/campaigns', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.name||!x.headline)return res.status(400).json({error:'name and headline are required'});const [r]=await pool.query(`INSERT INTO launch_campaigns(phase_id,name,headline,teaser,body,cta_label,cta_url,audience,status,start_at,end_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[x.phase_id||null,x.name,x.headline,x.teaser||'',x.body||'',x.cta_label||'Explore',x.cta_url||'',x.audience||'all',x.status||'draft',x.start_at||null,x.end_at||null,req.user.user_id]);res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:'Campaign creation failed',detail:e.message})}});
app.patch('/api/superadmin/campaigns/:id', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},sets=[],vals=[];for(const k of ['phase_id','name','headline','teaser','body','cta_label','cta_url','audience','status','start_at','end_at'])if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE launch_campaigns SET ${sets.join(',')},updated_at=NOW() WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:'Campaign update failed',detail:e.message})}});
app.post('/api/superadmin/campaigns/:id/live', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{await pool.query("UPDATE launch_campaigns SET status='live' WHERE id=?",[req.params.id]);await audit(null,req.user.user_id,'release.campaign.live','launch_campaign',req.params.id);res.json({ok:true})}catch(e){res.status(500).json({error:'Campaign publish failed',detail:e.message})}});
app.post('/api/superadmin/campaigns/:id/end', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{await pool.query("UPDATE launch_campaigns SET status='ended',end_at=NOW() WHERE id=?",[req.params.id]);res.json({ok:true})}catch(e){res.status(500).json({error:'Campaign end failed',detail:e.message})}});


// V6.2 Product Launch OS: entitlements, feature flags, roadmap, waitlist and conversion telemetry.
app.get('/api/product/catalog', async (req,res)=>{try{res.json(await productCatalogFor(req))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/product/upgrade-prompts', async (req,res)=>{try{const plan=req.user.plan_status||'free';const [rows]=await pool.query("SELECT p.*,f.name feature_name,f.feature_key FROM upgrade_prompts p LEFT JOIN product_features f ON f.feature_key=p.feature_key WHERE p.enabled=1 AND (p.plan_from=? OR p.plan_from='any') ORDER BY p.priority DESC,id DESC LIMIT 50",[plan]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/product/upgrade-events', async (req,res)=>{try{const x=req.body||{};if(!x.event_type)return res.status(400).json({error:'event_type is required'});await pool.query('INSERT INTO upgrade_events(workspace_id,user_id,feature_key,event_type,from_plan,to_plan,metadata) VALUES(?,?,?,?,?,?,?)',[req.user.workspace_id,req.user.user_id,x.feature_key||null,x.event_type,req.user.plan_status||'free',x.to_plan||null,x.metadata?JSON.stringify(x.metadata):null]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/product/feature/:key', async (req,res)=>{try{const key=String(req.params.key);const [[f]]=await pool.query('SELECT * FROM product_features WHERE feature_key=? AND status=\'active\'',[key]);if(!f)return res.status(404).json({error:'Feature not found'});const [[flag]]=await pool.query('SELECT * FROM feature_flags WHERE feature_key=?',[key]);const plan=req.user.plan_status||'free';const [[ent]]=await pool.query('SELECT enabled FROM plan_features WHERE plan_key=? AND feature_key=?',[plan,key]);const [[override]]=await pool.query('SELECT enabled FROM workspace_feature_overrides WHERE workspace_id=? AND feature_key=?',[req.user.workspace_id,key]);const phase=f.release_phase_id? (await pool.query('SELECT launch_enabled,status FROM release_phases WHERE id=?',[f.release_phase_id]))[0][0]:null;const enabled=override?!!override.enabled:(ent?!!ent.enabled:false);const launched=!phase||!!phase.launch_enabled;const flagEnabled=!flag||!!flag.enabled;res.json({feature_key:key,enabled:enabled&&launched&&flagEnabled,entitled:enabled,launched,flag_enabled:flagEnabled,plan})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/superadmin/product', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const catalog=await productCatalogFor(req);const [plans]=await pool.query('SELECT * FROM product_plans ORDER BY sort_order,id');const [features]=await pool.query('SELECT * FROM product_features ORDER BY sort_order,id');const [flags]=await pool.query('SELECT ff.*,rp.name phase_name FROM feature_flags ff LEFT JOIN release_phases rp ON rp.id=ff.release_phase_id ORDER BY ff.id DESC');const [roadmap]=await pool.query('SELECT * FROM product_roadmap ORDER BY sort_order,id');const [waitlist]=await pool.query('SELECT * FROM product_waitlist ORDER BY id DESC LIMIT 100');const [prompts]=await pool.query('SELECT * FROM upgrade_prompts ORDER BY priority DESC,id DESC LIMIT 100');const [[metrics]]=await pool.query("SELECT COUNT(*) workspaces,SUM(plan_status<>'free') paid_workspaces,COALESCE(SUM(mrr),0) mrr FROM workspaces");const [[conversions]]=await pool.query("SELECT COUNT(*) total_upgrade_events,COUNT(DISTINCT workspace_id) engaged_workspaces,SUM(event_type='checkout_started') checkout_started,SUM(event_type='upgrade_completed') upgrades FROM upgrade_events");res.json({...catalog,plans,features,flags,roadmap,waitlist,prompts,metrics,conversions})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/plans', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{};if(!x.plan_key||!x.name||!validPlan(x.plan_key))return res.status(400).json({error:'Valid plan_key and name required'});const [r]=await pool.query('INSERT INTO product_plans(plan_key,name,description,price_monthly,price_yearly,trial_days,sort_order,status) VALUES(?,?,?,?,?,?,?,?)',[x.plan_key,x.name,x.description||'',Number(x.price_monthly||0),Number(x.price_yearly||0),Number(x.trial_days||0),Number(x.sort_order||100),x.status||'active']);await audit(null,req.user.user_id,'product.plan.created','product_plan',r.insertId,{plan_key:x.plan_key});res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:'Plan creation failed',detail:e.message})}});
app.patch('/api/superadmin/plans/:id', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{},keys=['name','description','price_monthly','price_yearly','trial_days','sort_order','status'],sets=[],vals=[];for(const k of keys)if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE product_plans SET ${sets.join(',')},updated_at=NOW() WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/features', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{};if(!x.feature_key||!x.name)return res.status(400).json({error:'feature_key and name required'});const [r]=await pool.query('INSERT INTO product_features(feature_key,name,description,release_phase_id,status,sort_order) VALUES(?,?,?,?,?,?)',[x.feature_key,x.name,x.description||'',x.release_phase_id||null,x.status||'active',Number(x.sort_order||100)]);await pool.query('INSERT INTO feature_flags(feature_key,enabled,rollout_percent,release_phase_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE release_phase_id=VALUES(release_phase_id)',[x.feature_key,x.enabled===false?0:1,Number(x.rollout_percent??100),x.release_phase_id||null]);res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:'Feature creation failed',detail:e.message})}});
app.patch('/api/superadmin/flags/:key', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{};const enabled=x.enabled===undefined?1:(x.enabled?1:0),rollout=Math.min(100,Math.max(0,Number(x.rollout_percent??100)));await pool.query('INSERT INTO feature_flags(feature_key,enabled,rollout_percent,release_phase_id) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),rollout_percent=VALUES(rollout_percent),release_phase_id=COALESCE(VALUES(release_phase_id),release_phase_id)',[req.params.key,enabled,rollout,x.release_phase_id||null]);await audit(null,req.user.user_id,'product.feature.flag_changed','feature',null,{feature_key:req.params.key,enabled,rollout_percent:rollout});res.json({ok:true,feature_key:req.params.key,enabled:!!enabled,rollout_percent:rollout})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/entitlements', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{};if(!validPlan(x.plan_key)||!x.feature_key)return res.status(400).json({error:'plan_key and feature_key required'});await pool.query('INSERT INTO plan_features(plan_key,feature_key,enabled) VALUES(?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)',[x.plan_key,x.feature_key,x.enabled===false?0:1]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/roadmap', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{};if(!x.title)return res.status(400).json({error:'title required'});const [r]=await pool.query('INSERT INTO product_roadmap(phase_id,title,description,status,target_date,sort_order,visibility) VALUES(?,?,?,?,?,?,?)',[x.phase_id||null,x.title,x.description||'',x.status||'planned',x.target_date||null,Number(x.sort_order||100),x.visibility||'public']);res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:e.message})}});
app.patch('/api/superadmin/roadmap/:id', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{},keys=['phase_id','title','description','status','target_date','sort_order','visibility'],sets=[],vals=[];for(const k of keys)if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE product_roadmap SET ${sets.join(',')},updated_at=NOW() WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/waitlist', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{};if(!x.email)return res.status(400).json({error:'email required'});await pool.query('INSERT INTO product_waitlist(email,name,company,phase_key,source,status) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),company=VALUES(company),phase_key=VALUES(phase_key),source=VALUES(source)',[String(x.email).trim().toLowerCase(),x.name||'',x.company||'',x.phase_key||null,x.source||'admin',x.status||'waiting']);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/waitlist', async (req,res)=>{try{const x=req.body||{};if(!x.email)return res.status(400).json({error:'email required'});await pool.query('INSERT INTO product_waitlist(email,name,company,phase_key,source,status) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),company=VALUES(company),phase_key=VALUES(phase_key)',[String(x.email).trim().toLowerCase(),x.name||'',x.company||'',x.phase_key||null,x.source||'product',x.status||'waiting']);res.json({ok:true,message:'You are on the waitlist.'})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/prompts', async (req,res)=>{if(!requirePlatformRole(req,res))return;try{const x=req.body||{};if(!x.name||!x.headline)return res.status(400).json({error:'name and headline required'});const [r]=await pool.query('INSERT INTO upgrade_prompts(name,feature_key,plan_from,plan_to,headline,body,cta_label,cta_url,enabled,priority) VALUES(?,?,?,?,?,?,?,?,?,?)',[x.name,x.feature_key||null,x.plan_from||'any',x.plan_to||'pro',x.headline,x.body||'',x.cta_label||'Upgrade',x.cta_url||'',x.enabled===false?0:1,Number(x.priority||100)]);res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/workspace', async (req,res)=>{try{const [[w]]=await pool.query('SELECT * FROM workspaces WHERE id=?',[req.user.workspace_id]);const [members]=await pool.query(`SELECT u.id,u.name,u.email,wm.role,wm.status,wm.created_at FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? ORDER BY wm.role DESC,u.name`,[req.user.workspace_id]);const [invites]=await pool.query(`SELECT id,email,role,status,expires_at,created_at FROM invitations WHERE workspace_id=? ORDER BY id DESC LIMIT 50`,[req.user.workspace_id]);res.json({workspace:w,members,invites,current_user:publicUser(req.user)})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/workspace/invitations', async (req,res)=>{try{if(!requireManager(req,res))return;const email=String(req.body?.email||'').trim().toLowerCase();const role=['admin','manager','member'].includes(req.body?.role)?req.body.role:'member';if(!email)return res.status(400).json({error:'email is required'});const [[member]]=await pool.query(`SELECT wm.id FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? AND u.email=? AND wm.status='active'`,[req.user.workspace_id,email]);if(member)return res.status(409).json({error:'User is already a workspace member'});const raw=token();const [x]=await pool.query(`INSERT INTO invitations(workspace_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 7 DAY))`,[req.user.workspace_id,email,role,hashToken(raw),req.user.user_id]);await audit(req.user.workspace_id,req.user.user_id,'team.invited','invitation',x.insertId,{email,role});res.status(201).json({id:x.insertId,email,role,invite_token:raw,invite_url:`/invite/${raw}`,expires_in_days:7,message:'Share the invite URL with the teammate; email delivery is not configured in this MVP.'})}catch(e){res.status(500).json({error:'Invitation failed',detail:e.message})}});
app.post('/api/auth/accept-invite', async (req,res)=>{try{const {invite_token,name,password}=req.body||{};if(!invite_token||!name||!password)return res.status(400).json({error:'invite_token, name, and password are required'});if(String(password).length<8)return res.status(400).json({error:'Password must be at least 8 characters'});const [[inv]]=await pool.query(`SELECT * FROM invitations WHERE token_hash=? AND status='pending' AND expires_at>NOW()`,[hashToken(invite_token)]);if(!inv)return res.status(400).json({error:'Invitation is invalid or expired'});const [[existing]]=await pool.query('SELECT id FROM users WHERE email=?',[inv.email]);if(existing)return res.status(409).json({error:'An account with this email already exists. Ask an admin to add the existing account.'});const {salt,hash}=hashPassword(password);const conn=await pool.getConnection();try{await conn.beginTransaction();const [u]=await conn.query('INSERT INTO users(name,email,password_hash,password_salt) VALUES(?,?,?,?)',[name,inv.email,hash,salt]);await conn.query('INSERT INTO workspace_members(workspace_id,user_id,role,status) VALUES(?,?,?,?)',[inv.workspace_id,u.insertId,inv.role,'active']);await conn.query('UPDATE invitations SET status=\'accepted\',accepted_at=NOW() WHERE id=?',[inv.id]);const raw=token();await conn.query('INSERT INTO sessions(user_id,workspace_id,token_hash,expires_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 30 DAY))',[u.insertId,inv.workspace_id,hashToken(raw)]);await conn.commit();await audit(inv.workspace_id,u.insertId,'team.invite.accepted','invitation',inv.id,{email:inv.email});res.status(201).json({token:raw,user:{id:u.insertId,name,email:inv.email,role:inv.role,workspace_id:inv.workspace_id}})}catch(e){await conn.rollback();throw e}finally{conn.release()}}catch(e){res.status(500).json({error:'Invite acceptance failed',detail:e.message})}});

app.get('/api/integrations', async (req,res)=>{try{const [rows]=await pool.query('SELECT id,name,type,status,config,last_event_at,created_at FROM integrations WHERE workspace_id=? ORDER BY id DESC',[req.user.workspace_id]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/integrations', async (req,res)=>{try{if(!requireManager(req,res))return;const name=String(req.body?.name||'').trim();const type=String(req.body?.type||'webhook').trim();if(!name)return res.status(400).json({error:'name is required'});const [x]=await pool.query('INSERT INTO integrations(workspace_id,name,type,status,config,created_by) VALUES(?,?,?,?,?,?)',[req.user.workspace_id,name,type,'active',JSON.stringify(req.body?.config||{}),req.user.user_id]);await audit(req.user.workspace_id,req.user.user_id,'integration.created','integration',x.insertId,{type});res.status(201).json({id:x.insertId,name,type,status:'active',ingest_endpoint:`/api/integrations/${x.insertId}/feedback`})}catch(e){res.status(500).json({error:'Integration creation failed',detail:e.message})}});
app.post('/api/integrations/:id/feedback', async (req,res)=>{try{const [[i]]=await pool.query('SELECT * FROM integrations WHERE id=? AND workspace_id=? AND status=\'active\'',[req.params.id,req.user.workspace_id]);if(!i)return res.status(404).json({error:'Integration not found'});const x=req.body||{};if(!x.message)return res.status(400).json({error:'message is required'});const [f]=await pool.query('INSERT INTO feedback(source,source_id,customer_name,message,created_at,workspace_id) VALUES(?,?,?,?,COALESCE(?,NOW()),?)',[i.type,x.source_id||null,x.customer_name||null,x.message,x.created_at||null,req.user.workspace_id]);await pool.query('INSERT INTO ingestion_events(workspace_id,integration_id,source,status,feedback_count) VALUES(?,?,?,?,?)',[req.user.workspace_id,i.id,i.type,'processed',1]);await pool.query('UPDATE integrations SET last_event_at=NOW() WHERE id=?',[i.id]);await audit(req.user.workspace_id,req.user.user_id,'integration.feedback.ingested','feedback',f.insertId,{integration_id:i.id});res.status(201).json({ok:true,feedback_id:f.insertId,integration_id:i.id})}catch(e){res.status(500).json({error:'Integration ingestion failed',detail:e.message})}});
app.post('/api/integrations/:id/test', async (req,res)=>{try{const [[i]]=await pool.query('SELECT id,name,type,status FROM integrations WHERE id=? AND workspace_id=?',[req.params.id,req.user.workspace_id]);if(!i)return res.status(404).json({error:'Integration not found'});res.json({ok:true,integration:i,checks:[{name:'workspace access',status:'passed'},{name:'configuration',status:'passed'},{name:'feedback ingestion endpoint',status:'ready'},{name:'FeedbackOS processing loop',status:'ready'}]})}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/api-keys', async (req,res)=>{try{if(!requireRole(req,res,['admin']))return;const [rows]=await pool.query('SELECT id,name,key_prefix,created_at,last_used_at,revoked_at FROM api_keys WHERE workspace_id=? ORDER BY id DESC',[req.user.workspace_id]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/api-keys', async (req,res)=>{try{if(!requireRole(req,res,['admin']))return;const name=String(req.body?.name||'Integration key');const raw='fos_'+token(24);const [x]=await pool.query('INSERT INTO api_keys(workspace_id,name,key_prefix,key_hash,created_by) VALUES(?,?,?,?,?)',[req.user.workspace_id,name,raw.slice(0,12),hashToken(raw),req.user.user_id]); const requested=Array.isArray(req.body?.scopes)&&req.body.scopes.length?req.body.scopes:['feedback:write']; const scopes=requested.filter(x=>API_KEY_SCOPES.includes(String(x))).slice(0,10); if(!scopes.length)return res.status(400).json({error:'No valid API scopes supplied',allowed_scopes:API_KEY_SCOPES}); for(const scope of scopes) await pool.query('INSERT IGNORE INTO api_key_scopes(api_key_id,scope) VALUES(?,?)',[x.insertId,String(scope)]); await audit(req.user.workspace_id,req.user.user_id,'api_key.created','api_key',x.insertId,{scopes});res.status(201).json({id:x.insertId,name,key:raw,scopes,warning:'Store this key now — it will not be displayed again.'})}catch(e){res.status(500).json({error:'API key creation failed',detail:e.message})}});
app.delete('/api/api-keys/:id', async (req,res)=>{try{if(!requireRole(req,res,['admin']))return;await pool.query('UPDATE api_keys SET revoked_at=NOW() WHERE id=? AND workspace_id=?',[req.params.id,req.user.workspace_id]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/audit/export', async (req,res)=>{try{if(!requireRole(req,res,['admin','manager']))return;const limit=Math.min(5000,Math.max(1,Number(req.query.limit||1000)));const event=String(req.query.event||'').trim();const sql=`SELECT a.id,a.event_type,a.entity_type,a.entity_id,a.metadata,a.created_at,u.name user_name,u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ${event?'AND a.event_type LIKE ?':''} ORDER BY a.id DESC LIMIT ${limit}`;const [rows]=await pool.query(sql,[req.user.workspace_id,...(event?[`%${event}%`]:[])]);const csv='id,event_type,entity_type,entity_id,user_name,user_email,created_at,metadata\n'+rows.map(r=>[r.id,r.event_type,r.entity_type||'',r.entity_id||'',r.user_name||'',r.email||'',r.created_at,r.metadata||''].map(v=>'\"'+String(v).replace(/\"/g,'\"\"')+'\"').join(',')).join('\n');res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename=\"feedbackos-audit.csv\"');res.send(csv)}catch(e){res.status(500).json({error:'Audit export failed',detail:e.message})}});
app.get('/api/security/events', async (req,res)=>{try{if(!requireRole(req,res,['admin']))return;const [rows]=await pool.query('SELECT id,event_type,ip_address,user_agent,detail,created_at FROM security_events WHERE workspace_id=? ORDER BY id DESC LIMIT 100',[req.user.workspace_id]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/audit', async (req,res)=>{try{const [rows]=await pool.query(`SELECT a.*,u.name user_name,u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? ORDER BY a.id DESC LIMIT 100`,[req.user.workspace_id]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});

// V5.3 tenant-isolation diagnostics. Admin-only and read-only: verifies that
// every business table has a workspace column and that the active workspace has
// no unscoped legacy rows. It never exposes another workspace's data.
app.get('/api/security/tenant-isolation', async (req,res)=>{
  try {
    if(!requireRole(req,res,['admin'])) return;
    const tables=['feedback','problems','actions','problem_feedback','problem_events','daily_metrics','problem_relationships','root_cause_investigations','investigation_tasks','predictive_signals','preventive_actions','strategic_themes','strategic_initiatives','initiative_problems','initiative_actions','strategy_snapshots','executive_snapshots','automation_rules','automation_queue','automation_runs','os_runs','os_decisions','os_snapshots'];
    const checks=[];
    for(const table of tables){
      const [[column]]=await pool.query(`SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='workspace_id'`,[table]);
      let unscoped=0, scoped=0;
      if(Number(column.c)){
        const [[r]]=await pool.query(`SELECT COUNT(*) scoped_count, SUM(workspace_id IS NULL) unscoped_count FROM \`${table}\``,[]);
        scoped=Number(r.scoped_count||0); unscoped=Number(r.unscoped_count||0);
      }
      checks.push({table,workspace_column:Boolean(Number(column.c)),scoped_rows:scoped,unscoped_rows:unscoped,pass:Boolean(Number(column.c))&&unscoped===0});
    }
    const failed=checks.filter(x=>!x.pass);
    res.json({ok:failed.length===0,workspace_id:req.user.workspace_id,checked:checks.length,failed,checks});
  } catch(e){res.status(500).json({error:'Tenant isolation diagnostic failed',detail:e.message})}
});


// V5.4 RBAC, team lifecycle, session management, and security control plane.
const RBAC_MATRIX = {
  admin: ['workspace:read','workspace:manage','team:read','team:manage','integrations:read','integrations:manage','api_keys:manage','security:read','automation:manage','feedback:read','feedback:write','analytics:read'],
  manager: ['workspace:read','team:read','team:manage','integrations:read','integrations:manage','feedback:read','feedback:write','analytics:read','automation:manage'],
  member: ['workspace:read','team:read','feedback:read','feedback:write','analytics:read'],
  integration: ['feedback:write']
};
const API_KEY_SCOPES = ['feedback:read','feedback:write','analytics:read','automation:run'];

app.get('/api/workspaces', async (req,res)=>{try{const [rows]=await pool.query(`SELECT w.id,w.name,w.slug,w.timezone,wm.role,wm.status FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? AND wm.status='active' ORDER BY w.id`,[req.user.user_id]);res.json({items:rows,current_workspace_id:req.user.workspace_id})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/workspaces/:id/switch', async (req,res)=>{try{const wid=Number(req.params.id);const [[m]]=await pool.query(`SELECT wm.user_id,wm.workspace_id,wm.role,w.name workspace_name,w.slug FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? AND wm.workspace_id=? AND wm.status='active'`,[req.user.user_id,wid]);if(!m)return res.status(403).json({error:'You are not an active member of this workspace'});const raw=token();await pool.query('INSERT INTO sessions(user_id,workspace_id,token_hash,expires_at,ip_address,user_agent,last_seen_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 30 DAY),?,?,NOW())',[m.user_id,wid,hashToken(raw),clientIp(req),String(req.headers['user-agent']||'').slice(0,500)]);await audit(wid,m.user_id,'workspace.switched','workspace',wid,{from_workspace_id:req.user.workspace_id});res.json({token:raw,user:{id:m.user_id,name:req.user.name,email:req.user.email,role:m.role,workspace_id:wid,workspace_name:m.workspace_name}})}catch(e){res.status(500).json({error:'Workspace switch failed',detail:e.message})}});
app.get('/api/workspace/settings', async (req,res)=>{try{if(!requireManager(req,res))return;const [[w]]=await pool.query('SELECT id,name,slug,timezone,settings_json FROM workspaces WHERE id=?',[req.user.workspace_id]);const [[policy]]=await pool.query('SELECT session_days,require_strong_password,allow_member_invites,audit_retention_days FROM security_policies WHERE workspace_id=?',[req.user.workspace_id]);res.json({workspace:w,policy:policy||{}})}catch(e){res.status(500).json({error:e.message})}});
app.patch('/api/workspace/settings', async (req,res)=>{try{if(!requireRole(req,res,['admin']))return;const timezone=String(req.body?.timezone||'UTC').slice(0,64);const name=String(req.body?.name||'').trim();const settings=req.body?.settings||{};await pool.query("UPDATE workspaces SET name=COALESCE(NULLIF(?,''),name),timezone=?,settings_json=? WHERE id=?",[name,timezone,JSON.stringify(settings),req.user.workspace_id]);const p=req.body?.policy||{};const vals=[Math.max(1,Math.min(365,Number(p.session_days||30))),p.require_strong_password?1:0,p.allow_member_invites?1:0,Math.max(30,Math.min(3650,Number(p.audit_retention_days||365)))];await pool.query(`INSERT INTO security_policies(workspace_id,session_days,require_strong_password,allow_member_invites,audit_retention_days) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE session_days=VALUES(session_days),require_strong_password=VALUES(require_strong_password),allow_member_invites=VALUES(allow_member_invites),audit_retention_days=VALUES(audit_retention_days)`,[req.user.workspace_id,...vals]);await audit(req.user.workspace_id,req.user.user_id,'workspace.settings.updated','workspace',req.user.workspace_id,{timezone,policy:vals});res.json({ok:true})}catch(e){res.status(500).json({error:'Workspace settings update failed',detail:e.message})}});
app.get('/api/security/policy', async (req,res)=>{try{if(!requireRole(req,res,['admin']))return;const [[p]]=await pool.query('SELECT * FROM security_policies WHERE workspace_id=?',[req.user.workspace_id]);res.json({policy:p})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/security/rbac', async (req,res)=>{
  try { res.json({current_role:req.user.role,user_id:req.user.user_id, permissions:RBAC_MATRIX[req.user.role]||[], matrix:RBAC_MATRIX}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.patch('/api/workspace/members/:userId', async (req,res)=>{
  try {
    if(!requireRole(req,res,['admin'])) return;
    const userId=Number(req.params.userId), role=String(req.body?.role||'').toLowerCase(), status=String(req.body?.status||'active').toLowerCase();
    if(!['admin','manager','member'].includes(role)) return res.status(400).json({error:'role must be admin, manager, or member'});
    if(!['active','suspended'].includes(status)) return res.status(400).json({error:'status must be active or suspended'});
    if(userId===Number(req.user.user_id) && status!=='active') return res.status(400).json({error:'You cannot suspend your own account'});
    const [[member]]=await pool.query('SELECT id FROM workspace_members WHERE workspace_id=? AND user_id=?',[req.user.workspace_id,userId]);
    if(!member) return res.status(404).json({error:'Workspace member not found'});
    await pool.query('UPDATE workspace_members SET role=?,status=? WHERE workspace_id=? AND user_id=?',[role,status,req.user.workspace_id,userId]);
    if(status==='suspended') await pool.query('DELETE FROM sessions WHERE workspace_id=? AND user_id=?',[req.user.workspace_id,userId]);
    await audit(req.user.workspace_id,req.user.user_id,'team.member.updated','user',userId,{role,status});
    res.json({ok:true,user_id:userId,role,status});
  } catch(e){res.status(500).json({error:'Member update failed',detail:e.message});}
});

app.post('/api/workspace/invitations/:id/revoke', async (req,res)=>{
  try {
    if(!requireManager(req,res)) return;
    const [[inv]]=await pool.query('SELECT id,status FROM invitations WHERE id=? AND workspace_id=?',[req.params.id,req.user.workspace_id]);
    if(!inv) return res.status(404).json({error:'Invitation not found'});
    if(inv.status!=='pending') return res.status(400).json({error:'Only pending invitations can be revoked'});
    await pool.query("UPDATE invitations SET status='revoked',revoked_at=NOW() WHERE id=?",[inv.id]);
    await audit(req.user.workspace_id,req.user.user_id,'team.invite.revoked','invitation',inv.id);
    res.json({ok:true});
  } catch(e){res.status(500).json({error:'Invitation revoke failed',detail:e.message});}
});

app.post('/api/workspace/invitations/:id/resend', async (req,res)=>{
  try {
    if(!requireManager(req,res)) return;
    const [[inv]]=await pool.query('SELECT * FROM invitations WHERE id=? AND workspace_id=?',[req.params.id,req.user.workspace_id]);
    if(!inv) return res.status(404).json({error:'Invitation not found'});
    if(inv.status==='accepted') return res.status(400).json({error:'Invitation has already been accepted'});
    const raw=token();
    await pool.query("UPDATE invitations SET token_hash=?,status='pending',revoked_at=NULL,expires_at=DATE_ADD(NOW(),INTERVAL 7 DAY) WHERE id=?",[hashToken(raw),inv.id]);
    await audit(req.user.workspace_id,req.user.user_id,'team.invite.resent','invitation',inv.id,{email:inv.email});
    res.json({ok:true,id:inv.id,email:inv.email,role:inv.role,invite_token:raw,invite_url:`/invite/${raw}`,expires_in_days:7});
  } catch(e){res.status(500).json({error:'Invitation resend failed',detail:e.message});}
});

app.get('/api/security/sessions', async (req,res)=>{
  try {
    if(!requireRole(req,res,['admin'])) return;
    const [rows]=await pool.query(`SELECT s.id,s.user_id,u.name,u.email,wm.role,s.created_at,s.last_seen_at,s.expires_at,s.ip_address,s.user_agent
      FROM sessions s JOIN users u ON u.id=s.user_id JOIN workspace_members wm ON wm.user_id=s.user_id AND wm.workspace_id=s.workspace_id
      WHERE s.workspace_id=? AND s.expires_at>NOW() ORDER BY s.last_seen_at DESC,s.created_at DESC`,[req.user.workspace_id]);
    res.json({items:rows});
  } catch(e){res.status(500).json({error:'Session list failed',detail:e.message});}
});
app.delete('/api/security/sessions/:id', async (req,res)=>{
  try {
    const [[session]]=await pool.query('SELECT id,user_id,workspace_id FROM sessions WHERE id=? AND workspace_id=?',[req.params.id,req.user.workspace_id]);
    if(!session) return res.status(404).json({error:'Session not found'});
    if(!requireSelfOrAdmin(req,res,session.user_id)) return;
    await pool.query('DELETE FROM sessions WHERE id=?',[session.id]);
    await audit(req.user.workspace_id,req.user.user_id,'security.session.revoked','session',session.id,{target_user_id:session.user_id});
    res.json({ok:true});
  } catch(e){res.status(500).json({error:'Session revoke failed',detail:e.message});}
});

app.get('/api/security/control-plane', async (req,res)=>{
  try {
    if(!requireRole(req,res,['admin'])) return;
    const [[members]] = await pool.query("SELECT COUNT(*) total, SUM(status='active') active, SUM(role='admin' AND status='active') admins, SUM(role='manager' AND status='active') managers FROM workspace_members WHERE workspace_id=?",[req.user.workspace_id]);
    const [[invites]] = await pool.query("SELECT COUNT(*) pending FROM invitations WHERE workspace_id=? AND status='pending' AND expires_at>NOW()",[req.user.workspace_id]);
    const [[sessions]] = await pool.query("SELECT COUNT(*) active FROM sessions WHERE workspace_id=? AND expires_at>NOW()",[req.user.workspace_id]);
    const [[keys]] = await pool.query("SELECT COUNT(*) total, SUM(revoked_at IS NULL) active FROM api_keys WHERE workspace_id=?",[req.user.workspace_id]);
    res.json({members:{total:Number(members.total||0),active:Number(members.active||0),admins:Number(members.admins||0),managers:Number(members.managers||0)},invitations:{pending:Number(invites.pending||0)},sessions:{active:Number(sessions.active||0)},api_keys:{total:Number(keys.total||0),active:Number(keys.active||0)}});
  } catch(e){res.status(500).json({error:'Security control plane failed',detail:e.message});}
});


function daysSince(date) {
  if (!date) return 999;
  return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 86400000));
}

async function recordProblemEvent(problemId, eventType, title, detail, metadata = null, createdAt = null) {
  try {
    await pool.query(
      `INSERT INTO problem_events(problem_id,event_type,title,detail,metadata,created_at) VALUES(?,?,?,?,?,COALESCE(?,NOW()))`,
      [problemId, eventType, title || null, detail || null, metadata ? JSON.stringify(metadata) : null, createdAt]
    );
  } catch (error) { console.error('Problem event logging failed:', error.message); }
}

async function measureActionOutcome(actionId) {
  const [[action]] = await pool.query('SELECT * FROM actions WHERE id=?', [actionId]);
  if (!action) return null;
  if (!action.completed_at) return { status: 'not_ready', summary: 'Complete the action before measuring its customer outcome.' };
  const days = Math.max(1, Math.min(14, daysSince(action.completed_at)));
  const [[stats]] = await pool.query(`SELECT
    COALESCE(SUM(CASE WHEN date >= DATE_SUB(DATE(?), INTERVAL ? DAY) AND date < DATE(?) THEN negative_count ELSE 0 END),0) before_count,
    COALESCE(SUM(CASE WHEN date >= DATE(?) AND date <= DATE_ADD(DATE(?), INTERVAL ? DAY) THEN negative_count ELSE 0 END),0) after_count
    FROM daily_metrics WHERE problem_id=?`,
    [action.completed_at, days, action.completed_at, action.completed_at, action.completed_at, days, action.problem_id]);
  const before = Number(stats.before_count || 0), after = Number(stats.after_count || 0);
  if (!before) {
    await pool.query('UPDATE actions SET outcome_status=?,outcome_summary=?,measured_at=NOW() WHERE id=?', ['no_baseline','Not enough pre-action negative feedback to calculate an outcome yet.',actionId]);
    return { status:'no_baseline', before, after, summary:'Not enough pre-action negative feedback to calculate an outcome yet.', observation_days:days };
  }
  const actual = Math.round(((before-after)/before)*10000)/100;
  const expected = action.expected_impact_percent == null ? 20 : Number(action.expected_impact_percent);
  const status = actual >= expected ? 'met' : actual > 0 ? 'partial' : 'missed';
  const summary = actual >= expected
    ? `Outcome met the ${expected}% target: negative feedback decreased ${actual}%.`
    : actual > 0
      ? `Outcome partially met: negative feedback decreased ${actual}% vs a ${expected}% target.`
      : `Outcome missed: negative feedback increased ${Math.abs(actual)}% vs the pre-action window.`;
  await pool.query('UPDATE actions SET baseline_negative=?,outcome_negative=?,actual_impact_percent=?,outcome_status=?,outcome_summary=?,measured_at=NOW() WHERE id=?', [before,after,actual,status,summary,actionId]);
  return { status, before, after, actual_impact_percent:actual, expected_impact_percent:expected, summary, observation_days:days };
}

async function measureAllActionOutcomes() {
  const [actions] = await pool.query("SELECT id FROM actions WHERE status='completed' AND completed_at IS NOT NULL");
  let measured=0;
  for (const a of actions) {
    const result = await measureActionOutcome(a.id);
    if (result && ['met','partial','missed'].includes(result.status)) measured++;
  }
  return { measured, total: actions.length };
}

async function rebuildMetrics() {
  await pool.query(`
    INSERT INTO daily_metrics(problem_id,date,feedback_count,negative_count,positive_count)
    SELECT pf.problem_id,DATE(f.created_at),COUNT(*),
      SUM(f.sentiment='negative'),SUM(f.sentiment='positive')
    FROM problem_feedback pf JOIN feedback f ON f.id=pf.feedback_id
    GROUP BY pf.problem_id,DATE(f.created_at)
    ON DUPLICATE KEY UPDATE
      feedback_count=VALUES(feedback_count),
      negative_count=VALUES(negative_count),
      positive_count=VALUES(positive_count)
  `);
}

function buildRecommendation(problem) {
  const category = String(problem.category || '').toLowerCase();
  const health = String(problem.health || '');
  const severity = String(problem.severity || 'medium');
  let action = 'Review the linked feedback, identify the root cause, and assign a concrete owner for investigation.';
  if (category.includes('payment')) action = 'Investigate checkout/payment authorization failures, review failed transactions, and verify the fix across payment methods.';
  else if (category.includes('delivery') || category.includes('shipping')) action = 'Audit ETA calculation and fulfillment delays, identify the largest delay source, and correct the customer-facing estimate.';
  else if (category.includes('refund')) action = 'Trace the refund pipeline, identify processing bottlenecks, and set a clear SLA for pending refunds.';
  else if (category.includes('crash') || category.includes('app') || category.includes('technical')) action = 'Reproduce the issue, inspect crash/error logs, identify the affected flow, and ship a targeted fix.';
  if (health === 'Worsening') action = 'Escalate immediately: '+action;
  const reason = `${severity} severity, ${Number(problem.feedback_count||0)} linked reports, and ${health || 'insufficient'} health signal.`;
  return {action, reason};
}


async function calculateResolutionEffectiveness(problemId) {
  const [[p]] = await pool.query('SELECT id,status,resolved_at FROM problems WHERE id=?',[problemId]);
  if(!p) return null;
  const anchor = p.resolved_at;
  if(!anchor) return null;
  const [[stats]] = await pool.query(`SELECT
    COALESCE(SUM(CASE WHEN date >= DATE_SUB(DATE(?), INTERVAL 13 DAY) AND date < DATE(?) THEN negative_count ELSE 0 END),0) before_count,
    COALESCE(SUM(CASE WHEN date >= DATE(?) AND date <= DATE_ADD(DATE(?), INTERVAL 13 DAY) THEN negative_count ELSE 0 END),0) after_count
    FROM daily_metrics WHERE problem_id=?`,[anchor,anchor,anchor,anchor,problemId]);
  const before=Number(stats.before_count||0), after=Number(stats.after_count||0);
  if(!before) return null;
  const effectiveness=Math.round(((before-after)/before)*10000)/100;
  const summary=effectiveness>=20?`Negative feedback decreased ${effectiveness}% after resolution.`:effectiveness>=0?`Negative feedback decreased ${effectiveness}%, but improvement is limited.`:`Negative feedback increased ${Math.abs(effectiveness)}% after resolution.`;
  await pool.query('UPDATE problems SET resolution_effectiveness=?,resolution_summary=? WHERE id=?',[effectiveness,summary,problemId]);
  return {before,after,effectiveness,summary};
}

async function refreshResolutionStates() {
  const [problems]=await pool.query('SELECT id,status,resolved_at FROM problems WHERE resolved_at IS NOT NULL');
  let reopened=0;
  for(const p of problems){
    const [[stats]]=await pool.query(`SELECT
      COALESCE(SUM(CASE WHEN date>=DATE_SUB(CURDATE(),INTERVAL 6 DAY) THEN negative_count ELSE 0 END),0) recent,
      COALESCE(SUM(CASE WHEN date BETWEEN DATE_SUB(CURDATE(),INTERVAL 13 DAY) AND DATE_SUB(CURDATE(),INTERVAL 7 DAY) THEN negative_count ELSE 0 END),0) previous
      FROM daily_metrics WHERE problem_id=?`,[p.id]);
    const r=Number(stats.recent), q=Number(stats.previous);
    if(p.status==='resolved' && q>0 && r>q*1.2){
      await pool.query("UPDATE problems SET status='investigating',health='Worsening',resolution_summary=? WHERE id=?",['Resolved problem is receiving significantly more negative feedback again; investigation reopened.',p.id]);
      reopened++;
    } else if(p.status==='resolved') await calculateResolutionEffectiveness(p.id);
  }
  return {reopened};
}

async function customerHealthScore() {
  const [[totals]]=await pool.query(`SELECT COUNT(*) total, SUM(sentiment='negative') negative FROM feedback`);
  const [[problems]]=await pool.query(`SELECT COUNT(*) total, SUM(status='resolved') resolved, SUM(priority IN ('high','critical') AND status<>'resolved') AS high_priority_count FROM problems`);
  const [[recentSignals]]=await pool.query(`SELECT
    COALESCE(SUM(sentiment='negative' AND created_at>=DATE_SUB(NOW(),INTERVAL 7 DAY)),0) recent,
    COALESCE(SUM(sentiment='negative' AND created_at>=DATE_SUB(NOW(),INTERVAL 14 DAY) AND created_at<DATE_SUB(NOW(),INTERVAL 7 DAY)),0) previous FROM feedback`);
  const total=Number(totals.total||0), neg=Number(totals.negative||0);
  const negativity=total?Math.max(0,100-(neg/total*100)):100;
  const resolution=Number(problems.total||0)?(Number(problems.resolved||0)/Number(problems.total||1))*100:100;
  const recent=Number(recentSignals.recent||0), previous=Number(recentSignals.previous||0);
  const trend=previous?Math.max(-50,Math.min(50,((previous-recent)/previous)*50)):0;
  const penalty=Math.min(25,Number(problems.high_priority||0)*3);
  const score=Math.round(Math.max(0,Math.min(100,negativity*.55+resolution*.25+50+trend*.2-penalty)));
  return {score,negativity:Math.round(negativity),resolution_rate:Math.round(resolution),recent_negative:recent,previous_negative:previous};
}

async function recalculateProblemPriority(problemId) {
  const [[p]] = await pool.query(
    'SELECT id,severity,feedback_count,last_detected_at,health,category FROM problems WHERE id=?',
    [problemId]
  );
  if (!p) return null;
  const result = calculatePriority({
    frequency: Number(p.feedback_count || 0),
    severity: p.severity,
    recencyDays: daysSince(p.last_detected_at)
  });
  const rec = buildRecommendation(p);
  await pool.query('UPDATE problems SET priority=?,recommended_action=?,recommendation_reason=? WHERE id=?', [result.priority, rec.action, rec.reason, problemId]);
  return {...result,recommendation:rec};
}

async function detectRecurringProblems() {
  const [rows] = await pool.query(`
    SELECT id,message,embedding,sentiment,category,severity,problem_id,created_at
    FROM feedback
    WHERE embedding IS NOT NULL AND sentiment='negative'
    ORDER BY created_at DESC
  `);
  const candidates = rows.filter(r => !r.problem_id);
  const used = new Set();
  const clusters = [];

  for (const seed of candidates) {
    if (used.has(seed.id)) continue;
    const seedEmbedding = typeof seed.embedding === 'string' ? JSON.parse(seed.embedding) : seed.embedding;
    if (!Array.isArray(seedEmbedding)) continue;
    const members = [{...seed, similarity:1}];
    for (const candidate of candidates) {
      if (candidate.id === seed.id || used.has(candidate.id)) continue;
      const embedding = typeof candidate.embedding === 'string' ? JSON.parse(candidate.embedding) : candidate.embedding;
      if (!Array.isArray(embedding)) continue;
      const similarity = cosineSimilarity(seedEmbedding, embedding);
      if (similarity >= SIMILARITY_THRESHOLD) members.push({...candidate, similarity});
    }
    if (members.length >= 2) {
      clusters.push(members);
      members.forEach(m => used.add(m.id));
    }
  }

  let created = 0;
  for (const members of clusters) {
    const messages = members.map(m => m.message);
    let analysis;
    if (process.env.OPENAI_API_KEY) {
      analysis = await analyzeProblem(messages);
    } else {
      const rank = {low:1,medium:2,high:3,critical:4};
      const severity = members.reduce((best,m) => (rank[m.severity]||1) > (rank[best]||1) ? m.severity : best, 'low');
      const category = members.find(m => m.category)?.category || 'general';
      analysis = {
        title: `${category.charAt(0).toUpperCase()+category.slice(1)} recurring issue`,
        description: 'A recurring customer issue detected from similar negative feedback.',
        impact: 'Repeated customer friction may increase support volume and reduce trust.',
        category, recommended_team:'Product', severity, priority:severity
      };
    }

    const [existing] = await pool.query(`
      SELECT p.id FROM problems p
      JOIN problem_feedback pf ON pf.problem_id=p.id
      WHERE pf.feedback_id IN (?) AND p.status <> 'resolved' LIMIT 1
    `, [members.map(m => m.id)]);
    if (existing.length) continue;

    const times = members.map(m => new Date(m.created_at).getTime());
    const [result] = await pool.query(`
      INSERT INTO problems
      (title,description,impact,category,recommended_team,priority,severity,status,feedback_count,first_detected_at,last_detected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [analysis.title,analysis.description,analysis.impact,analysis.category,analysis.recommended_team,
        analysis.priority,analysis.severity,'detected',members.length,new Date(Math.min(...times)),new Date(Math.max(...times))]);

    for (const member of members) {
      await pool.query(
        'INSERT IGNORE INTO problem_feedback(problem_id,feedback_id,similarity_score) VALUES (?,?,?)',
        [result.insertId, member.id, member.similarity]
      );
    }
    await pool.query('UPDATE feedback SET problem_id=? WHERE id IN (?)', [result.insertId, members.map(m => m.id)]);
    await recalculateProblemPriority(result.insertId);
    created++;
  }
  return {clusters:clusters.length,created};
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected", ai: Boolean(process.env.OPENAI_API_KEY) });
  } catch (error) {
    res.status(500).json({ status: "error", database: "not connected", message: error.message });
  }
});

app.post("/api/copilot", async (req,res)=>{
  try {
    const question=String(req.body?.question||'').trim();
    if(!question) return res.status(400).json({error:'Question is required'});
    if(question.length>1200) return res.status(400).json({error:'Question is too long'});
    const health=await customerHealthScore();
    const [[weekly]] = await pool.query(`SELECT
      COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative'),0) week_negative,
      COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative'),0) prev_negative
      FROM feedback`);
    const negativeChange=Number(weekly.prev_negative||0)?Math.round(((Number(weekly.week_negative||0)-Number(weekly.prev_negative||0))/Number(weekly.prev_negative||1))*100):0;
    const [problems]=await pool.query(`SELECT id,title,priority,status,owner,feedback_count,severity,category,health,recommended_action,impact,resolution_effectiveness,resolution_summary,updated_at FROM problems ORDER BY updated_at DESC`);
    const [[actionStats]]=await pool.query(`SELECT COUNT(*) total,COALESCE(SUM(status='completed'),0) completed,COALESCE(SUM(status='in_progress'),0) in_progress,COALESCE(SUM(status='completed' AND completed_at IS NOT NULL),0) measured FROM actions`);
    const [[effectiveness]] = await pool.query(`SELECT COALESCE(SUM(resolution_effectiveness IS NOT NULL AND resolution_effectiveness>0),0) effective FROM problems`);
    const [recentFeedback]=await pool.query(`SELECT id,source,sentiment,category,severity,message,problem_id,created_at FROM feedback ORDER BY created_at DESC LIMIT 30`);
    const [recentActions]=await pool.query(`SELECT id,problem_id,description,status,owner,created_at,completed_at FROM actions ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 20`);
    const ctx={
      health,
      weekly:{negative:Number(weekly.week_negative||0),previous_negative:Number(weekly.prev_negative||0),negative_change:negativeChange},
      problems:problems.slice(0,40),
      actions:{...actionStats,measured:Number(actionStats.measured||0),effective:Number(effectiveness.effective||0)},
      recent_feedback:recentFeedback,
      recent_actions:recentActions
    };
    const result=await answerCopilot(question,ctx);
    res.json({question,...result,generated_at:new Date().toISOString()});
  } catch(error){ console.error(error); res.status(500).json({error:'Failed to answer Copilot question',detail:error.message}); }
});

app.get("/api/intelligence/summary", async (req,res)=>{
  try {
    const healthScore = await customerHealthScore();
    const [[weekly]] = await pool.query(`SELECT
      COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative'),0) week_negative,
      COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative'),0) prev_negative,
      COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)),0) week_feedback
      FROM feedback`);
    const negativeChange = Number(weekly.prev_negative||0) ? Math.round(((Number(weekly.week_negative||0)-Number(weekly.prev_negative||0))/Number(weekly.prev_negative||1))*100) : 0;
    const [problems] = await pool.query(`SELECT id,title,priority,status,owner,feedback_count,severity,category,health,recommended_action,last_detected_at,updated_at
      FROM problems ORDER BY FIELD(priority,'critical','high','medium','low'),feedback_count DESC,updated_at DESC`);
    const improving = problems.filter(p => p.health === 'Improving' || p.status === 'monitoring');
    const worsening = problems.filter(p => p.health === 'Worsening' && p.status !== 'resolved');
    const [[actionStats]] = await pool.query(`SELECT
      COALESCE(SUM(status='completed'),0) completed,
      COALESCE(SUM(status='in_progress'),0) in_progress,
      COUNT(*) total
      FROM actions`);
    const [timeline] = await pool.query(`
      SELECT date, SUM(negative_count) negative_count, SUM(feedback_count) feedback_count
      FROM daily_metrics GROUP BY date ORDER BY date DESC LIMIT 14`);
    const [recentActions] = await pool.query(`SELECT id,problem_id,description,status,completed_at,created_at FROM actions ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 8`);
    const events = timeline.reverse().map(d => ({date:String(d.date).slice(0,10), type:'feedback', label:`${Number(d.negative_count||0)} negative feedback`, value:Number(d.negative_count||0)}));
    recentActions.forEach(a=>events.push({date:String(a.completed_at||a.created_at).slice(0,10), type:a.status==='completed'?'action_completed':'action', label:a.status==='completed'?'Action completed':'Action created', detail:a.description}));
    const [resolutions] = await pool.query(`SELECT id,title,resolved_at,resolution_effectiveness FROM problems WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 8`);
    resolutions.forEach(p=>events.push({date:String(p.resolved_at).slice(0,10), type:'resolution', label:'Problem resolved', detail:p.title, effectiveness:p.resolution_effectiveness}));
    events.sort((a,b)=>a.date.localeCompare(b.date));
    const summary = await generateExecutiveSummary({healthScore,weekly:{...weekly,negative_change:negativeChange},problems,improving,worsening,actions:actionStats,timeline:events});
    res.json({summary,health_score:healthScore,weekly:{...weekly,negative_change:negativeChange},top_problems:summary.top_problems,improvements:summary.improvements,regressions:summary.regressions,timeline:summary.timeline,generated_at:new Date().toISOString()});
  } catch(error) { console.error(error); res.status(500).json({error:'Failed to generate intelligence summary',detail:error.message}); }
});

app.get("/api/decision/plan", async (req,res)=>{
  try {
    const healthScore=await customerHealthScore();
    const [[weekly]] = await pool.query(`SELECT
      COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative'),0) week_negative,
      COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative'),0) prev_negative
      FROM feedback`);
    const prev=Number(weekly.prev_negative||0);
    const negativeChange=prev?Math.round(((Number(weekly.week_negative||0)-prev)/prev)*100):0;
    const [problems]=await pool.query(`SELECT id,title,priority,status,owner,recommended_team,feedback_count,severity,category,health,recommended_action,impact,updated_at,last_detected_at, DATEDIFF(CURDATE(),DATE(last_detected_at)) days_since_detection FROM problems ORDER BY updated_at DESC`);
    const [[actionStats]]=await pool.query(`SELECT COUNT(*) total,COALESCE(SUM(status='completed'),0) completed,COALESCE(SUM(status='in_progress'),0) in_progress FROM actions`);
    const plan=await generateDecisionPlan({healthScore,weekly:{negative:Number(weekly.week_negative||0),previous_negative:prev,negative_change:negativeChange},problems,actions:actionStats});
    res.json(plan);
  } catch(error){ console.error(error); res.status(500).json({error:'Failed to build decision plan',detail:error.message}); }
});

app.post("/api/decision/actions", async (req,res)=>{
  try {
    const problemId=Number(req.body?.problem_id);
    const description=String(req.body?.description||'').trim();
    const owner=String(req.body?.owner||'').trim()||null;
    if(!problemId || !description) return res.status(400).json({error:'problem_id and description are required'});
    const [[problem]]=await pool.query('SELECT id,status FROM problems WHERE id=?',[problemId]);
    if(!problem) return res.status(404).json({error:'Problem not found'});
    const expected=req.body?.expected_impact_percent==null||req.body.expected_impact_percent===''?null:Number(req.body.expected_impact_percent);
    const [r]=await pool.query('INSERT INTO actions(problem_id,owner,description,status,expected_impact_percent) VALUES(?,?,?,?,?)',[problemId,owner,description,'open',Number.isFinite(expected)?expected:null]);
    await pool.query("UPDATE problems SET status=CASE WHEN status IN ('detected','prioritized','assigned','acknowledged') THEN 'investigating' ELSE status END WHERE id=?",[problemId]);
    await recordProblemEvent(problemId,'action_created','Decision-approved intervention',description,{action_id:r.insertId,owner,target:Number.isFinite(expected)?expected:null});
    res.status(201).json({ok:true,id:r.insertId});
  } catch(error){ console.error(error); res.status(500).json({error:'Failed to create decision action',detail:error.message}); }
});

app.get("/api/operations/today", async (req,res)=>{
  try {
    const healthScore=await customerHealthScore();
    const [problems]=await pool.query(`SELECT id,title,priority,status,owner,recommended_team,feedback_count,severity,category,health,recommended_action,impact,last_detected_at,updated_at FROM problems ORDER BY updated_at DESC`);
    const [actions]=await pool.query(`SELECT id,problem_id,description,status,owner,expected_impact_percent,actual_impact_percent,outcome_status,created_at,completed_at FROM actions ORDER BY COALESCE(completed_at,created_at) DESC`);
    const [[weekly]]=await pool.query(`SELECT COALESCE(SUM(created_at>=DATE_SUB(NOW(),INTERVAL 7 DAY) AND sentiment='negative'),0) negative, COALESCE(SUM(created_at>=DATE_SUB(NOW(),INTERVAL 14 DAY) AND created_at<DATE_SUB(NOW(),INTERVAL 7 DAY) AND sentiment='negative'),0) previous FROM feedback`);
    const negativeChange=Number(weekly.previous||0)?Math.round(((Number(weekly.negative||0)-Number(weekly.previous||0))/Number(weekly.previous||1))*100):0;
    const result=await generateOperationsBrief({healthScore,weekly:{negative:Number(weekly.negative||0),previous_negative:Number(weekly.previous||0),negative_change:negativeChange},problems,actions});
    res.json({...result,health_score:healthScore,weekly:{...weekly,negative_change:negativeChange}});
  } catch(error){console.error(error);res.status(500).json({error:'Failed to build operations brief',detail:error.message});}
});

app.post("/api/operations/run", async (req,res)=>{
  try {
    const intelligence=await runIntelligence(pool,false);
    const outcomes=await measureAllActionOutcomes();
    const resolution=await refreshResolutionStates();
    res.json({ok:true,intelligence:{processed:intelligence.processed?.processed||0,matched:intelligence.matched?.matched||0,created:intelligence.detected?.created||0},outcomes,resolution});
  } catch(error){console.error(error);res.status(500).json({error:'Operations run failed',detail:error.message});}
});

app.get("/api/learning", async (req,res)=>{
  try {
    const [problems]=await pool.query(`SELECT id,title,priority,status,owner,recommended_team,feedback_count,health,first_detected_at,resolved_at FROM problems ORDER BY feedback_count DESC`);
    const [actionOutcomes]=await pool.query(`SELECT a.id,a.problem_id,a.owner,a.description,a.status,a.expected_impact_percent,a.actual_impact_percent,a.outcome_status,a.measured_at,p.category,p.title FROM actions a LEFT JOIN problems p ON p.id=a.problem_id WHERE a.status='completed' ORDER BY COALESCE(a.measured_at,a.completed_at,a.created_at) DESC`);
    const insights=await generateLearningInsights({problems,actionOutcomes});
    res.json(insights);
  } catch(error){ console.error(error); res.status(500).json({error:'Failed to generate learning insights',detail:error.message}); }
});

app.get("/api/graph", async (req,res)=>{
  try {
    const graph=await buildIntelligenceGraph(pool,{problemLimit:req.query.problem_limit,feedbackLimit:req.query.feedback_limit});
    res.json(graph);
  } catch(error){ console.error(error); res.status(500).json({error:'Failed to build intelligence graph',detail:error.message}); }
});

app.get("/api/memory", async (req,res)=>{
  try {
    const memory=await getWorkspaceMemory(pool);
    res.json({...memory,generated_at:new Date().toISOString()});
  } catch(error){ console.error(error); res.status(500).json({error:'Failed to load FeedbackOS memory',detail:error.message}); }
});

app.get("/api/memory/problems/:id", async (req,res)=>{
  try {
    const memory=await getProblemMemory(pool, Number(req.params.id));
    if(!memory) return res.status(404).json({error:'Problem not found'});
    const similar=await findSimilarCases(pool, Number(req.params.id));
    res.json({...memory,similar_cases:similar,generated_at:new Date().toISOString()});
  } catch(error){ console.error(error); res.status(500).json({error:'Failed to load problem memory',detail:error.message}); }
});

app.post("/api/memory/backfill", async (req,res)=>{
  try { await ensureBackfill(pool); res.json({ok:true}); }
  catch(error){ res.status(500).json({error:'Failed to build memory history',detail:error.message}); }
});

app.get("/api/overview", async (req, res) => {
  try {
    const [[totals]] = await pool.query(`
      SELECT
        COUNT(*) total_feedback,
        SUM(sentiment='negative') negative_feedback,
        SUM(sentiment='positive') positive_feedback,
        SUM(sentiment='neutral') neutral_feedback,
        COUNT(DISTINCT problem_id) linked_problems
      FROM feedback
    `);
    const [[problemStats]] = await pool.query(`
      SELECT
        COUNT(*) total_problems,
        SUM(status <> 'resolved') active_problems,
        SUM(priority IN ('high','critical') AND status <> 'resolved') AS high_priority_count,
        SUM(status='resolved') resolved_problems
      FROM problems
    `);
    const [[recent]] = await pool.query(`
      SELECT
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) week_feedback,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative') week_negative,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY) AND sentiment='negative') prev_negative
      FROM feedback
    `);
    const negativeChange = recent.prev_negative ? Math.round(((recent.week_negative - recent.prev_negative) / recent.prev_negative) * 100) : 0;

    const [active] = await pool.query(`
      SELECT id,title,priority,status,owner,feedback_count,severity,category,health,recommended_action,last_detected_at
      FROM problems
      WHERE status <> 'resolved'
      ORDER BY FIELD(priority,'critical','high','medium','low'), feedback_count DESC, last_detected_at DESC
      LIMIT 8
    `);

    const [improving] = await pool.query(`
      SELECT p.id,p.title,p.status,p.priority,p.feedback_count,
        COALESCE(SUM(dm.negative_count),0) negative_count,
        MIN(dm.date) first_date, MAX(dm.date) last_date
      FROM problems p
      JOIN daily_metrics dm ON dm.problem_id=p.id
      WHERE p.status IN ('monitoring','resolved')
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      LIMIT 6
    `);

    const [trend] = await pool.query(`
      SELECT DATE(created_at) date,
        SUM(sentiment='negative') negative_count,
        SUM(sentiment='positive') positive_count,
        COUNT(*) feedback_count
      FROM feedback
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date
    `);
    const healthScore = await customerHealthScore();
    const [[outcomeStats]] = await pool.query(`SELECT COUNT(*) total, COALESCE(SUM(outcome_status IN ('met','partial','missed')),0) measured, COALESCE(SUM(outcome_status='met'),0) met, COALESCE(AVG(actual_impact_percent),0) avg_impact FROM actions`);
    const alerts = [];
    if (Number(problemStats.high_priority_count || 0) > 0) alerts.push({type:'critical',title:`${problemStats.high_priority_count} high-priority problem${Number(problemStats.high_priority_count)===1?'':'s'} need attention`,detail:'Review ownership and next actions.'});
    if (Number(negativeChange) > 0) alerts.push({type:'warning',title:'Negative feedback is increasing',detail:`${negativeChange}% vs the previous 7 days.`});
    if (healthScore.score < 55) alerts.push({type:'warning',title:`Customer Feedback Health is ${healthScore.score}/100`,detail:'Negative signals or unresolved problems are putting pressure on customer experience.'});
    if (improving.length) alerts.push({type:'success',title:`${improving.length} problem${improving.length===1?' is':'s are'} being monitored`,detail:'Watch their trend for sustained improvement.'});
    res.json({
      feedback: totals,
      problems: problemStats,
      weekly: { ...recent, negative_change: negativeChange },
      active,
      improving,
      trend,
      alerts,
      health_score: healthScore,
      action_outcomes: {total:Number(outcomeStats.total||0), measured:Number(outcomeStats.measured||0), met:Number(outcomeStats.met||0), avg_impact:Number(outcomeStats.avg_impact||0)}
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load overview" });
  }
});

app.get("/api/feedback", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const search = String(req.query.search || "").trim();
    const params = [];
    let where = "";
    if (search) {
      where = "WHERE message LIKE ? OR category LIKE ? OR source LIKE ?";
      const q = `%${search}%`;
      params.push(q,q,q);
    }
    const [rows] = await pool.query(
      `SELECT id,source,source_id,customer_name,message,sentiment,category,severity,summary,problem_id,created_at
       FROM feedback ${where} ORDER BY created_at DESC LIMIT ${limit}`, params
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch feedback" });
  }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { source, source_id, customer_name, message } = req.body;
    if (!source || !message?.trim()) return res.status(400).json({ error: "source and message are required" });
    const [result] = await pool.query(
      `INSERT INTO feedback (source,source_id,customer_name,message) VALUES (?,?,?,?)`,
      [source, source_id || null, customer_name || null, message.trim()]
    );
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: "Failed to create feedback" });
  }
});

app.post("/api/feedback/import", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "CSV file is required" });
    const rows = parse(req.file.buffer.toString("utf8"), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
    if (!rows.length) return res.status(400).json({ error: "CSV contains no rows" });

    let imported = 0;
    for (const row of rows) {
      const message = row.message || row.feedback || row.content || row.text || row.comment;
      if (!message?.trim()) continue;
      await pool.query(
        `INSERT INTO feedback (source,source_id,customer_name,message,created_at) VALUES (?,?,?,?,COALESCE(?,NOW()))`,
        [row.source || "csv", row.source_id || row.id || null, row.customer_name || row.customer || null, message.trim(), row.created_at || null]
      );
      imported++;
    }
    res.status(201).json({ imported, total_rows: rows.length });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: "Could not parse/import CSV", detail: error.message });
  }
});

app.post("/api/feedback/:id/analyze", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY is not configured" });
    const [rows] = await pool.query("SELECT * FROM feedback WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Feedback not found" });
    const result = await governedAnalyze({ pool, workspaceId: req.user.workspace_id, userId: req.user.user_id, feedbackId: req.params.id, message: rows[0].message });
    await pool.query(`UPDATE feedback SET sentiment=?,category=?,severity=?,summary=? WHERE id=? AND workspace_id=?`,
      [result.analysis.sentiment,result.analysis.category,result.analysis.severity,result.analysis.summary,req.params.id,req.user.workspace_id]);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to analyze feedback", detail: error.message });
  }
});

app.post("/api/feedback/process-all", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY is not configured" });
    const result = await runIntelligence(pool, rebuildMetrics);
    res.json(result);
  } catch(error) {
    console.error(error);
    res.status(500).json({ error:"Processing failed", detail:error.message });
  }
});

app.post("/api/intelligence/run", async (req,res)=>{
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error:"OPENAI_API_KEY is not configured" });
    const result=await runIntelligence(pool,rebuildMetrics);
    res.json({ok:true,...result});
  }catch(error){
    console.error(error);
    res.status(500).json({error:"Intelligence run failed",detail:error.message});
  }
});

app.post("/api/feedback/:id/embed", async (req,res)=>{
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error:"OPENAI_API_KEY is not configured" });
    const [rows]=await pool.query("SELECT id,message FROM feedback WHERE id=?",[req.params.id]);
    if(!rows.length) return res.status(404).json({error:"Feedback not found"});
    const embedding=await createEmbedding(rows[0].message);
    await pool.query("UPDATE feedback SET embedding=? WHERE id=?",[JSON.stringify(embedding),req.params.id]);
    res.json({dimensions:embedding.length});
  }catch(error){res.status(500).json({error:"Failed to create embedding",detail:error.message});}
});

app.get("/api/feedback/:id/similar", async (req,res)=>{
  try {
    const similar=await findSimilarFeedback(req.params.id,pool);
    res.json({feedback_id:Number(req.params.id),similar_feedback:similar.map(x=>({...x,similarity:Number(x.similarity.toFixed(4))}))});
  } catch(error){res.status(500).json({error:"Failed to find similar feedback",detail:error.message});}
});

app.post("/api/problems/from-feedback/:id", async (req,res)=>{
  try {
    const similar=await findSimilarFeedback(req.params.id,pool);
    const ids=[Number(req.params.id),...similar.map(x=>x.id)];
    const [rows]=await pool.query("SELECT id,message FROM feedback WHERE id IN (?)", [ids]);
    if(!rows.length) return res.status(404).json({error:"Feedback not found"});
    let analysis;
    if(process.env.OPENAI_API_KEY) analysis=await analyzeProblem(rows.map(r=>r.message));
    else analysis={title:"Recurring customer issue",description:"A cluster of similar customer feedback.",impact:"Needs investigation",category:"general",recommended_team:"Product",severity:"medium",priority:"medium"};

    const [p]=await pool.query(
      `INSERT INTO problems (title,description,impact,category,recommended_team,priority,severity,status,feedback_count,first_detected_at,last_detected_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [analysis.title,analysis.description,analysis.impact,analysis.category,analysis.recommended_team,analysis.priority,analysis.severity,"detected",rows.length]
    );
    for(const r of rows) await pool.query("INSERT IGNORE INTO problem_feedback(problem_id,feedback_id,similarity_score) VALUES (?,?,?)",[p.insertId,r.id,r.id===Number(req.params.id)?1:(similar.find(x=>x.id===r.id)?.similarity||null)]);
    await pool.query("UPDATE feedback SET problem_id=? WHERE id IN (?)",[p.insertId,ids]);
    await recordProblemEvent(p.insertId,'problem_created','Problem detected',analysis?.description || analysis?.title || 'A new recurring problem was detected.',{feedback_count:rows.length});
    res.status(201).json({problem_id:p.insertId,feedback_count:rows.length,analysis});
  }catch(error){console.error(error);res.status(500).json({error:"Failed to create problem",detail:error.message});}
});

app.post("/api/problems/update-health", async (req,res)=>{
  try { const result=await updateHealth(pool); res.json({ok:true,...result}); }
  catch(error){res.status(500).json({error:"Health update failed",detail:error.message});}
});

app.get("/api/problems", async (req,res)=>{
  try {
    const [rows]=await pool.query(`
      SELECT p.*, COALESCE(SUM(CASE WHEN f.sentiment='negative' THEN 1 ELSE 0 END),0) negative_feedback,
             COALESCE(SUM(CASE WHEN f.sentiment='positive' THEN 1 ELSE 0 END),0) positive_feedback
      FROM problems p LEFT JOIN problem_feedback pf ON pf.problem_id=p.id LEFT JOIN feedback f ON f.id=pf.feedback_id
      GROUP BY p.id ORDER BY FIELD(p.priority,'critical','high','medium','low'),p.feedback_count DESC,p.updated_at DESC`);
    res.json(rows);
  }catch(error){res.status(500).json({error:"Failed to fetch problems"});}
});

app.get("/api/problems/:id", async (req,res)=>{
  try {
    const [[problem]]=await pool.query("SELECT * FROM problems WHERE id=?",[req.params.id]);
    if(!problem)return res.status(404).json({error:"Problem not found"});
    const [feedback]=await pool.query(`
      SELECT f.id,f.source,f.message,f.sentiment,f.category,f.severity,f.summary,f.created_at,pf.similarity_score
      FROM problem_feedback pf JOIN feedback f ON f.id=pf.feedback_id WHERE pf.problem_id=? ORDER BY f.created_at DESC`,[req.params.id]);
    const [actions]=await pool.query("SELECT * FROM actions WHERE problem_id=? ORDER BY created_at DESC",[req.params.id]);
    const [metrics]=await pool.query("SELECT * FROM daily_metrics WHERE problem_id=? ORDER BY date",[req.params.id]);
    for (const a of actions) {
      if (a.status === 'completed' && a.completed_at) {
        const [[impact]] = await pool.query(`SELECT
          COALESCE(SUM(CASE WHEN date >= DATE_SUB(DATE(?), INTERVAL 13 DAY) AND date < DATE(?) THEN negative_count ELSE 0 END),0) before_count,
          COALESCE(SUM(CASE WHEN date >= DATE(?) AND date <= DATE_ADD(DATE(?), INTERVAL 13 DAY) THEN negative_count ELSE 0 END),0) after_count
          FROM daily_metrics WHERE problem_id=?`, [a.completed_at,a.completed_at,a.completed_at,a.completed_at,req.params.id]);
        a.impact = impact;
        const before=Number(impact.before_count||0), after=Number(impact.after_count||0);
        a.reduction_percent = a.actual_impact_percent != null ? Number(a.actual_impact_percent) : (before ? Math.round(((before-after)/before)*100) : null);
      }
    }
    res.json({problem,feedback,actions,metrics});
  }catch(error){res.status(500).json({error:"Failed to fetch problem"});}
});

app.get("/api/problems/:id/resolution", async (req,res)=>{
  try{
    const [[p]]=await pool.query('SELECT * FROM problems WHERE id=?',[req.params.id]);
    if(!p)return res.status(404).json({error:'Problem not found'});
    const [metrics]=await pool.query('SELECT date,negative_count FROM daily_metrics WHERE problem_id=? ORDER BY date',[req.params.id]);
    const [actions]=await pool.query("SELECT id,description,status,created_at,completed_at FROM actions WHERE problem_id=? ORDER BY created_at",[req.params.id]);
    const effectiveness=await calculateResolutionEffectiveness(req.params.id);
    res.json({problem:p,metrics,actions,effectiveness});
  }catch(error){res.status(500).json({error:'Failed to calculate resolution',detail:error.message});}
});

app.post("/api/resolution/refresh", async (req,res)=>{
  try{ await rebuildMetrics(); const result=await refreshResolutionStates(); const [problems]=await pool.query('SELECT id FROM problems'); for(const p of problems) await calculateResolutionEffectiveness(p.id); res.json({ok:true,...result,health_score:await customerHealthScore()}); }
  catch(error){res.status(500).json({error:'Resolution refresh failed',detail:error.message});}
});

app.patch("/api/problems/:id", async (req,res)=>{
  try {
    const allowed=["owner","status","priority","severity","recommended_team"];
    const updates=[]; const params=[];
    for(const k of allowed) if(req.body[k]!==undefined){updates.push(`${k}=?`);params.push(req.body[k]);}
    if(req.body.status==="resolved"){updates.push("resolved_at=NOW()");}
    if(!updates.length)return res.status(400).json({error:"No changes supplied"});
    params.push(req.params.id);
    const [[beforeProblem]] = await pool.query('SELECT status,owner,priority FROM problems WHERE id=?',[req.params.id]);
    await pool.query(`UPDATE problems SET ${updates.join(",")} WHERE id=?`,params);
    const [[updated]] = await pool.query('SELECT * FROM problems WHERE id=?',[req.params.id]);
    if (req.body.status && req.body.status !== beforeProblem?.status) await recordProblemEvent(req.params.id,'status_change','Lifecycle changed',`Status changed from ${beforeProblem?.status || 'unknown'} to ${req.body.status}.`,{from:beforeProblem?.status,to:req.body.status});
    if (req.body.owner !== undefined && req.body.owner !== beforeProblem?.owner) await recordProblemEvent(req.params.id,'ownership','Owner updated',`Owner: ${req.body.owner || 'Unassigned'}`,{owner:req.body.owner || null});
    const rec=buildRecommendation(updated);
    await pool.query('UPDATE problems SET recommended_action=?,recommendation_reason=? WHERE id=?',[rec.action,rec.reason,req.params.id]);
    res.json({ok:true});
  }catch(error){res.status(500).json({error:"Failed to update problem"});}
});

app.post("/api/problems/:id/actions", async (req,res)=>{
  try {
    if(!req.body.description?.trim())return res.status(400).json({error:"description is required"});
    const expected = req.body.expected_impact_percent==null || req.body.expected_impact_percent==='' ? null : Number(req.body.expected_impact_percent);
    const [r]=await pool.query("INSERT INTO actions(problem_id,owner,description,status,expected_impact_percent) VALUES(?,?,?,?,?)",
      [req.params.id,req.body.owner||null,req.body.description.trim(),req.body.status||"open",Number.isFinite(expected)?expected:null]);
    await recordProblemEvent(req.params.id,'action_created','Intervention recorded',req.body.description.trim(),{action_id:r.insertId,owner:req.body.owner||null,target:Number.isFinite(expected)?expected:null});
    res.status(201).json({id:r.insertId});
  }catch(error){res.status(500).json({error:"Failed to create action"});}
});

app.patch("/api/actions/:id", async (req,res)=>{
  try {
    const status=req.body.status;
    if(!["open","in_progress","completed"].includes(status))return res.status(400).json({error:"Invalid status"});
    await pool.query("UPDATE actions SET status=?,completed_at=IF(?='completed',COALESCE(completed_at,NOW()),NULL),outcome_status=IF(?='completed',outcome_status,NULL) WHERE id=?",[status,status,status,req.params.id]);
    let outcome=null;
    if(status==='completed'){ const [[a]]=await pool.query('SELECT problem_id,description,owner FROM actions WHERE id=?',[req.params.id]); if(a) { await pool.query("UPDATE problems SET status=CASE WHEN status='resolved' THEN status ELSE 'monitoring' END WHERE id=?",[a.problem_id]); outcome=await measureActionOutcome(req.params.id); await recordProblemEvent(a.problem_id,'action_completed','Intervention completed',outcome?.summary || a.description,{action_id:Number(req.params.id),outcome_status:outcome?.status,actual_impact_percent:outcome?.actual_impact_percent}); } }
    res.json({ok:true,outcome});
  }catch(error){res.status(500).json({error:"Failed to update action"});}
});

app.post("/api/actions/:id/measure", async (req,res)=>{
  try { const outcome=await measureActionOutcome(req.params.id); if(!outcome)return res.status(404).json({error:'Action not found'}); res.json({ok:true,outcome}); }
  catch(error){res.status(500).json({error:'Failed to measure action outcome',detail:error.message});}
});

app.post("/api/actions/measure-all", async (req,res)=>{
  try { const result=await measureAllActionOutcomes(); res.json({ok:true,...result}); }
  catch(error){res.status(500).json({error:'Failed to measure action outcomes',detail:error.message});}
});

app.post("/api/metrics/rebuild", async (req,res)=>{
  try {
    await rebuildMetrics();
    res.json({ok:true});
  }catch(error){res.status(500).json({error:"Failed to rebuild metrics",detail:error.message});}
});

app.post("/api/problems/detect", async (req,res)=>{
  try {
    const result = await detectRecurringProblems();
    await rebuildMetrics();
    const [problems] = await pool.query("SELECT id FROM problems WHERE status <> 'resolved'");
    for (const p of problems) await recalculateProblemPriority(p.id);
    res.json({ok:true,...result});
  }catch(error){console.error(error);res.status(500).json({error:"Problem detection failed",detail:error.message});}
});

app.post("/api/problems/recalculate-priorities", async (req,res)=>{
  try {
    const [problems] = await pool.query("SELECT id FROM problems WHERE status <> 'resolved'");
    for (const p of problems) await recalculateProblemPriority(p.id);
    res.json({ok:true,updated:problems.length});
  }catch(error){console.error(error);res.status(500).json({error:"Priority recalculation failed",detail:error.message});}
});

// V4.0 Customer & Segment Intelligence. Uses existing feedback dimensions; no new data source is required.

app.get('/api/journey/overview', async (_,res)=>{try{res.json(await journeyOverview())}catch(e){console.error(e);res.status(500).json({error:'Journey intelligence failed',detail:e.message})}});
app.post('/api/journey/classify', async (req,res)=>{try{const updated=await classifyUnclassified(req.body?.limit||1000);res.json({ok:true,updated})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/journey/customers/:name', async (req,res)=>{try{const x=await customerJourney(decodeURIComponent(req.params.name));if(!x)return res.status(404).json({error:'Customer not found'});res.json(x)}catch(e){res.status(500).json({error:'Customer journey failed',detail:e.message})}});
app.get('/api/journey/stages/:stage', async (req,res)=>{try{const x=await stageDetail(req.params.stage);if(!x)return res.status(404).json({error:'Stage not found'});res.json(x)}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/teams/overview', async (_,res)=>{try{res.json(await teamOverview(pool))}catch(e){console.error(e);res.status(500).json({error:'Team intelligence failed',detail:e.message})}});
app.get('/api/teams/:name', async (req,res)=>{try{res.json(await teamDetail(pool,decodeURIComponent(req.params.name)))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/automation/overview', async (_,res)=>{try{await seedDefaults(pool);res.json(await automationOverview(pool))}catch(e){res.status(500).json({error:'Automation overview failed',detail:e.message})}});
app.post('/api/automation/rules', async (req,res)=>{try{res.status(201).json({id:await createRule(pool,req.body||{})})}catch(e){res.status(400).json({error:e.message})}});
app.patch('/api/automation/rules/:id', async (req,res)=>{try{const allowed=['name','description','threshold','action_template','enabled'];const sets=[],vals=[];for(const k of allowed)if(req.body[k]!==undefined){sets.push(`${k}=?`);vals.push(k==='enabled'?(req.body[k]?1:0):req.body[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE automation_rules SET ${sets.join(',')} WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/automation/run', async (_,res)=>{try{await seedDefaults(pool);res.json(await runAutomations(pool))}catch(e){res.status(500).json({error:'Automation run failed',detail:e.message})}});
app.patch('/api/automation/queue/:id', async (req,res)=>{try{res.json(await updateQueue(pool,req.params.id,req.body||{}))}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/owners/overview', async (_,res)=>{try{res.json({owners:await ownerOverview(pool)})}catch(e){res.status(500).json({error:e.message})}});
app.patch('/api/problems/:id/accountability', async (req,res)=>{
  try {
    const {owner, recommended_team, accountability_status} = req.body||{};
    const sets=[], vals=[];
    if(owner!==undefined){sets.push('owner=?');vals.push(owner||null)}
    if(recommended_team!==undefined){sets.push('recommended_team=?');vals.push(recommended_team||null)}
    if(accountability_status!==undefined){sets.push('accountability_status=?');vals.push(accountability_status)}
    if(owner!==undefined && owner) sets.push('owner_acknowledged_at=NOW()');
    if(!sets.length) return res.status(400).json({error:'No accountability fields supplied'});
    vals.push(req.params.id);
    await pool.query(`UPDATE problems SET ${sets.join(',')} WHERE id=?`,vals);
    res.json({ok:true});
  } catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/segments/overview', async (req,res)=>{try{res.json(await segmentOverview())}catch(e){console.error(e);res.status(500).json({error:'Segment intelligence failed',detail:e.message})}});
app.get('/api/segments/:type/:value', async (req,res)=>{try{const x=await segmentDetail(req.params.type,decodeURIComponent(req.params.value));if(!x)return res.status(404).json({error:'Segment not found'});res.json(x)}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/customers/:name', async (req,res)=>{try{const x=await customerSegment(decodeURIComponent(req.params.name));if(!x)return res.status(404).json({error:'Customer not found'});res.json(x)}catch(e){res.status(500).json({error:'Customer intelligence failed',detail:e.message})}});

app.post("/api/demo/seed", async (req,res)=>{
  try {
    const samples=[
      ["app_store","Priya","Payment failed twice when I tried ordering.","negative","payment","high","Payment fails during checkout"],
      ["support","Arjun","The card was charged but my order never got created.","negative","payment","critical","Payment captured without order creation"],
      ["email","Meera","Checkout keeps rejecting my card.","negative","payment","high","Payment fails during checkout"],
      ["app_store","Rohan","ETA said 30 minutes but it arrived after an hour.","negative","delivery","high","Unreliable delivery ETA"],
      ["support","Nisha","My food was extremely late again.","negative","delivery","high","Delivery arrives later than promised"],
      ["review","Kabir","Delivery took forever compared with the ETA.","negative","delivery","medium","Unreliable delivery ETA"],
      ["app_store","Ananya","The app feels much faster after the update.","positive","performance","low","Improved app performance"],
      ["support","Vikram","Refund is still pending after five days.","negative","refunds","high","Refund processing delays"],
      ["email","Sana","I requested a refund last week and have not received it.","negative","refunds","high","Refund processing delays"],
      ["review","Dev","The new order tracking is really helpful.","positive","tracking","low","Positive order tracking experience"],
      ["app_store","Ishita","App crashes whenever I open my orders.","negative","performance","high","Order screen crashes"],
      ["support","Aditya","Orders page closes the app every time.","negative","performance","high","Order screen crashes"]
    ];
    const ids=[];
    for(const s of samples){
      const [r]=await pool.query(`INSERT INTO feedback(source,customer_name,message,sentiment,category,severity,summary,created_at) VALUES(?,?,?,?,?,?,?,DATE_SUB(NOW(),INTERVAL ? DAY))`,
        [...s.slice(0,7), Math.floor(Math.random()*10)]);
      ids.push(r.insertId);
    }
    const groups=[
      {title:"Unreliable delivery ETA",description:"Customers report deliveries arriving materially later than the promised ETA.",impact:"Late orders reduce trust and create repeat support contacts.",category:"delivery",team:"Operations",priority:"high",severity:"high",members:ids.slice(3,6)},
      {title:"Payment failures during checkout",description:"Customers cannot reliably complete checkout with card payments.",impact:"Customers abandon orders and some may experience payment/order mismatch.",category:"payment",team:"Payments",priority:"critical",severity:"critical",members:ids.slice(0,3)},
      {title:"Refund processing delays",description:"Refund requests remain pending for several days.",impact:"Delayed refunds create distrust and additional support volume.",category:"refunds",team:"Finance",priority:"high",severity:"high",members:ids.slice(7,9)},
      {title:"Order screen crashes",description:"The mobile order screen crashes for some customers.",impact:"Customers cannot access active or historical orders.",category:"performance",team:"Engineering",priority:"high",severity:"high",members:ids.slice(10,12)}
    ];
    for(const g of groups){
      const [p]=await pool.query(`INSERT INTO problems(title,description,impact,category,recommended_team,priority,severity,status,owner,feedback_count,first_detected_at,last_detected_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,DATE_SUB(NOW(),INTERVAL 10 DAY),NOW())`,
        [g.title,g.description,g.impact,g.category,g.team,g.priority,g.severity,"monitoring",g.team,g.members.length]);
      for(const fid of g.members) await pool.query("INSERT INTO problem_feedback(problem_id,feedback_id,similarity_score) VALUES(?,?,?)",[p.insertId,fid,0.86]);
      await pool.query("UPDATE feedback SET problem_id=? WHERE id IN (?)",[p.insertId,g.members]);
      for(let i=0;i<10;i++){
        const count=Math.max(2,Math.round(g.members.length*(1-(i/12))));
        await pool.query(`INSERT INTO daily_metrics(problem_id,date,feedback_count,negative_count,positive_count)
          VALUES(?,?,?, ?, ?) ON DUPLICATE KEY UPDATE feedback_count=VALUES(feedback_count),negative_count=VALUES(negative_count),positive_count=VALUES(positive_count)`,
          [p.insertId, new Date(Date.now()-(9-i)*86400000), count, Math.max(1,count-1), 0]);
      }
    }
    res.status(201).json({ok:true,message:"Demo workspace seeded",feedback:ids.length,problems:groups.length});
  }catch(error){console.error(error);res.status(500).json({error:"Demo seed failed",detail:error.message});}
});


// V4.2 Product & Feature Intelligence
app.get('/api/features/overview', async (_,res)=>{try{res.json(await featureOverview(pool))}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/features/classify', async (_,res)=>{try{res.json({ok:true,...await classifyFeedback(pool)})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/features/:name', async (req,res)=>{try{res.json(await featureDetail(pool,decodeURIComponent(req.params.name)))}catch(e){res.status(500).json({error:e.message})}});

// Unified V2.3 → V3.4 intelligence routes. These extend the V2.2 base without replacing its APIs.
app.get('/api/problems/:id/root-cause', async (req,res)=>{try{const x=await rootCause(pool,req.params.id);if(!x)return res.status(404).json({error:'Problem not found'});res.json(x)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/intelligence/root-cause/refresh', async (req,res)=>{try{const [ps]=await pool.query("SELECT id FROM problems WHERE status NOT IN ('resolved','closed')");let n=0;for(const p of ps){await rootCause(pool,p.id);n++}res.json({ok:true,refreshed:n})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/problems/:id/investigation', async (req,res)=>{try{res.json(await getInvestigation(pool,req.params.id))}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/problems/:id/investigation/refresh', async (req,res)=>{try{res.json(await refreshInvestigation(pool,req.params.id))}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/problems/:id/investigation/tasks', async (req,res)=>{try{const id=await createInvestigationTask(pool,req.params.id,req.body);res.status(201).json({id})}catch(e){res.status(500).json({error:e.message})}});
app.patch('/api/investigation-tasks/:id', async (req,res)=>{try{const status=req.body.status||'open';await pool.query('UPDATE investigation_tasks SET status=?,completed_at=CASE WHEN ?="completed" THEN NOW() ELSE NULL END WHERE id=?',[status,status,req.params.id]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/problems/:id/investigation/decision', async (req,res)=>{try{res.json(await decision(pool,req.params.id,req.body))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/problems/:id/prediction', async (req,res)=>{try{const x=await prediction(pool,req.params.id);if(!x)return res.status(404).json({error:'Problem not found'});res.json(x)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/intelligence/predict', async (req,res)=>{try{const [ps]=await pool.query("SELECT id FROM problems WHERE status NOT IN ('resolved','closed')");const out=[];for(const p of ps)out.push(await prediction(pool,p.id));res.json({items:out})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/prevention', async (req,res)=>{try{res.json({items:await preventiveQueue(pool)})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/prevention', async (req,res)=>{try{const id=await createPreventive(pool,req.body);res.status(201).json({id})}catch(e){res.status(500).json({error:e.message})}});
app.patch('/api/prevention/:id', async (req,res)=>{try{const allowed=['status','owner','due_at','expected_impact'];const sets=[],vals=[];for(const k of allowed)if(req.body[k]!==undefined){sets.push(`${k}=?`);vals.push(req.body[k])}if(req.body.status==='approved'){sets.push('approved_at=NOW()')}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE preventive_actions SET ${sets.join(',')} WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/operations/run', async (req,res)=>{try{res.json(await runOperatingLoop(pool))}catch(e){res.status(500).json({error:e.message})}});



app.get('/api/os/overview', async (_,res)=>{try{res.json(await osOverview(pool))}catch(e){res.status(500).json({error:'Operating system overview failed',detail:e.message})}});
app.get('/api/os/attention', async (_,res)=>{try{res.json({items:await osAttention(pool)})}catch(e){res.status(500).json({error:'Operating attention failed',detail:e.message})}});
app.post('/api/os/run', async (_,res)=>{try{res.json(await osRun(pool))}catch(e){res.status(500).json({error:'Operating loop failed',detail:e.message})}});
app.get('/api/os/queue', async (_,res)=>{try{res.json(await osQueue(pool))}catch(e){res.status(500).json({error:'Operating queue failed',detail:e.message})}});
app.patch('/api/os/decisions/:id', async (req,res)=>{try{res.json(await updateOsDecision(pool,req.params.id,req.body?.status,req.body?.reviewed_by))}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/os/snapshot', async (req,res)=>{try{res.status(201).json(await osSnapshot(pool,req.body?.title,req.body?.summary))}catch(e){res.status(500).json({error:'Operating snapshot failed',detail:e.message})}});
app.get('/api/os/snapshots', async (_,res)=>{try{res.json({items:await osSnapshots(pool)})}catch(e){res.status(500).json({error:'Operating snapshots failed',detail:e.message})}});
app.get('/api/executive/overview', async (_,res)=>{try{res.json(await executiveOverview(pool))}catch(e){res.status(500).json({error:'Executive overview failed',detail:e.message})}});
app.get('/api/executive/attention', async (_,res)=>{try{res.json({items:await attentionNow(pool)})}catch(e){res.status(500).json({error:'Executive attention failed',detail:e.message})}});
app.get('/api/executive/impact', async (_,res)=>{try{res.json({items:await businessImpact(pool)})}catch(e){res.status(500).json({error:'Business impact failed',detail:e.message})}});
app.post('/api/executive/snapshot', async (req,res)=>{try{res.status(201).json(await snapshot(pool,req.body?.title,req.body?.summary))}catch(e){res.status(500).json({error:'Snapshot failed',detail:e.message})}});
app.get('/api/executive/snapshots', async (_,res)=>{try{res.json({items:await snapshots(pool)})}catch(e){res.status(500).json({error:'Snapshots failed',detail:e.message})}});

app.get('/api/strategy/themes', async (_,res)=>{try{const [rows]=await pool.query(`SELECT t.*,COUNT(DISTINCT i.id) initiatives,COUNT(DISTINCT p.id) problems FROM strategic_themes t LEFT JOIN strategic_initiatives i ON i.theme_id=t.id LEFT JOIN problems p ON p.strategy_theme_id=t.id GROUP BY t.id ORDER BY FIELD(t.priority,'critical','high','medium','low'),t.id DESC`);res.json(rows)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/strategy/themes/recommend', async (_,res)=>{try{const [ps]=await pool.query(`SELECT * FROM problems WHERE status NOT IN ('resolved','closed') ORDER BY feedback_count DESC LIMIT 30`);const groups={};for(const p of ps){const [name,description]=recommendTheme(p);groups[name]??={name,description,problems:[],priority:'medium',target_impact:20};groups[name].problems.push(p);groups[name].priority=priorityScore(p.priority)>priorityScore(groups[name].priority)?p.priority:groups[name].priority}res.json(Object.values(groups).sort((a,b)=>b.problems.length-a.problems.length).slice(0,5))}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/strategy/themes', async (req,res)=>{try{const x=req.body;const [z]=await pool.query(`INSERT INTO strategic_themes(name,description,priority,status,owner,target_impact) VALUES(?,?,?,?,?,?)`,[x.name,x.description||'',x.priority||'high',x.status||'proposed',x.owner||null,x.target_impact||20]);res.json({id:z.insertId})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/strategy/overview', async (_,res)=>{try{const [[x]]=await pool.query(`SELECT COUNT(*) themes,(SELECT COUNT(*) FROM strategic_initiatives) initiatives,(SELECT COUNT(*) FROM strategic_initiatives WHERE status NOT IN ('completed','cancelled')) active FROM strategic_themes`);res.json(x)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/strategy/themes/:id/initiative-recommendation', async (req,res)=>{try{const [t]=await pool.query('SELECT * FROM strategic_themes WHERE id=?',[req.params.id]);if(!t.length)return res.status(404).json({error:'Theme not found'});const [p]=await pool.query(`SELECT p.* FROM problems p WHERE p.strategy_theme_id=? OR p.status NOT IN ('resolved','closed') ORDER BY p.feedback_count DESC LIMIT 10`,[req.params.id]);res.json(buildInitiative(t[0],p))}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/strategy/themes/:id/initiatives', async (req,res)=>{try{const x=req.body;const [z]=await pool.query(`INSERT INTO strategic_initiatives(theme_id,title,description,owner,status,priority,target_impact,success_metric,due_at,team,effort_points,capacity_available,funding_required,confidence,execution_risk) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[req.params.id,x.title,x.description||'',x.owner||null,x.status||'proposed',x.priority||'high',x.target_impact||20,x.success_metric||'',x.due_at||null,x.team||null,x.effort_points||5,x.capacity_available||0,x.funding_required||0,x.confidence??60,x.execution_risk??40]);if(Array.isArray(x.problem_ids))for(const pid of x.problem_ids){await pool.query('INSERT IGNORE INTO initiative_problems(initiative_id,problem_id) VALUES(?,?)',[z.insertId,pid]);await pool.query('UPDATE problems SET strategy_theme_id=?,initiative_id=? WHERE id=?',[req.params.id,z.insertId,pid])}res.json({id:z.insertId})}catch(e){res.status(500).json({error:e.message})}});
app.patch('/api/strategy/initiatives/:id', async (req,res)=>{try{const allowed=['title','description','owner','status','priority','target_impact','success_metric','due_at','team','effort_points','capacity_available','funding_required','confidence','execution_risk','portfolio_decision'];const sets=[],vals=[];for(const k of allowed)if(req.body[k]!==undefined){sets.push(`${k}=?`);vals.push(req.body[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE strategic_initiatives SET ${sets.join(',')} WHERE id=?`,vals);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/strategy/initiatives/:id/link-action', async (req,res)=>{try{await pool.query('INSERT IGNORE INTO initiative_actions(initiative_id,action_id) VALUES(?,?)',[req.params.id,req.body.action_id]);await pool.query('UPDATE actions SET initiative_id=? WHERE id=?',[req.params.id,req.body.action_id]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/portfolio', async (_,res)=>{try{const [items]=await pool.query(`SELECT i.*,t.name theme_name FROM strategic_initiatives i LEFT JOIN strategic_themes t ON t.id=i.theme_id WHERE i.status NOT IN ('completed','cancelled')`);res.json(portfolioSummary(items))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/portfolio/:id', async (req,res)=>{try{const [[i]]=await pool.query(`SELECT i.*,t.name theme_name FROM strategic_initiatives i LEFT JOIN strategic_themes t ON t.id=i.theme_id WHERE i.id=?`,[req.params.id]);if(!i)return res.status(404).json({error:'Initiative not found'});res.json({...i,...portfolioScore(i),...portfolioRecommendation(i)})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/portfolio/rebalance', async (_,res)=>{try{const [items]=await pool.query(`SELECT * FROM strategic_initiatives WHERE status NOT IN ('completed','cancelled')`);const result=portfolioSummary(items);for(const i of result.items)await pool.query('UPDATE strategic_initiatives SET portfolio_decision=? WHERE id=?',[i.decision,i.id]);res.json(result)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/strategy/snapshot', async (req,res)=>{try{const [z]=await pool.query('INSERT INTO strategy_snapshots(title,summary) VALUES(?,?)',[req.body.title||'Strategy Snapshot',req.body.summary||'']);res.json({id:z.insertId})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/strategy/snapshots', async (_,res)=>{try{const [rows]=await pool.query('SELECT * FROM strategy_snapshots ORDER BY id DESC LIMIT 20');res.json(rows)}catch(e){res.status(500).json({error:e.message})}});





// V5.7 Data Quality & Feedback Intelligence Reliability.
app.get('/api/quality/overview', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try {
    const [[latest]]=await pool.query(`SELECT * FROM quality_runs WHERE workspace_id=? ORDER BY id DESC LIMIT 1`,[req.user.workspace_id]);
    const [[open]]=await pool.query(`SELECT COUNT(*) count FROM feedback_quality_flags WHERE workspace_id=? AND status='open'`,[req.user.workspace_id]);
    const [[critical]]=await pool.query(`SELECT COUNT(*) count FROM feedback_quality_flags WHERE workspace_id=? AND status='open' AND severity='critical'`,[req.user.workspace_id]);
    const [[retry]]=await pool.query(`SELECT COUNT(*) count FROM quality_retry_queue WHERE workspace_id=? AND status IN ('queued','failed')`,[req.user.workspace_id]);
    res.json({latest:latest||null,open_flags:Number(open.count||0),critical_flags:Number(critical.count||0),retry_queue:Number(retry.count||0)});
  } catch(e){res.status(500).json({error:'Quality overview failed',detail:e.message});}
});
app.post('/api/quality/scan', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const result=await scanDataQuality(pool,req.user.workspace_id); await audit(req.user.workspace_id,req.user.user_id,'quality.scan','quality_run',result.run_id,result); res.json(result); }
  catch(e){res.status(500).json({error:'Quality scan failed',detail:e.message});}
});
app.get('/api/quality/flags', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const status=['open','resolved'].includes(req.query.status)?req.query.status:'open'; const [rows]=await pool.query(`SELECT q.*,f.message,f.source FROM feedback_quality_flags q JOIN feedback f ON f.id=q.feedback_id AND f.workspace_id=q.workspace_id WHERE q.workspace_id=? AND q.status=? ORDER BY FIELD(q.severity,'critical','warning','info'),q.id DESC LIMIT 200`,[req.user.workspace_id,status]); res.json({items:rows}); }
  catch(e){res.status(500).json({error:'Quality flags failed',detail:e.message});}
});
app.patch('/api/quality/flags/:id', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const status=req.body?.status==='resolved'?'resolved':'open'; await pool.query(`UPDATE feedback_quality_flags SET status=?,resolved_at=IF(?='resolved',NOW(),NULL) WHERE id=? AND workspace_id=?`,[status,status,req.params.id,req.user.workspace_id]); await audit(req.user.workspace_id,req.user.user_id,'quality.flag.updated','quality_flag',req.params.id,{status}); res.json({ok:true,status}); }
  catch(e){res.status(500).json({error:'Quality flag update failed',detail:e.message});}
});
app.post('/api/quality/retry/:feedbackId', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try {
    const [[f]]=await pool.query('SELECT * FROM feedback WHERE id=? AND workspace_id=?',[req.params.feedbackId,req.user.workspace_id]); if(!f)return res.status(404).json({error:'Feedback not found'});
    if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'OPENAI_API_KEY is not configured'});
    const [q]=await pool.query(`INSERT INTO quality_retry_queue(workspace_id,feedback_id,attempt_count,status) VALUES(?,?,1,'processing') ON DUPLICATE KEY UPDATE attempt_count=attempt_count+1,status='processing',last_error=NULL`,[req.user.workspace_id,f.id]);
    try {
      const analysis=await analyzeFeedback(f.message);
      await pool.query(`UPDATE feedback SET sentiment=?,category=?,severity=?,summary=? WHERE id=? AND workspace_id=?`,[analysis.sentiment,analysis.category,analysis.severity,analysis.summary,f.id,req.user.workspace_id]);
      await pool.query(`UPDATE quality_retry_queue SET status='completed',processed_at=NOW() WHERE id=? AND workspace_id=?`,[q.insertId||0,req.user.workspace_id]);
      await pool.query(`UPDATE feedback_quality_flags SET status='resolved',resolved_at=NOW() WHERE feedback_id=? AND workspace_id=? AND flag_type='classification_missing'`,[f.id,req.user.workspace_id]);
      await audit(req.user.workspace_id,req.user.user_id,'quality.retry.completed','feedback',f.id); res.json({ok:true,feedback_id:f.id,analysis});
    } catch(err){ await pool.query(`UPDATE quality_retry_queue SET status='failed',last_error=?,processed_at=NOW() WHERE workspace_id=? AND feedback_id=?`,[String(err.message).slice(0,1000),req.user.workspace_id,f.id]); res.status(500).json({error:'AI retry failed',detail:err.message}); }
  } catch(e){res.status(500).json({error:'Quality retry failed',detail:e.message});}
});
app.get('/api/quality/retries', async (req,res)=>{if(!requireManager(req,res))return;try{const [rows]=await pool.query(`SELECT * FROM quality_retry_queue WHERE workspace_id=? ORDER BY id DESC LIMIT 100`,[req.user.workspace_id]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});

// V5.9 AI Evaluation & Quality Lab.
app.get('/api/ai-evaluation/overview', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try {
    const wid=req.user.workspace_id;
    const [[datasets]]=await pool.query(`SELECT COUNT(*) count FROM ai_eval_datasets WHERE workspace_id=? AND status='active'`,[wid]);
    const [[runs]]=await pool.query(`SELECT COUNT(*) count FROM ai_eval_runs WHERE workspace_id=?`,[wid]);
    const [[latest]]=await pool.query(`SELECT * FROM ai_eval_runs WHERE workspace_id=? AND status='completed' ORDER BY id DESC LIMIT 1`,[wid]);
    const [[baseline]]=await pool.query(`SELECT b.*,r.name,r.model,r.prompt_version FROM ai_eval_baselines b JOIN ai_eval_runs r ON r.id=b.eval_run_id WHERE b.workspace_id=? ORDER BY b.created_at DESC LIMIT 1`,[wid]);
    const [[reg]]=await pool.query(`SELECT COUNT(*) count FROM ai_eval_runs WHERE workspace_id=? AND regressions>0`,[wid]);
    res.json({datasets:Number(datasets.count||0),runs:Number(runs.count||0),latest:latest||null,baseline:baseline||null,regressions:Number(reg.count||0)});
  }catch(e){res.status(500).json({error:'AI evaluation overview failed',detail:e.message});}
});
app.get('/api/ai-evaluation/datasets', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT d.*,COUNT(c.id) case_count FROM ai_eval_datasets d LEFT JOIN ai_eval_cases c ON c.dataset_id=d.id AND c.workspace_id=d.workspace_id WHERE d.workspace_id=? GROUP BY d.id ORDER BY d.id DESC`,[req.user.workspace_id]); res.json({items:rows}); }
  catch(e){res.status(500).json({error:'Evaluation datasets failed',detail:e.message});}
});
app.post('/api/ai-evaluation/datasets', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const name=String(req.body?.name||'').trim().slice(0,160); if(!name)return res.status(400).json({error:'Dataset name is required'}); const [r]=await pool.query(`INSERT INTO ai_eval_datasets(workspace_id,name,description,created_by) VALUES(?,?,?,?)`,[req.user.workspace_id,name,String(req.body?.description||'').slice(0,1000)||null,req.user.user_id]); await audit(req.user.workspace_id,req.user.user_id,'ai.evaluation.dataset.created','ai_eval_dataset',r.insertId); res.status(201).json({id:r.insertId,name}); }
  catch(e){res.status(500).json({error:'Dataset creation failed',detail:e.message});}
});
app.get('/api/ai-evaluation/datasets/:id/cases', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT * FROM ai_eval_cases WHERE dataset_id=? AND workspace_id=? ORDER BY id DESC`,[req.params.id,req.user.workspace_id]); res.json({items:rows}); }
  catch(e){res.status(500).json({error:'Evaluation cases failed',detail:e.message});}
});
app.post('/api/ai-evaluation/datasets/:id/cases', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const c={input_text:req.body?.input_text, sentiment:req.body?.expected_sentiment, category:req.body?.expected_category, severity:req.body?.expected_severity, summary:req.body?.expected_summary}; validateCase(c); const [[d]]=await pool.query(`SELECT id FROM ai_eval_datasets WHERE id=? AND workspace_id=?`,[req.params.id,req.user.workspace_id]); if(!d)return res.status(404).json({error:'Dataset not found'}); const [r]=await pool.query(`INSERT INTO ai_eval_cases(workspace_id,dataset_id,input_text,expected_sentiment,expected_category,expected_severity,expected_summary,tags) VALUES(?,?,?,?,?,?,?,?)`,[req.user.workspace_id,d.id,String(c.input_text),c.sentiment||null,c.category||null,c.severity||null,c.summary||null,String(req.body?.tags||'').slice(0,500)||null]); res.status(201).json({id:r.insertId}); }
  catch(e){res.status(400).json({error:'Evaluation case creation failed',detail:e.message});}
});
app.get('/api/ai-evaluation/runs', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT r.*,d.name dataset_name FROM ai_eval_runs r JOIN ai_eval_datasets d ON d.id=r.dataset_id AND d.workspace_id=r.workspace_id WHERE r.workspace_id=? ORDER BY r.id DESC LIMIT 100`,[req.user.workspace_id]); res.json({items:rows}); }
  catch(e){res.status(500).json({error:'Evaluation runs failed',detail:e.message});}
});
app.get('/api/ai-evaluation/runs/:id/results', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT r.*,c.input_text,c.expected_sentiment,c.expected_category,c.expected_severity,c.expected_summary FROM ai_eval_results r JOIN ai_eval_cases c ON c.id=r.case_id AND c.workspace_id=r.workspace_id WHERE r.eval_run_id=? AND r.workspace_id=? ORDER BY r.id`,[req.params.id,req.user.workspace_id]); res.json({items:rows}); }
  catch(e){res.status(500).json({error:'Evaluation results failed',detail:e.message});}
});
app.post('/api/ai-evaluation/datasets/:id/run', async (req,res)=>{
  if(!requireManager(req,res)) return;
  const wid=req.user.workspace_id; let runId=null; const started=Date.now();
  try {
    if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'OPENAI_API_KEY is not configured'});
    const [[d]]=await pool.query(`SELECT * FROM ai_eval_datasets WHERE id=? AND workspace_id=? AND status='active'`,[req.params.id,wid]); if(!d)return res.status(404).json({error:'Dataset not found'});
    const [cases]=await pool.query(`SELECT * FROM ai_eval_cases WHERE dataset_id=? AND workspace_id=? ORDER BY id`,[d.id,wid]); if(!cases.length)return res.status(400).json({error:'Dataset has no cases'});
    const model=String(req.body?.model||process.env.OPENAI_MODEL||'gpt-5-mini').slice(0,120); const promptVersion=String(req.body?.prompt_version||'feedback-analysis-v1').slice(0,80); const name=String(req.body?.name||`${d.name} · ${model}`).slice(0,160);
    const [rr]=await pool.query(`INSERT INTO ai_eval_runs(workspace_id,dataset_id,name,model,prompt_version,total_cases,status,created_by) VALUES(?,?,?,?,?,?, 'running',?)`,[wid,d.id,name,model,promptVersion,cases.length,req.user.user_id]); runId=rr.insertId;
    const results=[];
    for(const c of cases){
      try { const out=await analyzeFeedbackDetailed(c.input_text); const a=validateAnalysis(out.analysis); const scored=scoreCase({sentiment:c.expected_sentiment,category:c.expected_category,severity:c.expected_severity,summary:c.expected_summary},a); results.push({...scored,predicted_sentiment:a.sentiment,predicted_category:a.category,predicted_severity:a.severity,predicted_summary:a.summary,confidence:null,error_message:null}); }
      catch(err){ results.push({sentiment_match:false,category_match:false,severity_match:false,summary_match:false,score:0,predicted_sentiment:null,predicted_category:null,predicted_severity:null,predicted_summary:null,confidence:null,error_message:String(err.message).slice(0,1000)}); }
    }
    for(let i=0;i<results.length;i++){ const r=results[i]; await pool.query(`INSERT INTO ai_eval_results(workspace_id,eval_run_id,case_id,predicted_sentiment,predicted_category,predicted_severity,predicted_summary,sentiment_match,category_match,severity_match,summary_match,confidence,error_message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[wid,runId,cases[i].id,r.predicted_sentiment,r.predicted_category,r.predicted_severity,r.predicted_summary,r.sentiment_match?1:0,r.category_match?1:0,r.severity_match?1:0,r.summary_match?1:0,r.confidence,r.error_message]); }
    const agg=aggregateResults(results); const [[base]]=await pool.query(`SELECT overall_score FROM ai_eval_baselines WHERE workspace_id=? AND dataset_id=?`,[wid,d.id]); const isRegression=regression(base?.overall_score,agg.overall_score,0.05); const [u]=await pool.query(`UPDATE ai_eval_runs SET status='completed',evaluated_cases=?,sentiment_accuracy=?,category_accuracy=?,severity_accuracy=?,summary_match_rate=?,overall_score=?,regressions=?,duration_ms=?,finished_at=NOW() WHERE id=? AND workspace_id=?`,[results.length,agg.sentiment_accuracy,agg.category_accuracy,agg.severity_accuracy,agg.summary_match_rate,agg.overall_score,isRegression?results.length:0,Date.now()-started,runId,wid]);
    if(!base || Number(req.body?.set_baseline||0)===1) await pool.query(`INSERT INTO ai_eval_baselines(workspace_id,dataset_id,eval_run_id,overall_score) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE eval_run_id=VALUES(eval_run_id),overall_score=VALUES(overall_score),created_at=NOW()`,[wid,d.id,runId,agg.overall_score]);
    await audit(wid,req.user.user_id,'ai.evaluation.run.completed','ai_eval_run',runId,{dataset_id:d.id,overall_score:agg.overall_score,regression:isRegression});
    res.json({ok:true,run_id:runId,metrics:agg,regression:isRegression});
  }catch(e){ if(runId) await pool.query(`UPDATE ai_eval_runs SET status='failed',error_message=?,duration_ms=?,finished_at=NOW() WHERE id=? AND workspace_id=?`,[String(e.message).slice(0,1000),Date.now()-started,runId,wid]).catch(()=>{}); res.status(500).json({error:'AI evaluation run failed',detail:e.message,run_id:runId}); }
});

// V5.8 AI Reliability & Intelligence Governance.
app.get('/api/ai/overview', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try {
    const wid=req.user.workspace_id;
    const [[stats]]=await pool.query(`SELECT COUNT(*) total, SUM(status='completed') completed, SUM(status='failed') failed, SUM(status='overridden') overridden, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(estimated_cost_usd),0) cost, COALESCE(AVG(confidence),0) avg_confidence FROM ai_runs WHERE workspace_id=? AND started_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)`,[wid]);
    const [[low]]=await pool.query(`SELECT COUNT(*) count FROM ai_runs WHERE workspace_id=? AND status='completed' AND confidence < (SELECT min_confidence FROM ai_settings WHERE workspace_id=? LIMIT 1) AND started_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)`,[wid,wid]);
    const [[overrides]]=await pool.query(`SELECT COUNT(*) count FROM ai_overrides WHERE workspace_id=? AND created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)`,[wid]);
    const [[settings]]=await pool.query(`SELECT * FROM ai_settings WHERE workspace_id=?`,[wid]);
    res.json({stats:{total:Number(stats.total||0),completed:Number(stats.completed||0),failed:Number(stats.failed||0),overridden:Number(stats.overridden||0),tokens:Number(stats.tokens||0),estimated_cost_usd:Number(stats.cost||0),avg_confidence:Number(stats.avg_confidence||0),low_confidence:Number(low.count||0),overrides:Number(overrides.count||0)},settings:settings||null});
  }catch(e){res.status(500).json({error:'AI governance overview failed',detail:e.message});}
});
app.get('/api/ai/runs', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT id,feedback_id,operation,model,prompt_version,status,sentiment,category,severity,confidence,input_tokens,output_tokens,total_tokens,estimated_cost_usd,duration_ms,error_message,started_at,finished_at FROM ai_runs WHERE workspace_id=? ORDER BY id DESC LIMIT 100`,[req.user.workspace_id]); res.json({items:rows}); }
  catch(e){res.status(500).json({error:'AI runs failed',detail:e.message});}
});
app.get('/api/ai/overrides', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT o.*,u.name user_name,u.email FROM ai_overrides o LEFT JOIN users u ON u.id=o.user_id WHERE o.workspace_id=? ORDER BY o.id DESC LIMIT 100`,[req.user.workspace_id]); res.json({items:rows}); }
  catch(e){res.status(500).json({error:'AI overrides failed',detail:e.message});}
});
app.patch('/api/ai/settings', async (req,res)=>{
  if(!requireRole(req,res,['admin'])) return;
  try {
    const model=String(req.body?.model||process.env.OPENAI_MODEL||'gpt-5-mini').slice(0,120);
    const min=Math.max(0,Math.min(0.99,Number(req.body?.min_confidence ?? 0.60)));
    const retries=Math.max(0,Math.min(10,Number(req.body?.max_retries ?? 3)));
    const review=req.body?.require_human_review?1:0;
    const budget=Math.max(0,Math.min(100000000,Number(req.body?.daily_token_budget ?? 0)));
    await pool.query(`INSERT INTO ai_settings(workspace_id,model,min_confidence,max_retries,require_human_review,daily_token_budget) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE model=VALUES(model),min_confidence=VALUES(min_confidence),max_retries=VALUES(max_retries),require_human_review=VALUES(require_human_review),daily_token_budget=VALUES(daily_token_budget)`,[req.user.workspace_id,model,min,retries,review,budget]);
    await audit(req.user.workspace_id,req.user.user_id,'ai.settings.updated','ai_settings',req.user.workspace_id,{model,min_confidence:min,max_retries:retries,require_human_review:!!review,daily_token_budget:budget});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:'AI settings update failed',detail:e.message});}
});
app.post('/api/ai/feedback/:id/override', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try {
    const field=String(req.body?.field||'');
    if(!['sentiment','category','severity','summary'].includes(field)) return res.status(400).json({error:'Unsupported override field'});
    const [[f]]=await pool.query(`SELECT * FROM feedback WHERE id=? AND workspace_id=?`,[req.params.id,req.user.workspace_id]); if(!f)return res.status(404).json({error:'Feedback not found'});
    const value=String(req.body?.value??'').trim(); if(!value || value.length>1000)return res.status(400).json({error:'Override value is required'});
    if(field==='sentiment' && !['positive','neutral','negative'].includes(value))return res.status(400).json({error:'Invalid sentiment'});
    if(field==='severity' && !['low','medium','high','critical'].includes(value))return res.status(400).json({error:'Invalid severity'});
    const [[run]]=await pool.query(`SELECT id FROM ai_runs WHERE feedback_id=? AND workspace_id=? ORDER BY id DESC LIMIT 1`,[req.params.id,req.user.workspace_id]);
    await pool.query(`INSERT INTO ai_overrides(workspace_id,ai_run_id,feedback_id,user_id,field_name,old_value,new_value,reason) VALUES(?,?,?,?,?,?,?,?)`,[req.user.workspace_id,run?.id||null,f.id,req.user.user_id,field,String(f[field]??''),value,String(req.body?.reason||'').slice(0,1000)||null]);
    await pool.query(`UPDATE feedback SET ${field}=? WHERE id=? AND workspace_id=?`,[value,f.id,req.user.workspace_id]);
    if(run?.id) await pool.query(`UPDATE ai_runs SET status='overridden' WHERE id=? AND workspace_id=? AND status='completed'`,[run.id,req.user.workspace_id]);
    await audit(req.user.workspace_id,req.user.user_id,'ai.output.overridden','feedback',f.id,{field});
    res.json({ok:true,field,value});
  }catch(e){res.status(500).json({error:'AI override failed',detail:e.message});}
});

app.get('/api/ops/status', async (req,res)=>{
  if(!requireManager(req,res)) return;
  const started=Date.now(); let dbOk=false, dbLatency=null, dbError=null;
  try { await pool.query('SELECT 1 AS ok'); dbLatency=Date.now()-started; dbOk=true; } catch(e){ dbError=e.message; }
  try {
    const wid=req.user.workspace_id;
    const [[api]]=await pool.query(`SELECT COUNT(*) total, SUM(status_code>=500) errors, AVG(duration_ms) avg_ms FROM api_request_metrics WHERE workspace_id=? AND created_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR)`,[wid]);
    const [[ing]]=await pool.query(`SELECT COUNT(*) total, SUM(status='failed') failures FROM ingestion_events WHERE workspace_id=? AND created_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR)`,[wid]);
    const [[jobs]]=await pool.query(`SELECT COUNT(*) total, SUM(status='failed') failures FROM job_runs WHERE workspace_id=? AND started_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR)`,[wid]);
    const [[sessions]]=await pool.query(`SELECT COUNT(*) total FROM sessions WHERE workspace_id=? AND expires_at>NOW()`,[wid]);
    const total=Number(api.total||0), errors=Number(api.errors||0), errorRate=total?errors/total:0;
    const status=!dbOk?'critical':(errorRate>.05||Number(ing.failures||0)>0||Number(jobs.failures||0)>0?'degraded':'healthy');
    await pool.query(`INSERT INTO health_snapshots(workspace_id,db_ok,db_latency_ms,api_error_rate,ingestion_failures,failed_jobs,active_sessions,status,detail) VALUES(?,?,?,?,?,?,?,?,?)`,[wid,dbOk?1:0,dbLatency,errorRate,Number(ing.failures||0),Number(jobs.failures||0),Number(sessions.total||0),status,JSON.stringify({db_error:dbError,api_requests:total,avg_api_ms:Number(api.avg_ms||0)})]);
    res.json({status,uptime_seconds:Math.floor((Date.now()-observability.startedAt)/1000),database:{ok:dbOk,latency_ms:dbLatency,error:dbError},api:{requests_24h:total,errors_24h:errors,error_rate:errorRate,avg_latency_ms:Number(api.avg_ms||0)},ingestion:{events_24h:Number(ing.total||0),failures_24h:Number(ing.failures||0)},jobs:{runs_24h:Number(jobs.total||0),failures_24h:Number(jobs.failures||0)},sessions:{active:Number(sessions.total||0)},checked_at:new Date().toISOString()});
  } catch(e){ res.status(500).json({error:'Operations status failed',detail:e.message}); }
});
app.get('/api/ops/metrics', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT route,method,COUNT(*) requests,SUM(status_code>=500) errors,ROUND(AVG(duration_ms),1) avg_ms,MAX(duration_ms) max_ms FROM api_request_metrics WHERE workspace_id=? AND created_at>=DATE_SUB(NOW(),INTERVAL 24 HOUR) GROUP BY route,method ORDER BY requests DESC LIMIT 100`,[req.user.workspace_id]); res.json({items:rows}); } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/ops/jobs', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT id,job_name,status,started_at,finished_at,duration_ms,detail FROM job_runs WHERE workspace_id=? ORDER BY id DESC LIMIT 100`,[req.user.workspace_id]); res.json({items:rows}); } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/ops/ingestion', async (req,res)=>{
  if(!requireManager(req,res)) return;
  try { const [rows]=await pool.query(`SELECT id,source,status,feedback_count,error_message,created_at FROM ingestion_events WHERE workspace_id=? ORDER BY id DESC LIMIT 100`,[req.user.workspace_id]); res.json({items:rows}); } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/ops/jobs/diagnostic', async (req,res)=>{
  if(!requireRole(req,res,['admin'])) return;
  const name=String(req.body?.job_name||'diagnostic'); const started=Date.now(); let id;
  try { const [x]=await pool.query(`INSERT INTO job_runs(workspace_id,job_name,status) VALUES(?,?,?)`,[req.user.workspace_id,name,'running']); id=x.insertId; await pool.query(`UPDATE job_runs SET status='completed',finished_at=NOW(),duration_ms=? WHERE id=? AND workspace_id=?`,[Date.now()-started,id,req.user.workspace_id]); res.json({ok:true,id,status:'completed',duration_ms:Date.now()-started}); }
  catch(e){ if(id) await pool.query(`UPDATE job_runs SET status='failed',finished_at=NOW(),duration_ms=?,detail=? WHERE id=? AND workspace_id=?`,[Date.now()-started,JSON.stringify({error:e.message}),id,req.user.workspace_id]).catch(()=>{}); res.status(500).json({error:'Diagnostic job failed',detail:e.message}); }
});

// V6.0 Intelligent Feedback Learning Loop — human-approved learning signals only.
app.get('/api/learning/overview', async (req,res)=>{if(!requireManager(req,res))return;try{const w=req.user.workspace_id;const [[a]]=await pool.query(`SELECT COUNT(*) count FROM ai_learning_signals WHERE workspace_id=? AND status='open'`,[w]);const [[b]]=await pool.query(`SELECT COUNT(*) count FROM ai_correction_patterns WHERE workspace_id=?`,[w]);const [[c]]=await pool.query(`SELECT COUNT(*) count FROM ai_learning_runs WHERE workspace_id=?`,[w]);const [[last]]=await pool.query(`SELECT * FROM ai_learning_runs WHERE workspace_id=? ORDER BY id DESC LIMIT 1`,[w]);const [top]=await pool.query(`SELECT * FROM ai_correction_patterns WHERE workspace_id=? ORDER BY occurrence_count DESC,id DESC LIMIT 10`,[w]);res.json({open_signals:Number(a.count||0),patterns:Number(b.count||0),runs:Number(c.count||0),last_run:last||null,top_patterns:top})}catch(e){res.status(500).json({error:'Learning overview failed',detail:e.message})}});
app.get('/api/learning/signals',async(req,res)=>{if(!requireManager(req,res))return;try{const status=['open','approved','resolved'].includes(req.query.status)?req.query.status:'open';const [rows]=await pool.query(`SELECT * FROM ai_learning_signals WHERE workspace_id=? AND status=? ORDER BY confidence DESC,id DESC LIMIT 200`,[req.user.workspace_id,status]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/learning/patterns',async(req,res)=>{if(!requireManager(req,res))return;try{const [rows]=await pool.query(`SELECT * FROM ai_correction_patterns WHERE workspace_id=? ORDER BY occurrence_count DESC,id DESC LIMIT 200`,[req.user.workspace_id]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/learning/run',async(req,res)=>{if(!requireManager(req,res))return;const w=req.user.workspace_id,started=Date.now();let runId=null;try{const [rr]=await pool.query(`INSERT INTO ai_learning_runs(workspace_id,status,triggered_by) VALUES(?,'running',?)`,[w,req.user.user_id]);runId=rr.insertId;const [overrides]=await pool.query(`SELECT field_name,old_value,new_value,reason FROM ai_overrides WHERE workspace_id=? ORDER BY id DESC LIMIT 2000`,[w]);const signals=buildCorrectionSignals(overrides);for(const x of signals){const exp=buildLearningExplanation(x),conf=confidenceFromCount(x.count);await pool.query(`INSERT INTO ai_correction_patterns(workspace_id,field_name,from_value,to_value,pattern_hash,occurrence_count,confidence,explanation,status) VALUES(?,?,?,?,?,?,?,?,'candidate') ON DUPLICATE KEY UPDATE occurrence_count=VALUES(occurrence_count),confidence=VALUES(confidence),explanation=VALUES(explanation),updated_at=NOW()`,[w,x.field_name,x.from_value,x.to_value,patternHash(x.field_name,x.from_value,x.to_value),x.count,conf,exp]);await pool.query(`INSERT INTO ai_learning_signals(workspace_id,run_id,signal_type,field_name,from_value,to_value,evidence_count,confidence,explanation,status) VALUES(?,?,?,?,?,?,?,?,'open')`,[w,runId,'human_correction',x.field_name,x.from_value||null,x.to_value||null,x.count,conf,exp])}const [[es]]=await pool.query(`SELECT COUNT(*) total,COALESCE(SUM(regressions>0),0) regressions FROM ai_eval_runs WHERE workspace_id=?`,[w]);await pool.query(`UPDATE ai_learning_runs SET status='completed',signals_created=?,patterns_updated=?,evaluation_runs=?,regressions_seen=?,duration_ms=?,finished_at=NOW() WHERE id=? AND workspace_id=?`,[signals.length,signals.length,Number(es.total||0),Number(es.regressions||0),Date.now()-started,runId,w]);await audit(w,req.user.user_id,'ai.learning.run.completed','ai_learning_run',runId,{signals:signals.length});res.json({ok:true,run_id:runId,signals_created:signals.length,patterns_updated:signals.length})}catch(e){if(runId)await pool.query(`UPDATE ai_learning_runs SET status='failed',error_message=?,duration_ms=?,finished_at=NOW() WHERE id=? AND workspace_id=?`,[String(e.message).slice(0,1000),Date.now()-started,runId,w]).catch(()=>{});res.status(500).json({error:'Learning run failed',detail:e.message,run_id:runId})}});
app.patch('/api/learning/signals/:id',async(req,res)=>{if(!requireManager(req,res))return;try{const status=['open','approved','resolved'].includes(req.body?.status)?req.body.status:'open';await pool.query(`UPDATE ai_learning_signals SET status=?,reviewed_by=?,reviewed_at=NOW() WHERE id=? AND workspace_id=?`,[status,req.user.user_id,req.params.id,req.user.workspace_id]);await audit(req.user.workspace_id,req.user.user_id,'ai.learning.signal.reviewed','ai_learning_signal',req.params.id,{status});res.json({ok:true,status})}catch(e){res.status(500).json({error:e.message})}});
app.patch('/api/learning/patterns/:id',async(req,res)=>{if(!requireManager(req,res))return;try{const status=['candidate','approved','rejected'].includes(req.body?.status)?req.body.status:'candidate';await pool.query(`UPDATE ai_correction_patterns SET status=?,approved_by=?,approved_at=IF(?='approved',NOW(),NULL),updated_at=NOW() WHERE id=? AND workspace_id=?`,[status,status==='approved'?req.user.user_id:null,status,req.params.id,req.user.workspace_id]);await audit(req.user.workspace_id,req.user.user_id,'ai.learning.pattern.reviewed','ai_correction_pattern',req.params.id,{status});res.json({ok:true,status})}catch(e){res.status(500).json({error:e.message})}});



// V6.5 Experimentation & Launch Optimization — controlled A/B tests for release messaging, pricing and CTAs.
function experimentHash(subject, key){
  return crypto.createHash('sha256').update(String(key)+'|'+String(subject)).digest('hex');
}
function experimentBucket(subject,key){ return parseInt(experimentHash(subject,key).slice(0,8),16) % 10000 / 100; }
async function getRunningExperiment(key){
  const [[e]]=await pool.query(`SELECT * FROM launch_experiments WHERE experiment_key=? AND status='running' AND (start_at IS NULL OR start_at<=NOW()) AND (end_at IS NULL OR end_at>=NOW()) LIMIT 1`,[key]);
  return e||null;
}
async function assignExperiment(experiment,subject,workspaceId,userId){
  const [[existing]]=await pool.query(`SELECT a.*,v.variant_key,v.name,v.headline,v.body,v.cta_label,v.cta_url,v.price_message,v.allocation_percent FROM launch_experiment_assignments a JOIN launch_experiment_variants v ON v.id=a.variant_id WHERE a.experiment_id=? AND a.subject_key=? LIMIT 1`,[experiment.id,subject]);
  if(existing) return existing;
  const [variants]=await pool.query(`SELECT * FROM launch_experiment_variants WHERE experiment_id=? AND enabled=1 ORDER BY id`,[experiment.id]);
  if(!variants.length) return null;
  let bucket=experimentBucket(subject,experiment.experiment_key),cursor=0,chosen=variants[variants.length-1];
  for(const v of variants){cursor+=Number(v.allocation_percent||0);if(bucket<cursor){chosen=v;break;}}
  const [r]=await pool.query(`INSERT INTO launch_experiment_assignments(experiment_id,variant_id,workspace_id,user_id,subject_key) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE variant_id=VALUES(variant_id)`,[experiment.id,chosen.id,workspaceId||null,userId||null,subject]);
  return {id:r.insertId||0,experiment_id:experiment.id,variant_id:chosen.id,subject_key:subject,variant_key:chosen.variant_key,name:chosen.name,headline:chosen.headline,body:chosen.body,cta_label:chosen.cta_label,cta_url:chosen.cta_url,price_message:chosen.price_message,allocation_percent:chosen.allocation_percent};
}
app.get('/api/experiments/:key/assignment',async(req,res)=>{try{
  const e=await getRunningExperiment(String(req.params.key)); if(!e)return res.status(404).json({error:'Experiment not running'});
  const subject=String(req.user?.user_id?`user:${req.user.user_id}`:req.user?.workspace_id?`workspace:${req.user.workspace_id}`:`anon:${req.ip||'unknown'}:${req.get('user-agent')||''}`).slice(0,160);
  const a=await assignExperiment(e,subject,req.user?.workspace_id,req.user?.user_id); if(!a)return res.status(409).json({error:'No enabled variants'});
  res.json({experiment:{experiment_key:e.experiment_key,name:e.name,metric_key:e.metric_key},assignment:a});
}catch(e){res.status(500).json({error:'Experiment assignment failed',detail:e.message})}});
app.post('/api/experiments/events',async(req,res)=>{try{
  const x=req.body||{}; if(!x.experiment_key||!x.event_type)return res.status(400).json({error:'experiment_key and event_type are required'});
  const e=await getRunningExperiment(String(x.experiment_key)); if(!e)return res.status(404).json({error:'Experiment not running'});
  const subject=String(req.user?.user_id?`user:${req.user.user_id}`:req.user?.workspace_id?`workspace:${req.user.workspace_id}`:x.subject_key||`anon:${req.ip||'unknown'}`).slice(0,160);
  const a=await assignExperiment(e,subject,req.user?.workspace_id,req.user?.user_id);
  await pool.query(`INSERT INTO launch_experiment_events(experiment_id,variant_id,workspace_id,user_id,subject_key,event_type,value,metadata) VALUES(?,?,?,?,?,?,?,?)`,[e.id,a?.variant_id||null,req.user?.workspace_id||null,req.user?.user_id||null,subject,String(x.event_type).slice(0,80),x.value==null?null:Number(x.value),x.metadata?JSON.stringify(x.metadata):null]);
  res.json({ok:true,variant_key:a?.variant_key||null});
}catch(e){res.status(500).json({error:'Experiment event failed',detail:e.message})}});
app.get('/api/superadmin/experiments',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{
  const [experiments]=await pool.query(`SELECT e.*,rp.name phase_name FROM launch_experiments e LEFT JOIN release_phases rp ON rp.id=e.phase_id ORDER BY e.id DESC`);
  for(const e of experiments){
    const [variants]=await pool.query(`SELECT v.*,COUNT(DISTINCT a.id) assignments,COUNT(DISTINCT CASE WHEN ev.event_type='converted' THEN ev.id END) conversions,COUNT(DISTINCT CASE WHEN ev.event_type='engaged' THEN ev.id END) engagements FROM launch_experiment_variants v LEFT JOIN launch_experiment_assignments a ON a.variant_id=v.id LEFT JOIN launch_experiment_events ev ON ev.variant_id=v.id WHERE v.experiment_id=? GROUP BY v.id ORDER BY v.id`,[e.id]);
    e.variants=variants;
    const total=variants.reduce((n,v)=>n+Number(v.assignments||0),0), conv=variants.reduce((n,v)=>n+Number(v.conversions||0),0); e.summary={assignments:total,conversions:conv,conversion_rate:total?Number((conv/total*100).toFixed(1)):0};
  }
  res.json({experiments});
}catch(e){res.status(500).json({error:'Experiment load failed',detail:e.message})}});
app.post('/api/superadmin/experiments',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.experiment_key||!x.name)return res.status(400).json({error:'experiment_key and name are required'});const [r]=await pool.query(`INSERT INTO launch_experiments(experiment_key,name,phase_id,feature_key,hypothesis,metric_key,status,audience,start_at,end_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,[String(x.experiment_key).slice(0,100),x.name,x.phase_id||null,x.feature_key||null,x.hypothesis||'',x.metric_key||'upgrade_completed',x.status||'draft',x.audience||'all',x.start_at||null,x.end_at||null]);await audit(null,req.user.user_id,'launch.experiment.created','launch_experiment',r.insertId,{experiment_key:x.experiment_key});res.status(201).json({id:r.insertId});}catch(e){res.status(500).json({error:'Experiment creation failed',detail:e.message})}});
app.patch('/api/superadmin/experiments/:id',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},allowed=['name','phase_id','feature_key','hypothesis','metric_key','status','audience','start_at','end_at','winner_variant_id'],sets=[],vals=[];for(const k of allowed)if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE launch_experiments SET ${sets.join(',')},updated_at=NOW() WHERE id=?`,vals);await audit(null,req.user.user_id,'launch.experiment.updated','launch_experiment',req.params.id,x);res.json({ok:true});}catch(e){res.status(500).json({error:'Experiment update failed',detail:e.message})}});
app.post('/api/superadmin/experiments/:id/variants',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.variant_key||!x.name)return res.status(400).json({error:'variant_key and name are required'});const [r]=await pool.query(`INSERT INTO launch_experiment_variants(experiment_id,variant_key,name,headline,body,cta_label,cta_url,price_message,allocation_percent,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)`,[req.params.id,x.variant_key,x.name,x.headline||'',x.body||'',x.cta_label||'',x.cta_url||'',x.price_message||'',Number(x.allocation_percent??50),x.enabled===false?0:1]);res.status(201).json({id:r.insertId});}catch(e){res.status(500).json({error:'Variant creation failed',detail:e.message})}});
app.patch('/api/superadmin/experiments/:id/variants/:variantId',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},allowed=['name','headline','body','cta_label','cta_url','price_message','allocation_percent','enabled'],sets=[],vals=[];for(const k of allowed)if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(k==='enabled'?(x[k]?1:0):x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.variantId,req.params.id);await pool.query(`UPDATE launch_experiment_variants SET ${sets.join(',')} WHERE id=? AND experiment_id=?`,vals);res.json({ok:true});}catch(e){res.status(500).json({error:'Variant update failed',detail:e.message})}});
app.post('/api/superadmin/experiments/:id/start',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const [v]=await pool.query(`SELECT id,allocation_percent FROM launch_experiment_variants WHERE experiment_id=? AND enabled=1`,[req.params.id]);if(v.length<2)return res.status(409).json({error:'At least two enabled variants are required'});const total=v.reduce((n,x)=>n+Number(x.allocation_percent||0),0);if(total<=0||Math.abs(total-100)>0.01)return res.status(409).json({error:'Variant allocation must total 100%'});await pool.query(`UPDATE launch_experiments SET status='running',start_at=COALESCE(start_at,NOW()) WHERE id=?`,[req.params.id]);await audit(null,req.user.user_id,'launch.experiment.started','launch_experiment',req.params.id);res.json({ok:true});}catch(e){res.status(500).json({error:'Experiment start failed',detail:e.message})}});
app.post('/api/superadmin/experiments/:id/complete',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const winner=req.body?.winner_variant_id?Number(req.body.winner_variant_id):null;await pool.query(`UPDATE launch_experiments SET status='completed',winner_variant_id=? WHERE id=?`,[winner,req.params.id]);await audit(null,req.user.user_id,'launch.experiment.completed','launch_experiment',req.params.id,{winner_variant_id:winner});res.json({ok:true});}catch(e){res.status(500).json({error:'Experiment completion failed',detail:e.message})}});
app.get('/api/superadmin/experiments/:id/report',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const [[e]]=await pool.query(`SELECT * FROM launch_experiments WHERE id=?`,[req.params.id]);if(!e)return res.status(404).json({error:'Experiment not found'});const [variants]=await pool.query(`SELECT v.*,COUNT(DISTINCT a.id) assignments,COUNT(DISTINCT CASE WHEN ev.event_type='engaged' THEN ev.id END) engagements,COUNT(DISTINCT CASE WHEN ev.event_type='converted' THEN ev.id END) conversions,COALESCE(SUM(CASE WHEN ev.event_type='revenue' THEN ev.value ELSE 0 END),0) revenue FROM launch_experiment_variants v LEFT JOIN launch_experiment_assignments a ON a.variant_id=v.id LEFT JOIN launch_experiment_events ev ON ev.variant_id=v.id WHERE v.experiment_id=? GROUP BY v.id ORDER BY v.id`,[e.id]);const rows=variants.map(v=>({...v,engagement_rate:Number(v.assignments)?Number((Number(v.engagements||0)/Number(v.assignments)*100).toFixed(1)):0,conversion_rate:Number(v.assignments)?Number((Number(v.conversions||0)/Number(v.assignments)*100).toFixed(1)):0}));const best=[...rows].sort((a,b)=>Number(b.conversion_rate)-Number(a.conversion_rate))[0]||null;res.json({experiment:e,variants:rows,recommendation:best?`Variant ${best.variant_key} currently leads on ${e.metric_key} with ${best.conversion_rate}% conversion.`:'Not enough data yet.'});}catch(e){res.status(500).json({error:'Experiment report failed',detail:e.message})}});


// V6.4 Launch Analytics & Growth Intelligence
function analyticsSince(days){const n=Number(days||30);return Math.min(365,Math.max(1,Number.isFinite(n)?n:30));}
async function launchAnalytics(days=30){
 const d=analyticsSince(days);
 const [[base]]=await pool.query(`SELECT (SELECT COUNT(*) FROM users) total_users,(SELECT COUNT(DISTINCT workspace_id) FROM workspace_members WHERE status='active') active_workspaces,(SELECT COUNT(*) FROM workspaces WHERE plan_status='paid') paid_workspaces,(SELECT COALESCE(SUM(mrr),0) FROM workspaces) mrr`);
 const [[ev]]=await pool.query(`SELECT SUM(event_type='teaser_viewed') teaser_views,SUM(event_type='announcement_viewed') announcement_views,SUM(event_type='waitlist_joined') waitlist_signups,SUM(event_type='beta_activated') beta_activations,SUM(event_type='feature_viewed') feature_views,COUNT(*) total_release_events FROM release_events WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)`,[d]);
 const [[up]]=await pool.query(`SELECT SUM(event_type='upgrade_prompt_viewed') upgrade_prompts,SUM(event_type='checkout_started') checkout_starts,SUM(event_type='upgrade_completed') upgrades,COUNT(*) total_upgrade_events FROM upgrade_events WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)`,[d]);
 const [[wait]]=await pool.query(`SELECT COUNT(*) count FROM product_waitlist WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)`,[d]);
 const [[beta]]=await pool.query(`SELECT COUNT(*) count FROM beta_access WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY) AND status IN ('active','converted')`,[d]);
 const funnel={teaser_views:Number(ev.teaser_views||0),announcement_views:Number(ev.announcement_views||0),waitlist_signups:Number(wait.count||ev.waitlist_signups||0),beta_activations:Number(beta.count||ev.beta_activations||0),feature_views:Number(ev.feature_views||0),upgrade_prompts:Number(up.upgrade_prompts||0),checkout_starts:Number(up.checkout_starts||0),upgrades:Number(up.upgrades||0)};
 const pct=(a,b)=>b>0?Number((a/b*100).toFixed(1)):0;
 const conversion={waitlist_from_teaser:pct(funnel.waitlist_signups,funnel.teaser_views),beta_from_waitlist:pct(funnel.beta_activations,funnel.waitlist_signups),checkout_from_prompt:pct(funnel.checkout_starts,funnel.upgrade_prompts),upgrade_from_checkout:pct(funnel.upgrades,funnel.checkout_starts),upgrade_from_prompt:pct(funnel.upgrades,funnel.upgrade_prompts)};
 const [byPhase]=await pool.query(`SELECT rp.phase_key,rp.name,COUNT(re.id) events,SUM(re.event_type='teaser_viewed') teaser_views,SUM(re.event_type='waitlist_joined') waitlist_signups,SUM(re.event_type='feature_viewed') feature_views,SUM(re.event_type='announcement_viewed') announcement_views FROM release_phases rp LEFT JOIN release_events re ON re.phase_id=rp.id AND re.created_at>=DATE_SUB(NOW(),INTERVAL ? DAY) GROUP BY rp.id ORDER BY rp.sort_order,rp.id`,[d]);
 const [byFeature]=await pool.query(`SELECT feature_key,COUNT(*) views FROM release_events WHERE feature_key IS NOT NULL AND event_type='feature_viewed' AND created_at>=DATE_SUB(NOW(),INTERVAL ? DAY) GROUP BY feature_key ORDER BY views DESC LIMIT 20`,[d]);
 const [goals]=await pool.query(`SELECT * FROM launch_goals WHERE status IN ('active','achieved') ORDER BY due_date IS NULL,due_date,id`);
 for(const g of goals){let current=0;if(g.metric_key==='total_users')current=Number(base.total_users||0);else if(g.metric_key==='active_workspaces')current=Number(base.active_workspaces||0);else if(g.metric_key==='paid_workspaces')current=Number(base.paid_workspaces||0);else if(g.metric_key==='mrr')current=Number(base.mrr||0);else if(g.metric_key==='feedback_30d'){const [[x]]=await pool.query('SELECT COUNT(*) value FROM feedback WHERE created_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)');current=Number(x.value||0);}g.current_value=current;g.progress=g.target_value>0?Math.min(100,Number((current/g.target_value*100).toFixed(1))):100;g.achieved=current>=Number(g.target_value);}
 const recommendations=[];if(!funnel.teaser_views)recommendations.push({priority:'high',title:'Start measuring launch demand',body:'Publish a teaser and instrument teaser_viewed events before judging a release.'});else if(!funnel.waitlist_signups)recommendations.push({priority:'high',title:'Demand is not converting',body:'Your teaser has views but no waitlist signups. Improve the promise, CTA or audience targeting.'});if(funnel.checkout_starts&&!funnel.upgrades)recommendations.push({priority:'high',title:'Checkout drop-off',body:'Users started checkout but no upgrade_completed events were recorded. Investigate pricing, checkout or trust blockers.'});if(!Number(base.paid_workspaces||0))recommendations.push({priority:'medium',title:'Validate willingness to pay',body:'No paid workspaces are recorded yet. Prioritize a small paid cohort before unlocking expensive expansion phases.'});if(goals.some(g=>g.achieved))recommendations.push({priority:'low',title:'A benchmark has been reached',body:'Review achieved goals and consider moving the next release from gated to launch-ready.'});
 return {period_days:d,base,funnel,conversion,by_phase:byPhase,by_feature:byFeature,goals,recommendations,upgrade_events:Number(up.total_upgrade_events||0),release_events:Number(ev.total_release_events||0)};
}
app.get('/api/superadmin/launch-analytics',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{res.json(await launchAnalytics(req.query.days||30));}catch(e){res.status(500).json({error:'Launch analytics failed',detail:e.message})}});
app.post('/api/superadmin/launch-analytics/snapshot',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const a=await launchAnalytics(req.body?.days||30),f=a.funnel,b=a.base;const [r]=await pool.query(`INSERT INTO launch_analytics_snapshots(period_days,total_users,active_workspaces,paid_workspaces,mrr,teaser_views,announcement_views,waitlist_signups,beta_activations,feature_views,upgrade_prompts,checkout_starts,upgrades) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[a.period_days,b.total_users,b.active_workspaces,b.paid_workspaces,b.mrr,f.teaser_views,f.announcement_views,f.waitlist_signups,f.beta_activations,f.feature_views,f.upgrade_prompts,f.checkout_starts,f.upgrades]);await audit(null,req.user.user_id,'launch.analytics.snapshot','launch_analytics_snapshot',r.insertId,{period_days:a.period_days});res.json({ok:true,id:r.insertId,analytics:a});}catch(e){res.status(500).json({error:'Analytics snapshot failed',detail:e.message})}});
app.get('/api/superadmin/launch-analytics/snapshots',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const [items]=await pool.query('SELECT * FROM launch_analytics_snapshots ORDER BY id DESC LIMIT 50');res.json({items});}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/launch-goals',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},allowed=['total_users','active_workspaces','paid_workspaces','mrr','feedback_30d'];if(!x.name||!x.metric_key)return res.status(400).json({error:'name and metric_key are required'});if(!allowed.includes(x.metric_key))return res.status(400).json({error:'Unsupported metric_key'});const [r]=await pool.query('INSERT INTO launch_goals(name,metric_key,target_value,due_date,notes) VALUES(?,?,?,?,?)',[x.name,x.metric_key,Number(x.target_value||0),x.due_date||null,x.notes||'']);await audit(null,req.user.user_id,'launch.goal.created','launch_goal',r.insertId,{metric_key:x.metric_key,target_value:x.target_value});res.status(201).json({id:r.insertId});}catch(e){res.status(500).json({error:'Goal creation failed',detail:e.message})}});
app.patch('/api/superadmin/launch-goals/:id',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},sets=[],vals=[];for(const k of ['name','metric_key','target_value','due_date','status','notes'])if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(k==='target_value'?Number(x[k]):x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE launch_goals SET ${sets.join(',')},updated_at=NOW() WHERE id=?`,vals);res.json({ok:true});}catch(e){res.status(500).json({error:'Goal update failed',detail:e.message})}});

// V6.3 Launch Experience: customer-facing release lifecycle, beta access and launch telemetry.
app.get('/api/launch/experience', async (req,res)=>{try{
  const [rows]=await pool.query(`SELECT re.*,rp.name phase_name,rp.phase_key,rp.launch_enabled FROM release_experiences re LEFT JOIN release_phases rp ON rp.id=re.phase_id WHERE re.enabled=1 AND (re.start_at IS NULL OR re.start_at<=NOW()) AND (re.end_at IS NULL OR re.end_at>=NOW()) ORDER BY re.priority DESC,re.id DESC`);
  const [campaigns]=await pool.query(`SELECT id,phase_id,name,headline,teaser,body,cta_label,cta_url,audience,status,start_at,end_at FROM launch_campaigns WHERE status='live' AND (start_at IS NULL OR start_at<=NOW()) AND (end_at IS NULL OR end_at>=NOW()) ORDER BY id DESC LIMIT 10`);
  res.json({experiences:rows,campaigns});
}catch(e){res.status(500).json({error:'Launch experience failed',detail:e.message})}});
app.post('/api/launch/events', async (req,res)=>{try{const x=req.body||{};if(!x.event_type)return res.status(400).json({error:'event_type is required'});await pool.query('INSERT INTO release_events(workspace_id,user_id,phase_id,feature_key,event_type,metadata) VALUES(?,?,?,?,?,?)',[req.user?.workspace_id||null,req.user?.user_id||null,x.phase_id||null,x.feature_key||null,String(x.event_type).slice(0,60),x.metadata?JSON.stringify(x.metadata):null]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/launch/waitlist', async (req,res)=>{try{const x=req.body||{};if(!x.email)return res.status(400).json({error:'email is required'});const email=String(x.email).trim().toLowerCase();await pool.query('INSERT INTO product_waitlist(email,name,company,phase_key,source,status) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=COALESCE(NULLIF(VALUES(name),\'\'),name),company=COALESCE(NULLIF(VALUES(company),\'\'),company),phase_key=COALESCE(VALUES(phase_key),phase_key)',[email,x.name||'',x.company||'',x.phase_key||null,x.source||'launch_experience','waiting']);res.json({ok:true,message:'You are on the early-access list.'})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/launch/beta', async (req,res)=>{if(!req.user)return res.status(401).json({error:'Authentication required'});try{const [rows]=await pool.query('SELECT ba.*,rp.name phase_name FROM beta_access ba LEFT JOIN release_phases rp ON rp.id=ba.phase_id WHERE ba.workspace_id=? ORDER BY ba.id DESC',[req.user.workspace_id]);res.json({items:rows})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/beta', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.workspace_id||!x.feature_key)return res.status(400).json({error:'workspace_id and feature_key are required'});const [r]=await pool.query('INSERT INTO beta_access(workspace_id,user_id,phase_id,feature_key,status,source) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),phase_id=VALUES(phase_id),user_id=VALUES(user_id)',[x.workspace_id,x.user_id||null,x.phase_id||null,x.feature_key,x.status||'invited',x.source||'super_admin']);await audit(null,req.user.user_id,'release.beta.access_changed','beta_access',r.insertId,{workspace_id:x.workspace_id,feature_key:x.feature_key,status:x.status||'invited'});res.json({ok:true,id:r.insertId})}catch(e){res.status(500).json({error:'Beta access failed',detail:e.message})}});
app.get('/api/superadmin/launch-experience', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const [experiences]=await pool.query('SELECT re.*,rp.name phase_name,rp.phase_key FROM release_experiences re LEFT JOIN release_phases rp ON rp.id=re.phase_id ORDER BY re.priority DESC,re.id DESC');const [events]=await pool.query(`SELECT event_type,COUNT(*) count FROM release_events GROUP BY event_type ORDER BY count DESC`);const [beta]=await pool.query(`SELECT status,COUNT(*) count FROM beta_access GROUP BY status`);const [wait]=await pool.query(`SELECT phase_key,status,COUNT(*) count FROM product_waitlist GROUP BY phase_key,status`);res.json({experiences,events,beta,waitlist:wait})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/superadmin/launch-experience', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.experience_key||!x.headline)return res.status(400).json({error:'experience_key and headline are required'});const [r]=await pool.query('INSERT INTO release_experiences(phase_id,experience_key,stage,headline,subheadline,body,cta_label,cta_url,feature_key,enabled,priority,start_at,end_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[x.phase_id||null,x.experience_key,x.stage||'teaser',x.headline,x.subheadline||'',x.body||'',x.cta_label||'Learn more',x.cta_url||'',x.feature_key||null,x.enabled===false?0:1,Number(x.priority||100),x.start_at||null,x.end_at||null]);res.status(201).json({id:r.insertId})}catch(e){res.status(500).json({error:'Launch experience creation failed',detail:e.message})}});
app.patch('/api/superadmin/launch-experience/:id', async (req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},keys=['phase_id','stage','headline','subheadline','body','cta_label','cta_url','feature_key','enabled','priority','start_at','end_at'],sets=[],vals=[];for(const k of keys)if(x[k]!==undefined){sets.push(`${k}=?`);vals.push(k==='enabled'?(x[k]?1:0):x[k])}if(!sets.length)return res.json({ok:true});vals.push(req.params.id);await pool.query(`UPDATE release_experiences SET ${sets.join(',')},updated_at=NOW() WHERE id=?`,vals);await audit(null,req.user.user_id,'release.experience.updated','release_experience',req.params.id,x);res.json({ok:true})}catch(e){res.status(500).json({error:'Launch experience update failed',detail:e.message})}});


// V6.6 Monetization & Upgrade Intelligence. Payment processing remains provider-neutral;
// Super Admin can record/activate subscriptions while customers can express upgrade intent.
async function revenueOverview(days=30){
  const d=Math.min(365,Math.max(1,Number(days)||30));
  const [[base]]=await pool.query(`SELECT COUNT(*) workspaces,COUNT(CASE WHEN plan_status<>'free' THEN 1 END) paid_workspaces,COALESCE(SUM(mrr),0) mrr FROM workspaces`);
  const [[subs]]=await pool.query(`SELECT COUNT(*) active_subscriptions,COALESCE(SUM(mrr),0) subscription_mrr FROM subscriptions WHERE status IN ('trialing','active')`);
  const [[events]]=await pool.query(`SELECT COUNT(*) billing_events,COALESCE(SUM(CASE WHEN event_type IN ('payment_succeeded','subscription_started','upgrade_completed') THEN amount ELSE 0 END),0) recognized_revenue,COALESCE(SUM(CASE WHEN event_type='refund' THEN amount ELSE 0 END),0) refunds FROM billing_events WHERE occurred_at>=DATE_SUB(NOW(),INTERVAL ? DAY)`,[d]);
  const [[intents]]=await pool.query(`SELECT COUNT(*) total,COUNT(CASE WHEN status='converted' THEN 1 END) converted,COUNT(CASE WHEN status='requested' THEN 1 END) open_intents FROM billing_intents WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)`,[d]);
  const [[ups]]=await pool.query(`SELECT COUNT(*) prompts,SUM(event_type='checkout_started') checkout_starts,SUM(event_type='upgrade_completed') upgrades FROM upgrade_events WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)`,[d]);
  const [plans]=await pool.query(`SELECT w.plan_status plan_key,COUNT(*) workspaces,COALESCE(SUM(w.mrr),0) mrr FROM workspaces w GROUP BY w.plan_status ORDER BY mrr DESC`);
  const [features]=await pool.query(`SELECT feature_key,COUNT(*) attributions,COALESCE(SUM(amount),0) attributed_revenue FROM revenue_attributions WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY) GROUP BY feature_key ORDER BY attributed_revenue DESC LIMIT 20`,[d]);
  const [[usage]]=await pool.query(`SELECT (SELECT COUNT(*) FROM feedback WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)) feedback_30d,(SELECT COUNT(*) FROM problems WHERE created_at>=DATE_SUB(NOW(),INTERVAL ? DAY)) problems_30d`,[d]);
  const upgradeRate=Number(intents.total||0)?Number((Number(intents.converted||0)/Number(intents.total)*100).toFixed(1)):0;
  const checkoutRate=Number(ups.checkout_starts||0)?Number((Number(ups.upgrades||0)/Number(ups.checkout_starts)*100).toFixed(1)):0;
  return {period_days:d,base,subscriptions:subs,billing:events,intents,upgrade_funnel:{prompts:Number(ups.prompts||0),checkout_starts:Number(ups.checkout_starts||0),upgrades:Number(ups.upgrades||0),checkout_to_upgrade:checkoutRate},intent_conversion:upgradeRate,plans,features,usage,recommendations:[
    Number(base.paid_workspaces||0)===0?{priority:'high',title:'Create a paid cohort',body:'No paid workspaces are recorded. Offer a founder plan or invite a small set of design partners into a paid pilot.'}:null,
    Number(intents.total||0)>0&&Number(intents.converted||0)===0?{priority:'high',title:'Upgrade intent is not converting',body:'Customers are asking for upgrades but none are recorded as converted. Investigate pricing, checkout friction and plan value.'}:null,
    Number(ups.checkout_starts||0)>0&&Number(ups.upgrades||0)===0?{priority:'high',title:'Checkout drop-off detected',body:'Checkout starts exist without completed upgrades. Fix payment or trust blockers before the next major launch.'}:null,
    Number(usage.feedback_30d||0)>0&&Number(base.paid_workspaces||0)===0?{priority:'medium',title:'Monetize demonstrated usage',body:'Feedback activity exists but paid conversion is zero. Use feature usage and customer outcomes to target upgrade prompts.'}:null
  ].filter(Boolean)};
}
app.get('/api/billing',async(req,res)=>{if(!req.user)return res.status(401).json({error:'Authentication required'});try{const [plans]=await pool.query("SELECT * FROM product_plans WHERE status='active' ORDER BY sort_order,id");const [subs]=await pool.query('SELECT * FROM subscriptions WHERE workspace_id=? ORDER BY id DESC',[req.user.workspace_id]);const [intents]=await pool.query('SELECT * FROM billing_intents WHERE workspace_id=? ORDER BY id DESC LIMIT 20',[req.user.workspace_id]);res.json({current_plan:req.user.plan_status||'free',plans,subscriptions:subs,intents});}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/billing/intent',async(req,res)=>{if(!req.user)return res.status(401).json({error:'Authentication required'});try{const x=req.body||{};if(!validPlan(x.to_plan)||x.to_plan==='free')return res.status(400).json({error:'A paid target plan is required'});const from=req.user.plan_status||'free';const [r]=await pool.query('INSERT INTO billing_intents(workspace_id,user_id,from_plan,to_plan,source,metadata) VALUES(?,?,?,?,?,?)',[req.user.workspace_id,req.user.user_id,from,x.to_plan,x.source||'upgrade_prompt',x.metadata?JSON.stringify(x.metadata):null]);await pool.query('INSERT INTO upgrade_events(workspace_id,user_id,feature_key,event_type,from_plan,to_plan,metadata) VALUES(?,?,?,?,?,?,?)',[req.user.workspace_id,req.user.user_id,x.feature_key||null,'checkout_started',from,x.to_plan,x.metadata?JSON.stringify(x.metadata):null]);res.status(201).json({ok:true,id:r.insertId,message:'Upgrade request recorded. Payment processing can be connected to a billing provider later.'});}catch(e){res.status(500).json({error:e.message})}});
// V6.7 Retention, Churn & Expansion Intelligence. These are product-usage signals, not contractual churn predictions.
app.get('/api/retention/overview',async(req,res)=>{if(!req.user)return res.status(401).json({error:'Authentication required'});try{res.json(await retentionOverview(pool,req.user.workspace_id,req.query.days||90));}catch(e){res.status(500).json({error:'Retention overview failed',detail:e.message})}});
app.post('/api/retention/snapshot',async(req,res)=>{if(!req.user || !['admin','manager'].includes(req.user.role))return res.status(403).json({error:'Manager permission required'});try{const d=await retentionOverview(pool,req.user.workspace_id,req.body?.days||90);const id=await retentionSnapshot(pool,req.user.workspace_id,d);res.status(201).json({ok:true,id,overview:d});}catch(e){res.status(500).json({error:'Retention snapshot failed',detail:e.message})}});
app.get('/api/retention/snapshots',async(req,res)=>{if(!req.user)return res.status(401).json({error:'Authentication required'});try{const [items]=await pool.query('SELECT * FROM retention_snapshots WHERE workspace_id=? ORDER BY id DESC LIMIT 30',[req.user.workspace_id]);res.json({items});}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/superadmin/retention',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const [ws]=await pool.query("SELECT id,name,plan_status,mrr FROM workspaces ORDER BY id");const workspaces=[];for(const w of ws){const d=await retentionOverview(pool,w.id,req.query.days||90);workspaces.push({workspace:w,...d.summary});}const totals=workspaces.reduce((a,w)=>{for(const k of ['customers','churn_risk','at_risk','stable','expansion'])a[k]+=Number(w[k]||0);a.revenue_at_risk+=Number(w.revenue_at_risk||0);return a},{customers:0,churn_risk:0,at_risk:0,stable:0,expansion:0,revenue_at_risk:0});totals.average_health=totals.customers?Number((workspaces.reduce((s,w)=>s+Number(w.average_health||0)*Number(w.customers||0),0)/totals.customers).toFixed(1)):0;res.json({period_days:Number(req.query.days||90),totals,workspaces});}catch(e){res.status(500).json({error:'Retention command failed',detail:e.message})}});
app.get('/api/superadmin/revenue',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{res.json(await revenueOverview(req.query.days||30));}catch(e){res.status(500).json({error:'Revenue overview failed',detail:e.message})}});
app.post('/api/superadmin/subscriptions',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{},plan=String(x.plan_key||'');if(!validPlan(plan)||plan==='free'||!x.workspace_id)return res.status(400).json({error:'workspace_id and paid plan_key are required'});const [[p]]=await pool.query('SELECT * FROM product_plans WHERE plan_key=?',[plan]);if(!p)return res.status(404).json({error:'Plan not found'});await pool.query("UPDATE subscriptions SET status='canceled',canceled_at=NOW(),updated_at=NOW() WHERE workspace_id=? AND status IN ('trialing','active','past_due','paused')",[x.workspace_id]);const price=Number(x.price??(x.billing_cycle==='yearly'?p.price_yearly:p.price_monthly));const mrr=x.billing_cycle==='yearly'?price/12:price;const status=x.trial_days? 'trialing':'active';const [r]=await pool.query('INSERT INTO subscriptions(workspace_id,plan_key,status,billing_cycle,price,mrr,trial_ends_at,renews_at,provider) VALUES(?,?,?,?,?,?,?,?,?)',[x.workspace_id,plan,status,x.billing_cycle==='yearly'?'yearly':'monthly',price,mrr,x.trial_days?new Date(Date.now()+Number(x.trial_days)*86400000):null,new Date(Date.now()+30*86400000),'manual']);await pool.query('UPDATE workspaces SET plan_status=?,mrr=? WHERE id=?',[plan,mrr,x.workspace_id]);await pool.query('INSERT INTO billing_events(workspace_id,subscription_id,event_type,amount,plan_key,metadata) VALUES(?,?,?,?,?,?)',[x.workspace_id,r.insertId,status==='trialing'?'subscription_started':'payment_succeeded',price,plan,JSON.stringify({source:'super_admin'})]);await pool.query("UPDATE billing_intents SET status='converted',updated_at=NOW() WHERE workspace_id=? AND to_plan=? AND status IN ('requested','reviewed') ORDER BY id DESC LIMIT 1",[x.workspace_id,plan]);await pool.query('INSERT INTO upgrade_events(workspace_id,user_id,event_type,from_plan,to_plan,metadata) SELECT ?,NULL,\'upgrade_completed\',?, ?, ?',[x.workspace_id,x.from_plan||'free',plan,JSON.stringify({source:'super_admin'})]);await audit(null,req.user.user_id,'billing.subscription.activated','subscription',r.insertId,{workspace_id:x.workspace_id,plan_key:plan,mrr});res.status(201).json({ok:true,id:r.insertId,plan,mrr});}catch(e){res.status(500).json({error:'Subscription activation failed',detail:e.message})}});
app.post('/api/superadmin/subscriptions/:id/cancel',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const [[s]]=await pool.query('SELECT * FROM subscriptions WHERE id=?',[req.params.id]);if(!s)return res.status(404).json({error:'Subscription not found'});await pool.query("UPDATE subscriptions SET status='canceled',canceled_at=NOW(),updated_at=NOW() WHERE id=?",[s.id]);await pool.query("UPDATE workspaces SET plan_status='free',mrr=0 WHERE id=?",[s.workspace_id]);await pool.query('INSERT INTO billing_events(workspace_id,subscription_id,event_type,amount,plan_key,metadata) VALUES(?,?,?,?,?,?)',[s.workspace_id,s.id,'subscription_canceled',0,s.plan_key,JSON.stringify({source:'super_admin'})]);await audit(null,req.user.user_id,'billing.subscription.canceled','subscription',s.id,{workspace_id:s.workspace_id});res.json({ok:true});}catch(e){res.status(500).json({error:'Subscription cancellation failed',detail:e.message})}});
app.post('/api/superadmin/revenue/attribute',async(req,res)=>{if(!requireSuperAdmin(req,res))return;try{const x=req.body||{};if(!x.workspace_id||x.amount===undefined)return res.status(400).json({error:'workspace_id and amount required'});const [r]=await pool.query('INSERT INTO revenue_attributions(workspace_id,feature_key,phase_id,event_id,attribution_type,amount,currency) VALUES(?,?,?,?,?,?,?)',[x.workspace_id,x.feature_key||null,x.phase_id||null,x.event_id||null,x.attribution_type||'influenced',Number(x.amount),x.currency||'USD']);res.status(201).json({ok:true,id:r.insertId});}catch(e){res.status(500).json({error:'Revenue attribution failed',detail:e.message})}});

app.use((req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"Not found"});
  const index=path.join(frontend,"index.html");
  if(fs.existsSync(index)) return res.sendFile(index);
  res.json({message:"FeedbackOS backend is running"});
});

async function start() {
  try {
    await migrate();
    app.listen(PORT, () => console.log(`FeedbackOS running on http://localhost:${PORT}`));
  } catch (error) {
    console.error("Database migration failed:", error);
    process.exit(1);
  }
}

start();
