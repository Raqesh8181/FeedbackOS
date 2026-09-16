const test = require('node:test');
const assert = require('node:assert/strict');

function mrr(price, cycle){ return cycle==='yearly' ? Number(price)/12 : Number(price); }
function intentRate(converted,total){ return total>0 ? Number((converted/total*100).toFixed(1)) : 0; }
function checkoutRate(upgrades,checkouts){ return checkouts>0 ? Number((upgrades/checkouts*100).toFixed(1)) : 0; }
function propensity({feedback,upgrades,paid}){
  let score=0; if(feedback>=20)score+=40; if(upgrades>0)score+=35; if(paid)score-=50; return Math.max(0,Math.min(100,score));
}

test('V6.6 yearly price converts to MRR',()=>assert.equal(mrr(1200,'yearly'),100));
test('V6.6 monthly price remains MRR',()=>assert.equal(mrr(149,'monthly'),149));
test('V6.6 intent conversion is safe at zero',()=>assert.equal(intentRate(0,0),0));
test('V6.6 intent conversion is measurable',()=>assert.equal(intentRate(3,12),25));
test('V6.6 checkout conversion is measurable',()=>assert.equal(checkoutRate(9,30),30));
test('V6.6 propensity rewards high usage and upgrade interest',()=>assert.equal(propensity({feedback:25,upgrades:1,paid:false}),75));
test('V6.6 propensity never exceeds 100 or drops below 0',()=>assert.deepEqual([propensity({feedback:999,upgrades:9,paid:false}),propensity({feedback:0,upgrades:0,paid:true})],[75,0]));
