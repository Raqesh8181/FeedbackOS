const pool = require('./db');

async function hasColumn(table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0].count) > 0;
}

async function addColumn(table, column, definition) {
  if (!(await hasColumn(table, column))) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`Migration: added ${table}.${column}`);
  }
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(50) NOT NULL,
    source_id VARCHAR(255) NULL,
    customer_name VARCHAR(255) NULL,
    message TEXT NOT NULL,
    sentiment ENUM('positive','neutral','negative') NULL,
    category VARCHAR(100) NULL,
    severity ENUM('low','medium','high','critical') NULL,
    summary TEXT NULL,
    embedding JSON NULL,
    problem_id INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS problems (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    impact TEXT NULL,
    category VARCHAR(100) NULL,
    recommended_team VARCHAR(150) NULL,
    priority ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
    severity ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
    status ENUM('detected','prioritized','assigned','acknowledged','investigating','action_taken','monitoring','resolved') NOT NULL DEFAULT 'detected',
    owner VARCHAR(150) NULL,
    first_detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    feedback_count INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  for (const [c,d] of [
    ['source_id','VARCHAR(255) NULL'],['customer_name','VARCHAR(255) NULL'],['sentiment',"ENUM('positive','neutral','negative') NULL"],
    ['category','VARCHAR(100) NULL'],['severity',"ENUM('low','medium','high','critical') NULL"],['summary','TEXT NULL'],['embedding','JSON NULL'],
    ['problem_id','BIGINT UNSIGNED NULL'],['created_at','DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP']
  ]) await addColumn('feedback',c,d);

  for (const [c,d] of [
    ['description','TEXT NULL'],['impact','TEXT NULL'],['category','VARCHAR(100) NULL'],['recommended_team','VARCHAR(150) NULL'],
    ['priority',"ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium'"],['severity',"ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium'"],
    ['status',"ENUM('detected','prioritized','assigned','acknowledged','investigating','action_taken','monitoring','resolved') NOT NULL DEFAULT 'detected'"],
    ['owner','VARCHAR(150) NULL'],['first_detected_at','DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],['last_detected_at','DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['resolved_at','DATETIME NULL'],['feedback_count','INT NOT NULL DEFAULT 0'],['confidence','DECIMAL(6,5) NULL'],['health','VARCHAR(30) NULL'],['created_at','DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'],
    ['updated_at','DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],['recommended_action','TEXT NULL'],['recommendation_reason','TEXT NULL'],['resolution_effectiveness','DECIMAL(6,2) NULL'],['resolution_summary','TEXT NULL']
  ]) await addColumn('problems',c,d);

  await pool.query(`CREATE TABLE IF NOT EXISTS problem_feedback (
    problem_id INT NOT NULL,
    feedback_id BIGINT UNSIGNED NOT NULL,
    similarity_score DECIMAL(8,6) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (problem_id, feedback_id)
  )`);
  await addColumn('problem_feedback','similarity_score','DECIMAL(8,6) NULL');

  await pool.query(`CREATE TABLE IF NOT EXISTS actions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    problem_id INT NOT NULL,
    owner VARCHAR(150) NULL,
    description TEXT NOT NULL,
    status ENUM('open','in_progress','completed') NOT NULL DEFAULT 'open',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    expected_impact_percent DECIMAL(6,2) NULL,
    baseline_negative INT NULL,
    outcome_negative INT NULL,
    actual_impact_percent DECIMAL(6,2) NULL,
    outcome_status VARCHAR(30) NULL,
    outcome_summary TEXT NULL,
    measured_at DATETIME NULL
  )`);

  for (const [c,d] of [
    ['expected_impact_percent','DECIMAL(6,2) NULL'],['baseline_negative','INT NULL'],['outcome_negative','INT NULL'],
    ['actual_impact_percent','DECIMAL(6,2) NULL'],['outcome_status','VARCHAR(30) NULL'],['outcome_summary','TEXT NULL'],['measured_at','DATETIME NULL']
  ]) await addColumn('actions',c,d);

  await pool.query(`CREATE TABLE IF NOT EXISTS problem_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    problem_id INT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NULL,
    detail TEXT NULL,
    metadata JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_problem_events_problem (problem_id, created_at),
    FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS daily_metrics (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    problem_id INT NOT NULL,
    date DATE NOT NULL,
    feedback_count INT NOT NULL DEFAULT 0,
    negative_count INT NOT NULL DEFAULT 0,
    positive_count INT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_problem_date (problem_id, date)
  )`);

  // V4.2 Product & Feature Intelligence
  for (const [c,d] of [
    ['feature_name','VARCHAR(150) NULL'],['product_area','VARCHAR(120) NULL'],['feature_confidence','DECIMAL(5,2) NULL']
  ]) await addColumn('feedback',c,d);

  // V2.3+ root-cause / investigation / outcome / prediction / operations / strategy tables.
  for (const [c,d] of [
    ['root_cause_score','DECIMAL(6,2) NULL'],['root_cause_summary','TEXT NULL'],
    ['strategy_theme_id','BIGINT UNSIGNED NULL'],['initiative_id','BIGINT UNSIGNED NULL']
  ]) await addColumn('problems',c,d);
  for (const [c,d] of [
    ['initiative_id','BIGINT UNSIGNED NULL'],['success_metric','TEXT NULL'],['target_impact','DECIMAL(6,2) NULL']
  ]) await addColumn('actions',c,d);

  await pool.query(`CREATE TABLE IF NOT EXISTS problem_relationships (
    problem_id INT NOT NULL,
    related_problem_id INT NOT NULL,
    relationship_type VARCHAR(60) NOT NULL DEFAULT 'related',
    score DECIMAL(8,6) NULL,
    explanation TEXT NULL,
    PRIMARY KEY(problem_id,related_problem_id)
  )`);
  await addColumn('problem_relationships','relationship_type',"VARCHAR(60) NOT NULL DEFAULT 'related'");
  await addColumn('problem_relationships','score','DECIMAL(8,6) NULL');
  await addColumn('problem_relationships','explanation','TEXT NULL');

  await pool.query(`CREATE TABLE IF NOT EXISTS root_cause_investigations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    problem_id INT NOT NULL UNIQUE,
    hypothesis TEXT NULL,
    confidence DECIMAL(6,2) NULL,
    evidence_summary TEXT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    decision VARCHAR(30) NULL,
    decision_notes TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS investigation_tasks (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    investigation_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    owner VARCHAR(150) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS predictive_signals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    problem_id INT NOT NULL,
    risk_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    risk_level VARCHAR(30) NOT NULL DEFAULT 'low',
    trend VARCHAR(30) NULL,
    forecast_7d DECIMAL(10,2) NULL,
    action_success_forecast DECIMAL(6,2) NULL,
    explanation TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS preventive_actions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    problem_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    owner VARCHAR(150) NULL,
    due_at DATETIME NULL,
    expected_impact DECIMAL(6,2) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'proposed',
    approved_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumn('feedback','journey_stage','VARCHAR(40) NULL');
  await addColumn('feedback','journey_stage_confidence','DECIMAL(4,3) NULL');

  await pool.query(`CREATE TABLE IF NOT EXISTS customer_journey_insights (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_name VARCHAR(255) NOT NULL,
    current_stage VARCHAR(40) NULL,
    risk_level VARCHAR(30) NOT NULL DEFAULT 'healthy',
    negative_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
    stage_count INT NOT NULL DEFAULT 0,
    first_seen DATETIME NULL,
    last_seen DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_customer_journey (customer_name)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS strategic_themes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    priority VARCHAR(30) NOT NULL DEFAULT 'medium',
    status VARCHAR(30) NOT NULL DEFAULT 'proposed',
    owner VARCHAR(150) NULL,
    target_impact DECIMAL(6,2) NOT NULL DEFAULT 20,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS strategic_initiatives (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    theme_id BIGINT UNSIGNED NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    owner VARCHAR(150) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'proposed',
    priority VARCHAR(30) NOT NULL DEFAULT 'medium',
    target_impact DECIMAL(6,2) NOT NULL DEFAULT 20,
    success_metric TEXT NULL,
    due_at DATETIME NULL,
    team VARCHAR(120) NULL,
    effort_points DECIMAL(10,2) NOT NULL DEFAULT 5,
    capacity_available DECIMAL(10,2) NOT NULL DEFAULT 0,
    funding_required DECIMAL(12,2) NOT NULL DEFAULT 0,
    confidence DECIMAL(6,2) NOT NULL DEFAULT 60,
    execution_risk DECIMAL(6,2) NOT NULL DEFAULT 40,
    portfolio_decision VARCHAR(30) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS initiative_problems (
    initiative_id BIGINT UNSIGNED NOT NULL,
    problem_id INT NOT NULL,
    PRIMARY KEY(initiative_id,problem_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS initiative_actions (
    initiative_id BIGINT UNSIGNED NOT NULL,
    action_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY(initiative_id,action_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS strategy_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    summary TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumn('problems','owner_acknowledged_at','DATETIME NULL');
  await addColumn('problems','accountability_status',"VARCHAR(30) NOT NULL DEFAULT 'unassigned'");
  await addColumn('actions','team','VARCHAR(120) NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_rules (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    rule_type VARCHAR(50) NOT NULL,
    description TEXT NULL,
    threshold DECIMAL(10,2) NOT NULL DEFAULT 0,
    action_template TEXT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_queue (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    rule_id BIGINT UNSIGNED NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    recommended_action VARCHAR(255) NULL,
    payload JSON NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(150) NULL,
    reviewed_at DATETIME NULL,
    completed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_automation_queue_status (status,created_at),
    INDEX idx_automation_queue_entity (entity_type,entity_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    trigger_type VARCHAR(40) NOT NULL DEFAULT 'manual',
    rules_evaluated INT NOT NULL DEFAULT 0,
    items_created INT NOT NULL DEFAULT 0,
    items_skipped INT NOT NULL DEFAULT 0,
    summary TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS os_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    trigger_type VARCHAR(40) NOT NULL DEFAULT 'manual',
    health_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    items_created INT NOT NULL DEFAULT 0,
    summary TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS os_decisions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    run_id BIGINT UNSIGNED NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(255) NOT NULL,
    priority VARCHAR(30) NOT NULL DEFAULT 'medium',
    score DECIMAL(10,2) NOT NULL DEFAULT 0,
    next_action VARCHAR(255) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'proposed',
    reviewed_by VARCHAR(150) NULL,
    reviewed_at DATETIME NULL,
    completed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_os_decisions_status(status,score)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS os_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    summary TEXT NULL,
    health_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // V5.1 Identity, workspaces, team invites, integrations, API access, and audit trail.
  await pool.query(`CREATE TABLE IF NOT EXISTS workspaces (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    password_salt VARCHAR(128) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS workspace_members (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'member',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_workspace_user (workspace_id,user_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    workspace_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_user (user_id), INDEX idx_sessions_expiry (expires_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS invitations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'member',
    token_hash CHAR(64) NOT NULL UNIQUE,
    invited_by BIGINT UNSIGNED NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_invites_workspace (workspace_id,status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS integrations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(150) NOT NULL,
    type VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    config JSON NULL,
    created_by BIGINT UNSIGNED NULL,
    last_event_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_workspace_integration (workspace_id,name)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS api_keys (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(150) NOT NULL,
    key_prefix VARCHAR(20) NOT NULL,
    key_hash CHAR(64) NOT NULL UNIQUE,
    created_by BIGINT UNSIGNED NULL,
    last_used_at DATETIME NULL,
    revoked_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    event_type VARCHAR(80) NOT NULL,
    entity_type VARCHAR(60) NULL,
    entity_id BIGINT UNSIGNED NULL,
    metadata JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_workspace (workspace_id,created_at)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS executive_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    summary TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

}

async function ensureV54SecurityColumns() {
  // V5.4 RBAC/session hardening: make invitations and sessions manageable without breaking existing data.
  await addColumn('invitations','revoked_at','DATETIME NULL');
  await addColumn('sessions','last_seen_at','DATETIME NULL');
  await addColumn('sessions','ip_address','VARCHAR(80) NULL');
  await addColumn('sessions','user_agent','VARCHAR(500) NULL');
  try { await pool.query('CREATE INDEX idx_sessions_workspace ON sessions(workspace_id,expires_at)'); } catch(e) { if(!/duplicate|already exists/i.test(e.message)) throw e; }
  try { await pool.query('CREATE INDEX idx_invitations_email ON invitations(workspace_id,email,status)'); } catch(e) { if(!/duplicate|already exists/i.test(e.message)) throw e; }
}

async function ensureWorkspaceColumns() {
  // V5.2 multi-tenant hardening: every core operational record carries a workspace scope.
  const defs = [
    ['feedback','workspace_id','BIGINT UNSIGNED NULL'],
    ['problems','workspace_id','BIGINT UNSIGNED NULL'],
    ['actions','workspace_id','BIGINT UNSIGNED NULL'],
    ['problem_feedback','workspace_id','BIGINT UNSIGNED NULL'],
    ['problem_events','workspace_id','BIGINT UNSIGNED NULL'],
    ['daily_metrics','workspace_id','BIGINT UNSIGNED NULL'],
    ['strategic_themes','workspace_id','BIGINT UNSIGNED NULL'],
    ['strategic_initiatives','workspace_id','BIGINT UNSIGNED NULL'],
    ['initiative_problems','workspace_id','BIGINT UNSIGNED NULL'],
    ['initiative_actions','workspace_id','BIGINT UNSIGNED NULL'],
    ['strategy_snapshots','workspace_id','BIGINT UNSIGNED NULL'],
    ['problem_relationships','workspace_id','BIGINT UNSIGNED NULL'],
    ['root_cause_investigations','workspace_id','BIGINT UNSIGNED NULL'],
    ['investigation_tasks','workspace_id','BIGINT UNSIGNED NULL'],
    ['predictive_signals','workspace_id','BIGINT UNSIGNED NULL'],
    ['preventive_actions','workspace_id','BIGINT UNSIGNED NULL']
  ];
  for (const [t,c,d] of defs) { try { await addColumn(t,c,d); } catch(e) { if (!/doesn't exist|unknown table/i.test(e.message)) throw e; } }
  // Backfill legacy records into the oldest workspace. New records are written with an explicit scope by V5.2 routes.
  const tables = defs.map(x=>x[0]);
  const [[first]] = await pool.query('SELECT id FROM workspaces ORDER BY id LIMIT 1');
  if (first) for (const t of tables) {
    try { await pool.query(`UPDATE \`${t}\` SET workspace_id=? WHERE workspace_id IS NULL`, [first.id]); } catch(e) { console.warn(`Workspace backfill skipped for ${t}: ${e.message}`); }
  }
  for (const [t] of defs) {
    try { await pool.query(`CREATE INDEX idx_${t}_workspace ON \`${t}\` (workspace_id)`); } catch(e) { if (!/duplicate key name/i.test(e.message)) console.warn(`Workspace index skipped for ${t}: ${e.message}`); }
  }
}

async function ensureV52Tables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS security_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    event_type VARCHAR(80) NOT NULL,
    ip_address VARCHAR(64) NULL,
    user_agent VARCHAR(500) NULL,
    detail JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_security_workspace (workspace_id, created_at),
    INDEX idx_security_type (event_type, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS api_key_scopes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    api_key_id BIGINT UNSIGNED NOT NULL,
    scope VARCHAR(80) NOT NULL,
    UNIQUE KEY uniq_key_scope(api_key_id,scope)
  )`);
}


async function ensureV55ControlPlane() {
  await addColumn('workspaces','timezone',"VARCHAR(64) NOT NULL DEFAULT 'UTC'");
  await addColumn('workspaces','settings_json','JSON NULL');
  await addColumn('users','status',"VARCHAR(30) NOT NULL DEFAULT 'active'");
  await pool.query(`CREATE TABLE IF NOT EXISTS security_policies (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL UNIQUE,
    session_days INT NOT NULL DEFAULT 30,
    require_strong_password TINYINT(1) NOT NULL DEFAULT 1,
    allow_member_invites TINYINT(1) NOT NULL DEFAULT 0,
    audit_retention_days INT NOT NULL DEFAULT 365,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  const [ws]=await pool.query('SELECT id FROM workspaces');
  for (const w of ws) await pool.query('INSERT IGNORE INTO security_policies(workspace_id) VALUES(?)',[w.id]);
}



async function ensureV56Observability() {
  await pool.query(`CREATE TABLE IF NOT EXISTS api_request_metrics (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    method VARCHAR(10) NOT NULL,
    route VARCHAR(255) NOT NULL,
    status_code INT NOT NULL,
    duration_ms INT NOT NULL,
    error_message VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_api_metrics_workspace_time (workspace_id,created_at),
    INDEX idx_api_metrics_route_time (route,created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS job_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    job_name VARCHAR(120) NOT NULL,
    status ENUM('running','completed','failed') NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    duration_ms INT NULL,
    detail JSON NULL,
    INDEX idx_job_runs_workspace_time (workspace_id,started_at),
    INDEX idx_job_runs_status_time (status,started_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ingestion_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    integration_id BIGINT UNSIGNED NULL,
    source VARCHAR(80) NOT NULL,
    status ENUM('accepted','processed','failed') NOT NULL,
    feedback_count INT NOT NULL DEFAULT 0,
    error_message VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ingestion_workspace_time (workspace_id,created_at),
    INDEX idx_ingestion_status_time (status,created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS health_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NULL,
    db_ok TINYINT(1) NOT NULL DEFAULT 0,
    db_latency_ms INT NULL,
    api_error_rate DECIMAL(7,4) NOT NULL DEFAULT 0,
    ingestion_failures INT NOT NULL DEFAULT 0,
    failed_jobs INT NOT NULL DEFAULT 0,
    active_sessions INT NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'unknown',
    detail JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_health_workspace_time (workspace_id,created_at)
  )`);
}


async function ensureV57Quality() {
  await pool.query(`CREATE TABLE IF NOT EXISTS quality_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    status ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
    total_feedback INT NOT NULL DEFAULT 0,
    valid_feedback INT NOT NULL DEFAULT 0,
    duplicate_count INT NOT NULL DEFAULT 0,
    quality_issue_count INT NOT NULL DEFAULT 0,
    low_confidence_count INT NOT NULL DEFAULT 0,
    ai_failure_count INT NOT NULL DEFAULT 0,
    score DECIMAL(6,2) NOT NULL DEFAULT 0,
    detail JSON NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    INDEX idx_quality_workspace_time (workspace_id,started_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback_quality_flags (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    feedback_id BIGINT UNSIGNED NOT NULL,
    flag_type VARCHAR(50) NOT NULL,
    severity ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
    detail VARCHAR(1000) NULL,
    fingerprint VARCHAR(64) NULL,
    status ENUM('open','resolved') NOT NULL DEFAULT 'open',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    UNIQUE KEY uniq_feedback_quality_flag (workspace_id,feedback_id,flag_type),
    INDEX idx_quality_flags_workspace_status (workspace_id,status),
    INDEX idx_quality_flags_feedback (feedback_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS quality_retry_queue (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    feedback_id BIGINT UNSIGNED NOT NULL,
    attempt_count INT NOT NULL DEFAULT 0,
    status ENUM('queued','processing','completed','failed') NOT NULL DEFAULT 'queued',
    last_error VARCHAR(1000) NULL,
    queued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    UNIQUE KEY uniq_quality_retry (workspace_id,feedback_id),
    INDEX idx_quality_retry_workspace_status (workspace_id,status)
  )`);
}



async function ensureV58AIGovernance() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    feedback_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    operation VARCHAR(80) NOT NULL,
    model VARCHAR(120) NOT NULL,
    prompt_version VARCHAR(80) NOT NULL,
    input_hash CHAR(64) NOT NULL,
    status ENUM('running','completed','failed','overridden') NOT NULL DEFAULT 'running',
    sentiment VARCHAR(30) NULL,
    category VARCHAR(100) NULL,
    severity VARCHAR(30) NULL,
    summary TEXT NULL,
    confidence DECIMAL(6,4) NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0,
    estimated_cost_usd DECIMAL(12,8) NOT NULL DEFAULT 0,
    duration_ms INT NULL,
    error_message VARCHAR(1000) NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    INDEX idx_ai_runs_workspace_time (workspace_id,started_at),
    INDEX idx_ai_runs_feedback (workspace_id,feedback_id),
    INDEX idx_ai_runs_status (workspace_id,status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_overrides (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    ai_run_id BIGINT UNSIGNED NULL,
    feedback_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    field_name VARCHAR(40) NOT NULL,
    old_value TEXT NULL,
    new_value TEXT NULL,
    reason VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_overrides_workspace_time (workspace_id,created_at),
    INDEX idx_ai_overrides_feedback (workspace_id,feedback_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_settings (
    workspace_id BIGINT UNSIGNED PRIMARY KEY,
    model VARCHAR(120) NOT NULL DEFAULT 'gpt-5-mini',
    min_confidence DECIMAL(6,4) NOT NULL DEFAULT 0.60,
    max_retries INT NOT NULL DEFAULT 3,
    require_human_review TINYINT(1) NOT NULL DEFAULT 0,
    daily_token_budget INT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  const [ws] = await pool.query('SELECT id FROM workspaces');
  for (const w of ws) await pool.query('INSERT IGNORE INTO ai_settings(workspace_id) VALUES(?)',[w.id]);
}


async function ensureV59AIEvaluation() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_eval_datasets (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    description VARCHAR(1000) NULL,
    status ENUM('active','archived') NOT NULL DEFAULT 'active',
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ai_eval_datasets_workspace (workspace_id,status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_eval_cases (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    dataset_id BIGINT UNSIGNED NOT NULL,
    input_text TEXT NOT NULL,
    expected_sentiment VARCHAR(30) NULL,
    expected_category VARCHAR(100) NULL,
    expected_severity VARCHAR(30) NULL,
    expected_summary TEXT NULL,
    tags VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_eval_cases_dataset (workspace_id,dataset_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_eval_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    dataset_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    model VARCHAR(120) NOT NULL,
    prompt_version VARCHAR(80) NOT NULL,
    status ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
    total_cases INT NOT NULL DEFAULT 0,
    evaluated_cases INT NOT NULL DEFAULT 0,
    sentiment_accuracy DECIMAL(8,5) NULL,
    category_accuracy DECIMAL(8,5) NULL,
    severity_accuracy DECIMAL(8,5) NULL,
    summary_match_rate DECIMAL(8,5) NULL,
    overall_score DECIMAL(8,5) NULL,
    regressions INT NOT NULL DEFAULT 0,
    duration_ms INT NULL,
    error_message VARCHAR(1000) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME NULL,
    INDEX idx_ai_eval_runs_workspace (workspace_id,created_at),
    INDEX idx_ai_eval_runs_dataset (workspace_id,dataset_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_eval_results (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    eval_run_id BIGINT UNSIGNED NOT NULL,
    case_id BIGINT UNSIGNED NOT NULL,
    predicted_sentiment VARCHAR(30) NULL,
    predicted_category VARCHAR(100) NULL,
    predicted_severity VARCHAR(30) NULL,
    predicted_summary TEXT NULL,
    sentiment_match TINYINT(1) NOT NULL DEFAULT 0,
    category_match TINYINT(1) NOT NULL DEFAULT 0,
    severity_match TINYINT(1) NOT NULL DEFAULT 0,
    summary_match TINYINT(1) NOT NULL DEFAULT 0,
    confidence DECIMAL(6,4) NULL,
    error_message VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_eval_results_run (workspace_id,eval_run_id),
    INDEX idx_ai_eval_results_case (workspace_id,case_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_eval_baselines (
    workspace_id BIGINT UNSIGNED NOT NULL,
    dataset_id BIGINT UNSIGNED NOT NULL,
    eval_run_id BIGINT UNSIGNED NOT NULL,
    overall_score DECIMAL(8,5) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id,dataset_id)
  )`);
}


async function ensureV60LearningLoop(){
 await pool.query(`CREATE TABLE IF NOT EXISTS ai_learning_runs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,workspace_id BIGINT UNSIGNED NOT NULL,status ENUM('running','completed','failed') NOT NULL DEFAULT 'running',triggered_by BIGINT UNSIGNED NULL,signals_created INT NOT NULL DEFAULT 0,patterns_updated INT NOT NULL DEFAULT 0,evaluation_runs INT NOT NULL DEFAULT 0,regressions_seen INT NOT NULL DEFAULT 0,duration_ms INT NULL,error_message VARCHAR(1000) NULL,started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at DATETIME NULL,INDEX idx_ai_learning_runs_workspace(workspace_id,started_at))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS ai_correction_patterns (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,workspace_id BIGINT UNSIGNED NOT NULL,field_name VARCHAR(40) NOT NULL,from_value TEXT NULL,to_value TEXT NULL,pattern_hash CHAR(64) NOT NULL,occurrence_count INT NOT NULL DEFAULT 1,confidence DECIMAL(6,4) NOT NULL DEFAULT 0,explanation VARCHAR(1200) NOT NULL,status ENUM('candidate','approved','rejected') NOT NULL DEFAULT 'candidate',approved_by BIGINT UNSIGNED NULL,approved_at DATETIME NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY uniq_ai_correction_pattern_hash(workspace_id,pattern_hash),INDEX idx_ai_correction_patterns_workspace(workspace_id,status))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS ai_learning_signals (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,workspace_id BIGINT UNSIGNED NOT NULL,run_id BIGINT UNSIGNED NULL,signal_type VARCHAR(60) NOT NULL,field_name VARCHAR(40) NULL,from_value TEXT NULL,to_value TEXT NULL,evidence_count INT NOT NULL DEFAULT 1,confidence DECIMAL(6,4) NOT NULL DEFAULT 0,explanation VARCHAR(1200) NOT NULL,status ENUM('open','approved','resolved') NOT NULL DEFAULT 'open',reviewed_by BIGINT UNSIGNED NULL,reviewed_at DATETIME NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX idx_ai_learning_signals_workspace(workspace_id,status),INDEX idx_ai_learning_signals_run(workspace_id,run_id))`);
}


async function ensureV61LaunchControl(){
  await addColumn('users','platform_role',"ENUM('user','super_admin') NOT NULL DEFAULT 'user'");
  await addColumn('workspaces','plan_status',"VARCHAR(30) NOT NULL DEFAULT 'free'");
  await addColumn('workspaces','mrr','DECIMAL(12,2) NOT NULL DEFAULT 0');
  const emails=String(process.env.SUPER_ADMIN_EMAILS||process.env.SUPER_ADMIN_EMAIL||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(emails.length){ for(const email of emails) await pool.query("UPDATE users SET platform_role='super_admin' WHERE email=?",[email]); }
  await pool.query(`CREATE TABLE IF NOT EXISTS release_phases (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phase_key VARCHAR(60) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL,
    tagline VARCHAR(255) NULL,
    description TEXT NULL,
    status ENUM('draft','ready','live','paused','retired') NOT NULL DEFAULT 'draft',
    launch_enabled TINYINT(1) NOT NULL DEFAULT 0,
    launch_at DATETIME NULL,
    plan_tier VARCHAR(40) NOT NULL DEFAULT 'free',
    sort_order INT NOT NULL DEFAULT 100,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS release_features (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phase_id BIGINT UNSIGNED NOT NULL,
    feature_key VARCHAR(100) NOT NULL,
    name VARCHAR(160) NOT NULL,
    description TEXT NULL,
    teaser TEXT NULL,
    plan_tier VARCHAR(40) NOT NULL DEFAULT 'pro',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 100,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_phase_feature (phase_id,feature_key), INDEX idx_release_features_phase(phase_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS release_benchmarks (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phase_id BIGINT UNSIGNED NOT NULL,
    metric_key VARCHAR(60) NOT NULL,
    label VARCHAR(160) NOT NULL,
    target_value DECIMAL(14,2) NOT NULL DEFAULT 0,
    manual_value DECIMAL(14,2) NULL,
    gate_required TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_release_benchmarks_phase(phase_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS launch_campaigns (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phase_id BIGINT UNSIGNED NULL,
    name VARCHAR(160) NOT NULL,
    headline VARCHAR(255) NOT NULL,
    teaser VARCHAR(500) NULL,
    body TEXT NULL,
    cta_label VARCHAR(80) NULL,
    cta_url VARCHAR(500) NULL,
    audience VARCHAR(80) NOT NULL DEFAULT 'all',
    status ENUM('draft','scheduled','live','ended') NOT NULL DEFAULT 'draft',
    start_at DATETIME NULL,
    end_at DATETIME NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_campaign_phase(phase_id,status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS release_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phase_id BIGINT UNSIGNED NULL,
    campaign_id BIGINT UNSIGNED NULL,
    event_type VARCHAR(60) NOT NULL,
    actor_user_id BIGINT UNSIGNED NULL,
    detail JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_release_events_phase(phase_id,created_at)
  )`);
  const [[count]]=await pool.query('SELECT COUNT(*) c FROM release_phases');
  if(!Number(count.c)){
    const defaults=[
      ['phase-1-core','Phase 1 · Feedback Foundation','Capture the voice of the customer.','Feedback ingestion, feedback inbox, CSV import, basic classification.','free',10],
      ['phase-2-problems','Phase 2 · Problem Intelligence','Turn feedback into recurring problems.','Problem detection, similarity, priority, ownership and lifecycle.','pro',20],
      ['phase-3-intelligence','Phase 3 · Customer & Product Intelligence','Understand where pain is concentrated.','Customer, segment, journey, feature and team intelligence.','pro',30],
      ['phase-4-executive','Phase 4 · Automation & Executive Intelligence','Move from insight to coordinated action.','Automation, strategy, portfolio and executive intelligence.','business',40],
      ['phase-5-os','Phase 5 · FeedbackOS Operating System','Run the complete feedback-to-improvement loop.','Unified OS, predictive risk, governed decisions and outcomes.','business',50],
      ['phase-6-saas','Phase 6 · SaaS & Security','Operate FeedbackOS as a secure workspace.','Identity, teams, integrations, RBAC, observability and data quality.','business',60],
      ['phase-7-ai','Phase 7 · AI Intelligence Lab','Make the intelligence system measurable and adaptive.','AI governance, evaluation and human learning loop.','ai',70]
    ];
    for(const d of defaults) await pool.query('INSERT INTO release_phases(phase_key,name,tagline,description,plan_tier,sort_order) VALUES(?,?,?,?,?,?)',d);
  }
  const [[featureCount]]=await pool.query('SELECT COUNT(*) c FROM release_features');
  if(!Number(featureCount.c)){
    const [phases]=await pool.query('SELECT id,phase_key FROM release_phases');
    const featureMap={
      'phase-1-core':[['feedback-inbox','Feedback inbox','Centralize customer signals.','Capture the voice of your customers.','free'],['csv-import','CSV import','Bring existing feedback into FeedbackOS.','Turn your existing feedback into a signal library.','free'],['basic-classification','Basic AI classification','Classify sentiment, category and severity.','See what customers are saying at a glance.','free']],
      'phase-2-problems':[['problem-detection','Recurring problem detection','Group repeated feedback into problems.','Stop chasing individual complaints. Find the pattern.','pro'],['priority-ownership','Priority & ownership','Rank problems and assign accountable owners.','Know what matters and who owns it.','pro'],['problem-lifecycle','Problem lifecycle','Track investigation through resolution.','Follow every customer problem to an outcome.','pro']],
      'phase-3-intelligence':[['customer-intelligence','Customer intelligence','Understand customer risk and history.','See which customers are feeling the pain.','pro'],['journey-intelligence','Journey intelligence','Map pain across the customer journey.','Discover where experiences break.','pro'],['feature-intelligence','Product & feature intelligence','Connect feedback to features and product areas.','Know what product area is creating the most pain.','pro'],['team-accountability','Team accountability','Measure workload and ownership.','Turn customer pain into team accountability.','pro']],
      'phase-4-executive':[['automation','Governed automation','Generate reviewable automation actions.','Automate the work without losing human control.','business'],['strategy-portfolio','Strategy & portfolio','Connect customer problems to strategic initiatives.','Turn feedback into business priorities.','business'],['executive-intelligence','Executive intelligence','Give leaders a business-level view of customer pain.','See what needs attention now.','business']],
      'phase-5-os':[['feedbackos-os','FeedbackOS Operating System','Unify the complete feedback-to-improvement loop.','Run feedback like an operating system.','business'],['predictive-risk','Predictive risk','Forecast emerging customer problems.','See what could become a bigger problem next.','business'],['outcome-measurement','Outcome measurement','Measure whether interventions actually worked.','Prove that customer pain is going down.','business']],
      'phase-6-saas':[['workspaces','Multi-workspace SaaS','Manage secure customer workspaces.','Scale FeedbackOS across teams and organizations.','business'],['rbac-security','RBAC & tenant security','Control roles, sessions and tenant isolation.','Keep every workspace secure and governed.','business'],['integrations','Integrations & ingestion','Connect external feedback sources.','Bring customer signals into one system.','business'],['observability','SaaS operations','Monitor reliability, ingestion and system health.','Operate FeedbackOS with confidence.','business']],
      'phase-7-ai':[['ai-governance','AI governance','Track AI quality, confidence, cost and overrides.','Make AI measurable and accountable.','ai'],['ai-quality-lab','AI Quality Lab','Evaluate AI against golden datasets.','Prove every intelligence improvement.','ai'],['learning-loop','Human learning loop','Turn human corrections into learning signals.','Make FeedbackOS learn from your team.','ai']]
    };
    for(const p of phases){ for(const f of (featureMap[p.phase_key]||[])) await pool.query('INSERT INTO release_features(phase_id,feature_key,name,description,teaser,plan_tier,enabled,sort_order) VALUES(?,?,?,?,?,?,1,?)',[p.id,f[0],f[1],f[2],f[3],f[4],10]); }
  }
  const [[benchCount]]=await pool.query('SELECT COUNT(*) c FROM release_benchmarks');
  if(!Number(benchCount.c)){
    const [phases]=await pool.query('SELECT id,phase_key FROM release_phases');
    const gates={
      'phase-2-problems':[['total_users','Registered users',25]],
      'phase-3-intelligence':[['active_workspaces','Active workspaces',5]],
      'phase-4-executive':[['active_workspaces','Active workspaces',10],['total_users','Registered users',50]],
      'phase-5-os':[['active_workspaces','Active workspaces',25],['feedback_30d','Feedback in last 30 days',500]],
      'phase-6-saas':[['total_users','Registered users',100],['paid_workspaces','Paid workspaces',5],['mrr','Monthly recurring revenue',500]],
      'phase-7-ai':[['total_users','Registered users',250],['paid_workspaces','Paid workspaces',15],['mrr','Monthly recurring revenue',2000]]
    };
    for(const p of phases) for(const b of (gates[p.phase_key]||[])) await pool.query('INSERT INTO release_benchmarks(phase_id,metric_key,label,target_value,gate_required) VALUES(?,?,?,?,1)',[p.id,b[0],b[1],b[2]]);
  }
}

async function ensureV62ProductLaunchOS(){
  await addColumn('workspaces','plan_status',"VARCHAR(30) NOT NULL DEFAULT 'free'");
  await addColumn('workspaces','mrr','DECIMAL(12,2) NOT NULL DEFAULT 0');
  await pool.query(`CREATE TABLE IF NOT EXISTS product_plans (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,plan_key VARCHAR(40) NOT NULL UNIQUE,name VARCHAR(120) NOT NULL,description TEXT NULL,price_monthly DECIMAL(12,2) NOT NULL DEFAULT 0,price_yearly DECIMAL(12,2) NOT NULL DEFAULT 0,trial_days INT NOT NULL DEFAULT 0,sort_order INT NOT NULL DEFAULT 100,status ENUM('draft','active','retired') NOT NULL DEFAULT 'active',created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS product_features (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,feature_key VARCHAR(100) NOT NULL UNIQUE,name VARCHAR(160) NOT NULL,description TEXT NULL,release_phase_id BIGINT UNSIGNED NULL,status ENUM('draft','active','retired') NOT NULL DEFAULT 'active',sort_order INT NOT NULL DEFAULT 100,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_product_features_phase(release_phase_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS feature_flags (feature_key VARCHAR(100) PRIMARY KEY,enabled TINYINT(1) NOT NULL DEFAULT 0,rollout_percent DECIMAL(5,2) NOT NULL DEFAULT 100,release_phase_id BIGINT UNSIGNED NULL,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS plan_features (plan_key VARCHAR(40) NOT NULL,feature_key VARCHAR(100) NOT NULL,enabled TINYINT(1) NOT NULL DEFAULT 1,PRIMARY KEY(plan_key,feature_key))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS workspace_feature_overrides (workspace_id BIGINT UNSIGNED NOT NULL,feature_key VARCHAR(100) NOT NULL,enabled TINYINT(1) NOT NULL DEFAULT 1,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,PRIMARY KEY(workspace_id,feature_key))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS product_roadmap (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,phase_id BIGINT UNSIGNED NULL,title VARCHAR(180) NOT NULL,description TEXT NULL,status ENUM('idea','planned','building','beta','ready','released','cancelled') NOT NULL DEFAULT 'planned',target_date DATE NULL,sort_order INT NOT NULL DEFAULT 100,visibility ENUM('public','private') NOT NULL DEFAULT 'public',created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS product_waitlist (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,email VARCHAR(255) NOT NULL UNIQUE,name VARCHAR(160) NULL,company VARCHAR(160) NULL,phase_key VARCHAR(60) NULL,source VARCHAR(80) NULL,status ENUM('waiting','invited','converted','unsubscribed') NOT NULL DEFAULT 'waiting',created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS upgrade_prompts (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,name VARCHAR(160) NOT NULL,feature_key VARCHAR(100) NULL,plan_from VARCHAR(40) NOT NULL DEFAULT 'any',plan_to VARCHAR(40) NOT NULL DEFAULT 'pro',headline VARCHAR(255) NOT NULL,body TEXT NULL,cta_label VARCHAR(80) NOT NULL DEFAULT 'Upgrade',cta_url VARCHAR(500) NULL,enabled TINYINT(1) NOT NULL DEFAULT 1,priority INT NOT NULL DEFAULT 100,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS upgrade_events (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,workspace_id BIGINT UNSIGNED NULL,user_id BIGINT UNSIGNED NULL,feature_key VARCHAR(100) NULL,event_type VARCHAR(60) NOT NULL,from_plan VARCHAR(40) NULL,to_plan VARCHAR(40) NULL,metadata JSON NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX idx_upgrade_events_workspace(workspace_id,created_at),INDEX idx_upgrade_events_feature(feature_key,event_type))`);
  const [[pc]]=await pool.query('SELECT COUNT(*) c FROM product_plans'); if(!Number(pc.c)){const plans=[['free','Free','Start capturing customer feedback',0,0,0,10],['pro','Pro','Turn feedback into intelligence',49,490,14,20],['business','Business','Coordinate action across teams',149,1490,14,30],['ai','AI','Advanced governed AI intelligence',299,2990,14,40]];for(const p of plans)await pool.query('INSERT INTO product_plans(plan_key,name,description,price_monthly,price_yearly,trial_days,sort_order) VALUES(?,?,?,?,?,?,?)',p);}
  const [[fc]]=await pool.query('SELECT COUNT(*) c FROM product_features'); if(!Number(fc.c)){const [ph]=await pool.query('SELECT id,phase_key FROM release_phases');const pm=Object.fromEntries(ph.map(x=>[x.phase_key,x.id]));const fs=[['feedback_foundation','Feedback Foundation','Capture and organize feedback',pm['phase-1-core']],['problem_intelligence','Problem Intelligence','Recurring problems, priority and ownership',pm['phase-2-problems']],['customer_product_intelligence','Customer & Product Intelligence','Customer, journey and feature intelligence',pm['phase-3-intelligence']],['executive_automation','Automation & Executive Intelligence','Automations, strategy and executive intelligence',pm['phase-4-executive']],['feedbackos_os','FeedbackOS Operating System','Predictive, governed operating loop',pm['phase-5-os']],['saas_security','SaaS & Security','Workspace, security and operational controls',pm['phase-6-saas']],['ai_intelligence_lab','AI Intelligence Lab','AI governance, evaluation and learning',pm['phase-7-ai']]];for(let i=0;i<fs.length;i++){const f=fs[i];await pool.query('INSERT INTO product_features(feature_key,name,description,release_phase_id,sort_order) VALUES(?,?,?,?,?)',[f[0],f[1],f[2],f[3],(i+1)*10]);await pool.query('INSERT INTO feature_flags(feature_key,enabled,rollout_percent,release_phase_id) VALUES(?,0,100,?)',[f[0],f[3]]);}}
  const [[pfc]]=await pool.query('SELECT COUNT(*) c FROM plan_features'); if(!Number(pfc.c)){const matrix={free:['feedback_foundation'],pro:['feedback_foundation','problem_intelligence','customer_product_intelligence'],business:['feedback_foundation','problem_intelligence','customer_product_intelligence','executive_automation','feedbackos_os','saas_security'],ai:['feedback_foundation','problem_intelligence','customer_product_intelligence','executive_automation','feedbackos_os','saas_security','ai_intelligence_lab']};for(const [plan,keys] of Object.entries(matrix))for(const k of keys)await pool.query('INSERT INTO plan_features(plan_key,feature_key,enabled) VALUES(?,?,1)',[plan,k]);}
  const [[wc]]=await pool.query('SELECT COUNT(*) c FROM upgrade_prompts');if(!Number(wc.c)){await pool.query("INSERT INTO upgrade_prompts(name,feature_key,plan_from,plan_to,headline,body,cta_label,priority) VALUES('Problem Intelligence unlock','problem_intelligence','free','pro','Turn feedback into recurring problems','See what customers are repeatedly struggling with and prioritize what matters.','Unlock Problem Intelligence',100)");await pool.query("INSERT INTO upgrade_prompts(name,feature_key,plan_from,plan_to,headline,body,cta_label,priority) VALUES('AI Intelligence Lab','ai_intelligence_lab','business','ai','Meet the next intelligence layer','Govern, evaluate and continuously improve AI-powered feedback intelligence.','Join AI tier',90)");}
}

async function ensureV63LaunchExperience(){
  await pool.query(`CREATE TABLE IF NOT EXISTS release_experiences (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,phase_id BIGINT UNSIGNED NULL,experience_key VARCHAR(80) NOT NULL UNIQUE,stage ENUM('teaser','waitlist','beta','launched','ended') NOT NULL DEFAULT 'teaser',headline VARCHAR(255) NOT NULL,subheadline TEXT NULL,body TEXT NULL,cta_label VARCHAR(100) NULL,cta_url VARCHAR(500) NULL,feature_key VARCHAR(100) NULL,enabled TINYINT(1) NOT NULL DEFAULT 1,priority INT NOT NULL DEFAULT 100,start_at DATETIME NULL,end_at DATETIME NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_release_experience_stage(stage,enabled))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS beta_access (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,workspace_id BIGINT UNSIGNED NOT NULL,user_id BIGINT UNSIGNED NULL,phase_id BIGINT UNSIGNED NULL,feature_key VARCHAR(100) NULL,status ENUM('invited','active','revoked','converted') NOT NULL DEFAULT 'invited',source VARCHAR(80) NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY uq_beta_access(workspace_id,feature_key))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS release_events (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,workspace_id BIGINT UNSIGNED NULL,user_id BIGINT UNSIGNED NULL,phase_id BIGINT UNSIGNED NULL,feature_key VARCHAR(100) NULL,event_type VARCHAR(60) NOT NULL,metadata JSON NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX idx_release_events_workspace(workspace_id,created_at),INDEX idx_release_events_type(event_type,created_at))`);
  const [[c]]=await pool.query('SELECT COUNT(*) c FROM release_experiences');
  if(!Number(c.c)){
    const [ph]=await pool.query("SELECT id,phase_key,name FROM release_phases ORDER BY sort_order,id");
    const rows=[];
    for(const x of ph){
      const stage=x.phase_key==='phase-1-core'?'launched':'teaser';
      rows.push([x.id,x.phase_key+'-experience',stage,stage==='launched'?x.name+' is live':x.name+' is coming soon',stage==='launched'?'Explore what is available now':'Be among the first to experience the next FeedbackOS release.',stage==='launched'?'The latest capabilities are available to eligible workspaces.':'We are preparing the next phase. Join the early-access list and get notified when it launches.','Join early access','',null,1,100]);
    }
    for(const r of rows) await pool.query('INSERT INTO release_experiences(phase_id,experience_key,stage,headline,subheadline,body,cta_label,cta_url,feature_key,enabled,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?)',r);
  }
}

async function ensureV64LaunchAnalytics(){
  await pool.query(`CREATE TABLE IF NOT EXISTS launch_analytics_snapshots (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,period_days INT NOT NULL DEFAULT 30,total_users INT NOT NULL DEFAULT 0,active_workspaces INT NOT NULL DEFAULT 0,paid_workspaces INT NOT NULL DEFAULT 0,mrr DECIMAL(12,2) NOT NULL DEFAULT 0,teaser_views INT NOT NULL DEFAULT 0,announcement_views INT NOT NULL DEFAULT 0,waitlist_signups INT NOT NULL DEFAULT 0,beta_activations INT NOT NULL DEFAULT 0,feature_views INT NOT NULL DEFAULT 0,upgrade_prompts INT NOT NULL DEFAULT 0,checkout_starts INT NOT NULL DEFAULT 0,upgrades INT NOT NULL DEFAULT 0,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,INDEX idx_launch_snapshot_created(created_at))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS launch_goals (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,name VARCHAR(160) NOT NULL,metric_key VARCHAR(60) NOT NULL,target_value DECIMAL(14,2) NOT NULL DEFAULT 0,due_date DATE NULL,status ENUM('active','achieved','paused','cancelled') NOT NULL DEFAULT 'active',notes TEXT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_launch_goals_status(status))`);
  const [[gc]]=await pool.query('SELECT COUNT(*) c FROM launch_goals');
  if(!Number(gc.c)){for(const g of [['Validate paid demand','paid_workspaces',5,null,'Initial proof of willingness to pay'],['Reach launch revenue signal','mrr',500,null,'First recurring revenue milestone'],['Build feedback volume','feedback_30d',500,null,'Enough activity to validate intelligence value']]) await pool.query('INSERT INTO launch_goals(name,metric_key,target_value,due_date,notes) VALUES(?,?,?,?,?)',g);}
}


async function ensureV65Experimentation(){
  await pool.query(`CREATE TABLE IF NOT EXISTS launch_experiments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    experiment_key VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(180) NOT NULL,
    phase_id BIGINT UNSIGNED NULL,
    feature_key VARCHAR(100) NULL,
    hypothesis TEXT NULL,
    metric_key VARCHAR(80) NOT NULL DEFAULT 'upgrade_completed',
    status ENUM('draft','running','paused','completed') NOT NULL DEFAULT 'draft',
    audience VARCHAR(80) NOT NULL DEFAULT 'all',
    start_at DATETIME NULL,
    end_at DATETIME NULL,
    winner_variant_id BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_launch_experiments_status(status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS launch_experiment_variants (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    experiment_id BIGINT UNSIGNED NOT NULL,
    variant_key VARCHAR(80) NOT NULL,
    name VARCHAR(160) NOT NULL,
    headline VARCHAR(255) NULL,
    body TEXT NULL,
    cta_label VARCHAR(100) NULL,
    cta_url VARCHAR(500) NULL,
    price_message VARCHAR(255) NULL,
    allocation_percent DECIMAL(5,2) NOT NULL DEFAULT 50,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_launch_variant(experiment_id,variant_key),
    INDEX idx_launch_variant_experiment(experiment_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS launch_experiment_assignments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    experiment_id BIGINT UNSIGNED NOT NULL,
    variant_id BIGINT UNSIGNED NOT NULL,
    workspace_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    subject_key VARCHAR(160) NOT NULL,
    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_launch_assignment(experiment_id,subject_key),
    INDEX idx_launch_assignment_variant(variant_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS launch_experiment_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    experiment_id BIGINT UNSIGNED NOT NULL,
    variant_id BIGINT UNSIGNED NULL,
    workspace_id BIGINT UNSIGNED NULL,
    user_id BIGINT UNSIGNED NULL,
    subject_key VARCHAR(160) NULL,
    event_type VARCHAR(80) NOT NULL,
    value DECIMAL(14,2) NULL,
    metadata JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_launch_exp_events_exp(experiment_id,created_at),
    INDEX idx_launch_exp_events_variant(variant_id,event_type,created_at)
  )`);
}


async function ensureV67Retention(){
  await pool.query(`CREATE TABLE IF NOT EXISTS retention_snapshots (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    period_days INT NOT NULL DEFAULT 90,
    customers INT NOT NULL DEFAULT 0,
    average_health DECIMAL(6,2) NOT NULL DEFAULT 0,
    churn_risk INT NOT NULL DEFAULT 0,
    at_risk INT NOT NULL DEFAULT 0,
    stable INT NOT NULL DEFAULT 0,
    expansion INT NOT NULL DEFAULT 0,
    revenue_at_risk DECIMAL(14,2) NOT NULL DEFAULT 0,
    summary_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_retention_snapshot_workspace(workspace_id,created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS retention_scores (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    customer_key VARCHAR(255) NOT NULL,
    health_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    risk_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    status ENUM('churn_risk','at_risk','stable','expansion') NOT NULL DEFAULT 'stable',
    feedback_30d INT NOT NULL DEFAULT 0,
    negative_rate DECIMAL(6,2) NOT NULL DEFAULT 0,
    revenue_at_risk DECIMAL(14,2) NOT NULL DEFAULT 0,
    signals_json JSON NULL,
    scored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_retention_customer(workspace_id,customer_key),
    INDEX idx_retention_status(workspace_id,status)
  )`);
}

async function ensureV66Monetization(){
  await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    plan_key VARCHAR(40) NOT NULL,
    status ENUM('trialing','active','past_due','paused','canceled') NOT NULL DEFAULT 'trialing',
    billing_cycle ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
    price DECIMAL(12,2) NOT NULL DEFAULT 0,
    mrr DECIMAL(12,2) NOT NULL DEFAULT 0,
    trial_ends_at DATETIME NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    renews_at DATETIME NULL,
    canceled_at DATETIME NULL,
    provider VARCHAR(40) NOT NULL DEFAULT 'manual',
    provider_customer_id VARCHAR(160) NULL,
    provider_subscription_id VARCHAR(160) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_active_subscription_workspace(workspace_id,status),
    INDEX idx_subscriptions_workspace(workspace_id,created_at),
    INDEX idx_subscriptions_plan(plan_key,status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS billing_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    subscription_id BIGINT UNSIGNED NULL,
    event_type VARCHAR(60) NOT NULL,
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    plan_key VARCHAR(40) NULL,
    metadata JSON NULL,
    occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_billing_events_workspace(workspace_id,occurred_at),
    INDEX idx_billing_events_type(event_type,occurred_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS revenue_attributions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    feature_key VARCHAR(100) NULL,
    phase_id BIGINT UNSIGNED NULL,
    event_id BIGINT UNSIGNED NULL,
    attribution_type ENUM('first_touch','influenced','conversion') NOT NULL DEFAULT 'influenced',
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_revenue_attr_feature(feature_key,created_at),
    INDEX idx_revenue_attr_workspace(workspace_id,created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS billing_intents (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    workspace_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NULL,
    from_plan VARCHAR(40) NOT NULL,
    to_plan VARCHAR(40) NOT NULL,
    source VARCHAR(80) NULL,
    status ENUM('requested','reviewed','converted','dismissed') NOT NULL DEFAULT 'requested',
    metadata JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_billing_intents_workspace(workspace_id,created_at),
    INDEX idx_billing_intents_status(status,created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pricing_experiments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    experiment_id BIGINT UNSIGNED NOT NULL,
    plan_key VARCHAR(40) NOT NULL,
    control_price DECIMAL(12,2) NOT NULL,
    challenger_price DECIMAL(12,2) NOT NULL,
    status ENUM('draft','active','completed') NOT NULL DEFAULT 'draft',
    winner VARCHAR(30) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pricing_experiment(experiment_id)
  )`);
  const [[subCount]]=await pool.query('SELECT COUNT(*) c FROM subscriptions');
  if(!Number(subCount.c)){
    const [ws]=await pool.query("SELECT id,plan_status,mrr FROM workspaces WHERE plan_status<>'free' OR mrr>0");
    for(const w of ws){
      const plan=['pro','business','ai'].includes(w.plan_status)?w.plan_status:'pro';
      const [[p]]=await pool.query('SELECT price_monthly FROM product_plans WHERE plan_key=?',[plan]);
      const price=Number(w.mrr||p?.price_monthly||0);
      await pool.query("INSERT INTO subscriptions(workspace_id,plan_key,status,billing_cycle,price,mrr,provider) VALUES(?,?,?,?,?,?,?)",[w.id,plan,'active','monthly',price,price,'legacy']);
    }
  }
}

module.exports = async function migrateV61() {
  await migrate();
  await ensureWorkspaceColumns();
  await ensureV52Tables();
  await ensureV54SecurityColumns();
  await ensureV55ControlPlane();
  await ensureV56Observability();
  await ensureV57Quality();
  await ensureV58AIGovernance();
  await ensureV59AIEvaluation();
 await ensureV60LearningLoop();
  await ensureV61LaunchControl();
  await ensureV62ProductLaunchOS();
  await ensureV63LaunchExperience();
  await ensureV64LaunchAnalytics();
  await ensureV65Experimentation();
  await ensureV66Monetization();
  await ensureV67Retention();
};
