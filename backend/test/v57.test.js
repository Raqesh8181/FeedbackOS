const test=require('node:test'); const assert=require('node:assert/strict'); const {normalizeMessage,fingerprint,qualityScore}=require('../services/dataQuality');
test('normalizes equivalent feedback',()=>assert.equal(normalizeMessage('  App  CRASHED!!! '),'app crashed'));
test('fingerprints normalized duplicates identically',()=>assert.equal(fingerprint('Payment failed!'),fingerprint(' payment   failed ')));
test('quality score penalizes defects but stays bounded',()=>{const s=qualityScore({total:10,duplicate:1,issues:1,lowConfidence:1,aiFailures:1});assert(s<100&&s>=0)});
test('empty dataset remains healthy',()=>assert.equal(qualityScore({total:0,duplicate:0,issues:0,lowConfidence:0,aiFailures:0}),100));
