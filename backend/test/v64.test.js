const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('V6.4 launch analytics artifacts exist',()=>{assert.equal(fs.existsSync(path.join(__dirname,'..','migrate.js')),true);assert.equal(fs.existsSync(path.join(__dirname,'..','server.js')),true);assert.equal(fs.existsSync(path.join(__dirname,'..','..','frontend','public','index.html')),true)});
test('V6.4 analytics APIs are protected by super admin',()=>{const s=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');for(const x of ['/api/superadmin/launch-analytics','/api/superadmin/launch-analytics/snapshot','/api/superadmin/launch-goals']){const i=s.indexOf(`'${x}'`);assert.ok(i>=0);assert.ok(s.slice(i,i+220).includes('requireSuperAdmin'));}});
test('V6.4 funnel contains demand-to-revenue stages',()=>{const s=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');for(const x of ['teaser_views','waitlist_signups','beta_activations','checkout_starts','upgrades'])assert.match(s,new RegExp(x));});
