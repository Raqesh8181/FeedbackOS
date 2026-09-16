const test = require('node:test');
const assert = require('node:assert/strict');
const { textMatch, scoreCase, aggregateResults, regression, validateCase } = require('../services/aiEvaluation');

test('evaluation normalizes exact text matches', () => assert.equal(textMatch(' Payment Failure ', 'payment-failure'), true));
test('evaluation scores four fields', () => {
  const r = scoreCase({sentiment:'negative',category:'billing',severity:'high',summary:'Payment failed'}, {sentiment:'negative',category:'billing',severity:'high',summary:'Different'});
  assert.equal(r.sentiment_match, true); assert.equal(r.category_match, true); assert.equal(r.severity_match, true); assert.equal(r.summary_match, false); assert.equal(r.score, .75);
});
test('evaluation aggregates accuracy', () => {
  const r = aggregateResults([{sentiment_match:true,category_match:true,severity_match:false,summary_match:false},{sentiment_match:true,category_match:false,severity_match:true,summary_match:true}]);
  assert.equal(r.sentiment_accuracy,1); assert.equal(r.category_accuracy,.5); assert.equal(r.severity_accuracy,.5); assert.equal(r.summary_match_rate,.5); assert.equal(r.overall_score,.625);
});
test('evaluation detects meaningful regression', () => assert.equal(regression(.9,.82,.05), true));
test('evaluation accepts valid golden case', () => assert.equal(validateCase({input_text:'Checkout failed',sentiment:'negative',severity:'high'}), true));
test('evaluation rejects invalid golden case', () => assert.throws(()=>validateCase({input_text:'x',sentiment:'angry'}),/Invalid expected sentiment/));
