const test=require('node:test');
const assert=require('node:assert/strict');
function health({negativeRate=0,recurrence=0,unresolved=0,severity=0,positive=0,negative=0}){let risk=negativeRate*45+Math.min(1,recurrence)*20+Math.min(1,unresolved/3)*20+Math.min(1,severity)*15;if(positive>negative)risk-=10;return Math.max(0,Math.min(100,Math.round(100-risk)));}
function status(score,positive,negative,negativeRate){return score<30?'churn_risk':score<55?'at_risk':(positive>=Math.max(2,negative*2)&&negativeRate<.25?'expansion':'stable');}
function riskRevenue(mrr,customers,riskCustomers){return customers?Number((mrr*(riskCustomers/customers)).toFixed(2)):0;}
test('V6.7 healthy customer score stays high',()=>assert.equal(health({negativeRate:0,positive:5,negative:0}),100));
test('V6.7 repeated negative feedback lowers health',()=>assert.ok(health({negativeRate:.8,recurrence:1,unresolved:2,severity:1,positive:0,negative:8})<30));
test('V6.7 expansion status requires strong positive signal',()=>assert.equal(status(90,6,1,.1),'expansion'));
test('V6.7 high risk status is explicit',()=>assert.equal(status(20,0,8,.8),'churn_risk'));
test('V6.7 revenue at risk allocates only the risky customer share',()=>assert.equal(riskRevenue(1000,10,3),300));
test('V6.7 revenue at risk is safe with no customers',()=>assert.equal(riskRevenue(1000,0,3),0));
