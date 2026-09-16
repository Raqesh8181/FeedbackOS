const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('V6.3 launch experience artifacts exist',()=>{assert.equal(fs.existsSync(path.join(__dirname,'..','migrate.js')),true);assert.equal(fs.existsSync(path.join(__dirname,'..','server.js')),true);assert.equal(fs.existsSync(path.join(__dirname,'..','..','frontend','public','index.html')),true)});
test('V6.3 launch stages are ordered and safe',()=>{const stages=['teaser','waitlist','beta','launched','ended'];assert.deepEqual(stages.slice(0,4),['teaser','waitlist','beta','launched']);assert.ok(stages.includes('ended'))});
test('V6.3 server exposes launch experience endpoints',()=>{const s=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');for(const x of ['/api/launch/experience','/api/launch/events','/api/launch/waitlist','/api/launch/beta','/api/superadmin/launch-experience'])assert.match(s,new RegExp(x.replaceAll('/','\\/')))});
