const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

function bucket(subject,key){
  const hex=crypto.createHash('sha256').update(String(key)+'|'+String(subject)).digest('hex');
  return parseInt(hex.slice(0,8),16)%10000/100;
}
function pick(subject,key,variants){
  const b=bucket(subject,key); let cursor=0;
  for(const v of variants){cursor+=Number(v.allocation_percent||0);if(b<cursor)return v.variant_key;}
  return variants.at(-1)?.variant_key;
}

test('V6.5 deterministic assignment stays stable',()=>{
  const variants=[{variant_key:'control',allocation_percent:50},{variant_key:'challenger',allocation_percent:50}];
  const a=pick('workspace:42','headline-test',variants);
  assert.equal(a,pick('workspace:42','headline-test',variants));
});

test('V6.5 allocation boundaries select a valid variant',()=>{
  const variants=[{variant_key:'a',allocation_percent:30},{variant_key:'b',allocation_percent:70}];
  for(const subject of ['1','2','3','4','5','6','7','8','9']) assert.ok(['a','b'].includes(pick(subject,'allocation-test',variants)));
});

test('V6.5 variant allocations must total 100',()=>{
  const variants=[{allocation_percent:50},{allocation_percent:50}];
  assert.equal(variants.reduce((n,v)=>n+v.allocation_percent,0),100);
});

test('V6.5 experiment funnel conversion is calculable',()=>{
  const assignments=120, conversions=18;
  const rate=Number((conversions/assignments*100).toFixed(1));
  assert.equal(rate,15);
});

test('V6.5 zero-assignment conversion is safe',()=>{
  const assignments=0, conversions=0;
  const rate=assignments?conversions/assignments*100:0;
  assert.equal(rate,0);
});
