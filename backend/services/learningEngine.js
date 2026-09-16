const OpenAI = require('openai');

function pct(n) { return Math.round(Number(n || 0) * 10) / 10; }

function actionOutcomeLabel(status) {
  return ({ met: 'Met', partial: 'Partial', missed: 'Missed', no_baseline: 'No baseline' }[status] || 'Unmeasured');
}

function buildLearningInsights(data) {
  const measured = data.actionOutcomes.filter(a => ['met','partial','missed'].includes(a.outcome_status));
  const positive = measured.filter(a => Number(a.actual_impact_percent) > 0);
  const avgImpact = measured.length ? pct(measured.reduce((s,a)=>s+Number(a.actual_impact_percent||0),0) / measured.length) : 0;
  const avgTarget = measured.filter(a=>a.expected_impact_percent!=null).length
    ? pct(measured.filter(a=>a.expected_impact_percent!=null).reduce((s,a)=>s+Number(a.expected_impact_percent||0),0) / measured.filter(a=>a.expected_impact_percent!=null).length) : 0;
  const targetAccuracy = measured.filter(a=>a.expected_impact_percent!=null).length
    ? pct(measured.filter(a=>a.expected_impact_percent!=null).reduce((s,a)=>s + (Number(a.actual_impact_percent||0) >= Number(a.expected_impact_percent||0) ? 1 : 0),0) / measured.filter(a=>a.expected_impact_percent!=null).length * 100) : 0;

  const byType = {};
  for (const a of measured) {
    const type = a.category || 'General';
    byType[type] ||= { category:type, count:0, met:0, avg_impact:0, total_impact:0 };
    byType[type].count++; byType[type].total_impact += Number(a.actual_impact_percent||0);
    if (a.outcome_status === 'met') byType[type].met++;
  }
  const actionPatterns = Object.values(byType).map(x => ({ category:x.category, count:x.count, success_rate:pct(x.met/x.count*100), avg_impact:pct(x.total_impact/x.count) }))
    .sort((a,b)=>b.avg_impact-a.avg_impact);

  const teamMap = {};
  for (const p of data.problems) {
    const team = p.owner || p.recommended_team || 'Unassigned';
    teamMap[team] ||= { owner:team, problems:0, resolved:0, avg_resolution_days:null };
    teamMap[team].problems++; if (p.resolved_at) teamMap[team].resolved++;
  }
  const resolutionTimes = data.problems.filter(p=>p.resolved_at && p.first_detected_at).map(p=>({owner:p.owner||p.recommended_team||'Unassigned',days:Math.max(0,(new Date(p.resolved_at)-new Date(p.first_detected_at))/86400000)}));
  for(const x of resolutionTimes) { if(teamMap[x.owner]) { const t=teamMap[x.owner]; t._days=(t._days||0)+x.days; t._n=(t._n||0)+1; t.avg_resolution_days=pct(t._days/t._n); } }
  const teams=Object.values(teamMap).map(({_days,_n,...x})=>x).sort((a,b)=>(b.resolved-b.problems)-(a.resolved-a.problems));

  const recurring = data.problems.filter(p => Number(p.feedback_count||0) >= 2 && p.status !== 'resolved').sort((a,b)=>Number(b.feedback_count||0)-Number(a.feedback_count||0)).slice(0,8)
    .map(p=>({id:p.id,title:p.title,feedback_count:Number(p.feedback_count||0),health:p.health,priority:p.priority,owner:p.owner||p.recommended_team||'Unassigned'}));

  const lessons=[];
  if(measured.length) lessons.push(`${positive.length} of ${measured.length} measured actions produced a reduction in negative feedback.`);
  if(avgImpact) lessons.push(`Measured actions changed negative feedback by ${avgImpact}% on average; the average target was ${avgTarget}%.`);
  if(actionPatterns.length) lessons.push(`The strongest observed action category is ${actionPatterns[0].category}, averaging ${actionPatterns[0].avg_impact}% impact across ${actionPatterns[0].count} measured action${actionPatterns[0].count===1?'':'s'}.`);
  if(recurring.length) lessons.push(`${recurring.length} recurring open problems still have enough evidence to reuse prior intervention patterns.`);
  if(!lessons.length) lessons.push('Complete and measure more actions to create reliable learning signals.');

  const recommendations=[];
  if(actionPatterns[0] && actionPatterns[0].avg_impact > 0) recommendations.push(`When a new problem resembles ${actionPatterns[0].category} issues, prefer a measurable intervention and use the historical ${actionPatterns[0].avg_impact}% average impact as a reference—not a guarantee.`);
  if(targetAccuracy && targetAccuracy < 50) recommendations.push('Expected impact targets are often missed; use more conservative targets until the workspace has a larger measured-action sample.');
  if(recurring[0]) recommendations.push(`Prioritize Problem #${recurring[0].id} (${recurring[0].title}) and compare its planned action with previously measured outcomes.`);
  if(!recommendations.length) recommendations.push('Measure completed actions consistently; the learning system becomes more useful as outcome evidence accumulates.');

  return {
    sample_size: measured.length,
    metrics: { measured_actions:measured.length, positive_actions:positive.length, success_rate:pct(measured.length?positive.length/measured.length*100:0), avg_impact:avgImpact, avg_target:avgTarget, target_accuracy:targetAccuracy },
    action_patterns: actionPatterns.slice(0,8),
    team_patterns: teams.slice(0,8),
    recurring_problems: recurring,
    lessons,
    recommendations,
    source:'rules',
    generated_at:new Date().toISOString()
  };
}

async function generateLearningInsights(data) {
  const fallback=buildLearningInsights(data);
  if(!process.env.OPENAI_API_KEY) return fallback;
  try {
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const response=await client.responses.create({model:'gpt-5-mini',input:`You are the learning layer of FeedbackOS. Analyze only the supplied historical workspace evidence. Do not invent facts or imply causality beyond the measurements. Return ONLY valid JSON with lessons (array of 3-5 strings) and recommendations (array of 3-5 strings). Recommendations must be practical and explicitly treat small samples as directional, not statistically conclusive.\n\nDATA:\n${JSON.stringify({metrics:fallback.metrics,action_patterns:fallback.action_patterns,team_patterns:fallback.team_patterns,recurring_problems:fallback.recurring_problems,actions:data.actionOutcomes.slice(0,50)})}`});
    const ai=JSON.parse(response.output_text);
    return {...fallback, lessons:Array.isArray(ai.lessons)&&ai.lessons.length?ai.lessons.slice(0,5):fallback.lessons, recommendations:Array.isArray(ai.recommendations)&&ai.recommendations.length?ai.recommendations.slice(0,5):fallback.recommendations, source:'ai', generated_at:new Date().toISOString()};
  } catch(error) { console.error('Learning Engine AI fallback:',error.message); return fallback; }
}

module.exports={buildLearningInsights,generateLearningInsights,actionOutcomeLabel};
