const OpenAI = require('openai');

const priorityWeight = { critical: 100, high: 70, medium: 40, low: 15 };
const healthWeight = { Worsening: 30, Stable: 12, 'Insufficient data': 5, Improving: -15 };

function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }

function scoreProblem(p){
  const volume=Math.min(35,Number(p.feedback_count||0)*3);
  const age=Math.min(10,Math.max(0,14-Number(p.days_since_detection||14)));
  const unresolved=p.status==='resolved'?-25:0;
  return Math.round(clamp((priorityWeight[p.priority]||15)+volume+(healthWeight[p.health]||5)+age+unresolved,0,150));
}

function buildPlan(data){
  const ranked=[...data.problems].map(p=>({...p,decision_score:scoreProblem(p)})).sort((a,b)=>b.decision_score-a.decision_score);
  const top=ranked.slice(0,5);
  const priorities=top.slice(0,3).map((p,i)=>({
    rank:i+1, problem_id:p.id,title:p.title,priority:p.priority,health:p.health||'Insufficient data',
    feedback_count:Number(p.feedback_count||0),score:p.decision_score,owner:p.owner||p.recommended_team||'Unassigned',
    why:p.health==='Worsening'?`Worsening signal with ${p.feedback_count} linked reports makes this an immediate risk.`:`${p.priority||'medium'} priority with ${p.feedback_count} linked reports makes this one of the strongest current opportunities.`,
    action:p.recommended_action||'Review linked feedback, identify the root cause, and assign an owner.',
    success_metric:`Reduce negative feedback for “${p.title}” over the next 7–14 days.`
  }));
  const risks=[];
  const worsening=ranked.filter(p=>p.health==='Worsening'&&p.status!=='resolved');
  if(worsening.length) risks.push(`${worsening.length} open problem${worsening.length===1?' is':'s are'} worsening.`);
  const unowned=ranked.filter(p=>p.status!=='resolved'&&!p.owner);
  if(unowned.length) risks.push(`${unowned.length} active problem${unowned.length===1?' has':'s have'} no explicit owner.`);
  if(data.weekly.negative_change>0) risks.push(`Negative feedback is up ${data.weekly.negative_change}% week over week.`);
  if(!risks.length) risks.push('No major operational risk signal is currently above the decision threshold.');
  const sevenDay=priorities.map((p,i)=>({day:i<2?'Days 1–2':'Days 3–7',problem_id:p.problem_id,focus:i<2?'Investigate and confirm root cause':'Execute fix, monitor feedback, and validate the outcome'}));
  return {headline: data.healthScore.score<55?'Customer feedback requires an active recovery plan.':data.weekly.negative_change>0?'Customer feedback needs focused intervention this week.':'Customer feedback is stable enough for targeted improvement work.',priorities,risks,seven_day_plan:sevenDay,decision_rules:['Address worsening critical/high problems first.','Prefer actions with a measurable customer-feedback outcome.','Keep resolved problems in monitoring until improvement is sustained.'],source:'rules',generated_at:new Date().toISOString()};
}

async function generateDecisionPlan(data){
  const fallback=buildPlan(data);
  if(!process.env.OPENAI_API_KEY) return fallback;
  try{
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const response=await client.responses.create({model:'gpt-5-mini',input:`You are FeedbackOS Decision Engine. Convert the workspace evidence into a practical 7-day operating plan for a product/operations leader. Use ONLY supplied data. Do not invent facts. Preserve problem IDs. Return ONLY valid JSON with headline (string), priorities (array of objects with rank,problem_id,title,why,action,success_metric), risks (array of strings), seven_day_plan (array of objects with day,problem_id,focus). Maximum 3 priorities. Make actions concrete and measurable.\n\nWORKSPACE:\n${JSON.stringify({healthScore:data.healthScore,weekly:data.weekly,problems:data.problems.slice(0,15),actions:data.actions})}`});
    const ai=JSON.parse(response.output_text);
    return {...fallback,headline:ai.headline||fallback.headline,priorities:Array.isArray(ai.priorities)&&ai.priorities.length?ai.priorities.slice(0,3):fallback.priorities,risks:Array.isArray(ai.risks)&&ai.risks.length?ai.risks.slice(0,5):fallback.risks,seven_day_plan:Array.isArray(ai.seven_day_plan)&&ai.seven_day_plan.length?ai.seven_day_plan.slice(0,6):fallback.seven_day_plan,source:'ai',generated_at:new Date().toISOString()};
  }catch(error){ console.error('Decision Engine AI fallback:',error.message); return fallback; }
}

module.exports={generateDecisionPlan,buildPlan};
