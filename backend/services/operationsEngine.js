const OpenAI = require('openai');

function n(v){ return Number(v||0); }
function daysSince(d){ if(!d) return 999; return Math.max(0, Math.floor((Date.now()-new Date(d).getTime())/86400000)); }
function scoreProblem(p){
  const priority={critical:100,high:75,medium:45,low:20}[String(p.priority||'medium').toLowerCase()]||45;
  const health={Worsening:30,Stable:12,Improving:-10,'Insufficient data':5}[p.health]||5;
  const volume=Math.min(30,n(p.feedback_count)*3);
  const stale=Math.min(15,daysSince(p.last_detected_at)*1.5);
  const unowned=p.owner?0:12;
  const unresolved=p.status==='resolved'?-50:15;
  return Math.round(priority+health+volume+stale+unowned+unresolved);
}
function buildOperations(data){
  const problems=(data.problems||[]).filter(p=>p.status!=='resolved').map(p=>({...p,ops_score:scoreProblem(p)})).sort((a,b)=>b.ops_score-a.ops_score);
  const actions=data.actions||[];
  const openActions=actions.filter(a=>a.status!=='completed');
  const overdue=openActions.filter(a=>daysSince(a.created_at)>=7);
  const risks=[];
  const queue=[];
  for(const p of problems.slice(0,8)){
    if(p.health==='Worsening') risks.push(`Problem #${p.id} is worsening: ${p.title}.`);
    if(!p.owner) risks.push(`Problem #${p.id} is unowned and has ${n(p.feedback_count)} linked reports.`);
    const action=actions.find(a=>Number(a.problem_id)===Number(p.id)&&a.status!=='completed');
    if(!action) queue.push({kind:'action_needed',problem_id:p.id,title:p.title,priority:p.priority,reason:'No active action is recorded.',recommended_action:p.recommended_action||'Investigate the root cause, assign an owner, and define a measurable outcome.'});
    else if(daysSince(action.created_at)>=7) queue.push({kind:'stale_action',problem_id:p.id,title:p.title,priority:p.priority,reason:`Active action has been open for ${daysSince(action.created_at)} days.`,recommended_action:'Review progress, unblock the owner, or revise the action and expected outcome.'});
  }
  for(const p of problems.filter(x=>x.health==='Worsening').slice(0,3)) queue.push({kind:'escalation',problem_id:p.id,title:p.title,priority:p.priority,reason:'Customer signal is worsening.',recommended_action:p.recommended_action||'Escalate investigation and measure the next intervention.'});
  const dedup=[]; const seen=new Set(); for(const x of queue){const k=`${x.kind}-${x.problem_id}`; if(!seen.has(k)){seen.add(k);dedup.push(x);}}
  const top=problems.slice(0,5).map((p,i)=>({rank:i+1,problem_id:p.id,title:p.title,priority:p.priority,health:p.health,owner:p.owner||'Unassigned',feedback_count:n(p.feedback_count),ops_score:p.ops_score,why:p.health==='Worsening'?'Worsening customer signal increases urgency.':`${p.priority} priority with ${n(p.feedback_count)} linked reports.`,next_action:p.recommended_action||'Investigate, assign an owner, and define a measurable outcome.'}));
  const completed=actions.filter(a=>a.status==='completed').length;
  const measured=actions.filter(a=>['met','partial','missed'].includes(a.outcome_status)).length;
  const brief={
    headline: problems.length ? `${problems.length} active customer problems require attention; focus on the highest-impact signals first.` : 'No active customer problems are currently requiring intervention.',
    top_focus: top[0] ? `Start with Problem #${top[0].problem_id}: ${top[0].title}.` : 'Import and analyze feedback to create an operating queue.',
    queue_count: dedup.length,
    risk_count: risks.length,
    open_actions: openActions.length,
    overdue_actions: overdue.length,
    completed_actions: completed,
    measured_actions: measured
  };
  return {brief,priorities:top,queue:dedup.slice(0,10),risks:risks.slice(0,8),guardrails:[
    'FeedbackOS recommends actions; it does not execute production changes automatically.',
    'No action is created, assigned, or completed without explicit user approval.',
    'Outcome and learning signals are treated as directional evidence, especially with small samples.'
  ],source:'rules',generated_at:new Date().toISOString()};
}

async function generateOperationsBrief(data){
  const fallback=buildOperations(data);
  if(!process.env.OPENAI_API_KEY) return fallback;
  try{
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const response=await client.responses.create({model:'gpt-5-mini',input:`You are the FeedbackOS operations layer. Improve the supplied operating brief without inventing facts. Return ONLY JSON with headline, top_focus, and an array called focus_notes (2-4 short notes). Do not claim autonomous execution or causality.\nDATA:\n${JSON.stringify(fallback)}`});
    const ai=JSON.parse(response.output_text||'{}');
    return {...fallback,brief:{...fallback.brief,headline:ai.headline||fallback.brief.headline,top_focus:ai.top_focus||fallback.brief.top_focus,focus_notes:Array.isArray(ai.focus_notes)?ai.focus_notes.slice(0,4):[]},source:'ai',generated_at:new Date().toISOString()};
  }catch(e){console.error('Operations AI fallback:',e.message);return fallback;}
}
module.exports={buildOperations,generateOperationsBrief};
