const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname,'..');
const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
const migration = fs.readFileSync(path.join(root,'migrate.js'),'utf8');
const frontend = fs.readFileSync(path.join(root,'..','frontend','public','index.html'),'utf8');

test('V6.2 has product feature flags and plan entitlements',()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_features/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS feature_flags/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS plan_features/);
});
test('V6.2 has pricing and conversion telemetry',()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_plans/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS upgrade_events/);
  assert.match(server,/\/api\/product\/upgrade-events/);
});
test('V6.2 has waitlist and roadmap control',()=>{
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_waitlist/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_roadmap/);
  assert.match(server,/\/api\/superadmin\/roadmap/);
  assert.match(server,/\/api\/waitlist/);
});
test('V6.2 protects product control plane with super admin role',()=>{
  assert.match(server,/requirePlatformRole\(req,res\)/);
  assert.match(server,/\/api\/superadmin\/product/);
  assert.match(server,/\/api\/superadmin\/flags/);
});
test('V6.2 exposes a dedicated Product Launch OS UI',()=>{
  assert.match(frontend,/id=\"product\"/);
  assert.match(frontend,/Product Launch OS/);
  assert.match(frontend,/productNav/);
});
