const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAnalysis, confidenceFor, estimateCost, PROMPT_VERSION } = require('../services/aiGovernance');

test('AI governance validates structured output', () => {
  const a = validateAnalysis({sentiment:'negative',category:'payments',severity:'high',summary:'Payment failed during checkout.'});
  assert.equal(a.sentiment,'negative');
});
test('AI governance rejects invalid model output', () => {
  assert.throws(() => validateAnalysis({sentiment:'angry',category:'x',severity:'high',summary:'x'}), /invalid sentiment/);
});
test('AI confidence stays bounded', () => {
  const score = confidenceFor({sentiment:'negative',severity:'high',category:'billing',summary:'Short summary'});
  assert(score >= 0 && score <= 0.99);
});
test('AI cost estimate is deterministic', () => {
  process.env.OPENAI_INPUT_COST_PER_1M='1';
  process.env.OPENAI_OUTPUT_COST_PER_1M='2';
  assert.equal(estimateCost({input_tokens:100000,output_tokens:50000}),0.2);
});
test('AI prompt version is explicit', () => assert.equal(PROMPT_VERSION,'feedback-analysis-v1'));
