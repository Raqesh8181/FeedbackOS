require('dotenv').config();
const pool = require('../db');

(async () => {
  try {
    const [[db]] = await pool.query('SELECT DATABASE() database_name');
    const required = ['workspaces','users','workspace_members','sessions','invitations','integrations','api_keys','api_key_scopes','audit_logs','security_events'];
    const [tables] = await pool.query(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${required.map(()=>'?').join(',')})`, required);
    const found = new Set(tables.map(x=>x.TABLE_NAME));
    const missing = required.filter(x=>!found.has(x));
    if (missing.length) throw new Error(`Missing tables: ${missing.join(', ')}`);
    const [[members]] = await pool.query('SELECT COUNT(*) count FROM workspace_members');
    const [[nullScopes]] = await pool.query('SELECT COUNT(*) count FROM api_keys k LEFT JOIN api_key_scopes s ON s.api_key_id=k.id WHERE s.id IS NULL AND k.revoked_at IS NULL');
    console.log(JSON.stringify({ok:true,database:db.database_name,required_tables:required.length,workspace_members:Number(members.count||0),active_keys_without_scope:Number(nullScopes.count||0)},null,2));
  } catch (e) {
    console.error(JSON.stringify({ok:false,error:e.message},null,2));
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
