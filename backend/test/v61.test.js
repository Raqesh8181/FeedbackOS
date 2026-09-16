const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrate.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'services', 'authService.js'), 'utf8');
const html = fs.readFileSync(path.join(root, '..', 'frontend', 'public', 'index.html'), 'utf8');

test('V6.1 has a dedicated super-admin authorization boundary', () => {
  assert.match(server, /function requireSuperAdmin/);
  assert.match(server, /platform_role!=='super_admin'/);
  assert.match(server, /\/api\/superadmin\/overview/);
  assert.match(server, /\/api\/superadmin\/phases\/.*\/launch/);
});

test('V6.1 release phases and launch gates exist', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS release_phases/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS release_benchmarks/);
  assert.match(server, /Launch gate not reached/);
  assert.match(server, /force/);
});

test('V6.1 supports staged features and campaigns', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS release_features/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS launch_campaigns/);
  assert.match(server, /\/api\/superadmin\/phases\/.*\/features/);
  assert.match(server, /\/api\/superadmin\/campaigns/);
});

test('V6.1 exposes live release messaging to workspace users', () => {
  assert.match(server, /\/api\/release\/status/);
  assert.match(server, /launch_enabled=1/);
  assert.match(html, /id="releaseBanner"/);
  assert.match(html, /loadReleaseBanner/);
});

test('V6.1 supports measurable growth benchmarks', () => {
  for (const metric of ['total_users','active_workspaces','feedback_30d','paid_workspaces','mrr','retention_30d']) {
    assert.match(server, new RegExp(metric));
  }
  assert.match(migration, /plan_status/);
  assert.match(migration, /mrr/);
});

test('V6.1 super admin UI is hidden from normal workspace users', () => {
  assert.match(html, /id="superAdminNav"[^>]*display:none/);
  assert.match(html, /platform_role==='super_admin'/);
  assert.match(html, /id="superadmin" class="view"/);
});

test('V6.1 public user payload carries platform role', () => {
  assert.match(auth, /platform_role: row\.platform_role/);
  assert.match(server, /u\.platform_role/);
});
