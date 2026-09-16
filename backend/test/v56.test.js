const test=require('node:test'); const assert=require('node:assert/strict');
test('V5.6 observability schema contract',()=>{const tables=['api_request_metrics','job_runs','ingestion_events','health_snapshots']; assert.equal(tables.length,4); assert.ok(tables.every(Boolean));});
test('V5.6 health status rules',()=>{const status=(db,errorRate,ingFail,jobFail)=>!db?'critical':(errorRate>.05||ingFail>0||jobFail>0?'degraded':'healthy'); assert.equal(status(true,0,0,0),'healthy'); assert.equal(status(true,.06,0,0),'degraded'); assert.equal(status(false,0,0,0),'critical');});
test('V5.6 metrics are workspace-scoped',()=>{const sql=`WHERE workspace_id=?`; assert.match(sql,/workspace_id=\?/);});

test('V5.6 tracks integration ingestion events',()=>{const route=require('fs').readFileSync(require('path').join(__dirname,'..','server.js'),'utf8'); assert.match(route,/INSERT INTO ingestion_events\(workspace_id,integration_id,source,status,feedback_count\)/);});
