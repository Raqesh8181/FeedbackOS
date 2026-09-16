const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const migrate = fs.readFileSync(path.join(root, 'migrate.js'), 'utf8');

test('V5.4 exposes an explicit RBAC matrix', () => {
  assert.match(server, /const RBAC_MATRIX\s*=\s*\{/);
  assert.match(server, /admin:\s*\[/);
  assert.match(server, /manager:\s*\[/);
  assert.match(server, /member:\s*\[/);
  assert.match(server, /integration:\s*\[/);
  assert.match(server, /\/api\/security\/rbac/);
});

test('manager and admin boundaries exist for team lifecycle', () => {
  assert.match(server, /requireManager\(req,res\)/);
  assert.match(server, /\/api\/workspace\/invitations\/:id\/revoke/);
  assert.match(server, /\/api\/workspace\/invitations\/:id\/resend/);
  assert.match(server, /\/api\/workspace\/members\/:userId/);
  assert.match(server, /role must be admin, manager, or member/);
});

test('session security controls exist', () => {
  assert.match(server, /\/api\/security\/sessions/);
  assert.match(server, /last_seen_at/);
  assert.match(server, /security\.session\.revoked/);
});

test('V5.4 migration is upgrade-safe', () => {
  assert.match(migrate, /ensureV54SecurityColumns/);
  assert.match(migrate, /addColumn\('invitations','revoked_at'/);
  assert.match(migrate, /addColumn\('sessions','last_seen_at'/);
  assert.match(migrate, /addColumn\('sessions','ip_address'/);
  assert.match(migrate, /addColumn\('sessions','user_agent'/);
});

test('tenant context remains part of API middleware', () => {
  assert.match(server, /runTenantContext\(req\.user\.workspace_id, next\)/);
});


test('V5.5 adds workspace switching and scoped control-plane APIs', () => {
  assert.match(server, /\/api\/workspaces/);
  assert.match(server, /workspace\.switched/);
  assert.match(server, /API_KEY_SCOPES/);
  assert.match(server, /\/api\/audit\/export/);
  assert.match(server, /security_policies/);
});
