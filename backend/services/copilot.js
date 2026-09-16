const OpenAI = require('openai');

function pct(n){ return `${Math.round(Number(n||0))}%`; }
function rankProblem(p){
  const pw={critical:100,high:70,medium:40,low:15};
  const hw={Worsening:30,Stable:12,'Insufficient data':5,Improving:-10};
  return (pw[p.priority]||15)+Math.min(40,Number(p.feedback_count||0)*2)+(hw[p.health]||5);
}

function deterministicAnswer(question, ctx){
  const q=String(question||'').toLowerCase();
  const top=[...ctx.problems].sort((a,b)=>rankProblem(b)-rankProblem(a));
  const worsening=ctx.problems.filter(p=>p.health==='Worsening' && p.status!=='resolved').sort((a,b)=>rankProblem(b)-rankProblem(a));
  const improving=ctx.problems.filter(p=>p.health==='Improving' || p.status==='monitoring').sort((a,b)=>rankProblem(b)-rankProblem(a));
  const lead=top[0];
  const formatProblem=p=>`Problem #${p.id} — ${p.title} (${p.priority} priority, ${p.health||'insufficient data'}, ${p.feedback_count} linked reports)`;

  if(q.includes('why') && (q.includes('complain')||q.includes('negative')||q.includes('worse'))){
    if(worsening.length) return {answer:`Negative feedback is being driven most strongly by ${worsening.slice(0,3).map(formatProblem).join('; ')}. ${ctx.weekly.negative_change>0?`Overall negative feedback is up ${ctx.weekly.negative_change}% versus the previous 7 days.`:'The overall weekly negative trend is not increasing.'}`,source:'rules'};
    return {answer:`There are no open problems currently marked Worsening. The highest-impact issue is ${lead?formatProblem(lead):'not yet established'}.`,source:'rules'};
  }
  if(q.includes('fix first')||q.includes('priorit')||q.includes('most important')||q.includes('first')){
    return {answer:lead?`Fix ${formatProblem(lead)} first. Its combined priority, recurrence, and health signal make it the strongest current candidate for immediate attention. Recommended action: ${lead.recommended_action||'review linked feedback and assign an owner.'}`:'There is not enough problem data yet. Analyze the workspace first.',source:'rules',problem_ids:lead?[lead.id]:[]};
  }
  if(q.includes('cost')||q.includes('impact')){
    const list=top.slice(0,5).map((p,i)=>`${i+1}. ${formatProblem(p)} — ${p.impact||'impact not documented'}`).join('\n');
    return {answer:list||'No recurring problems have been detected yet.',source:'rules',problem_ids:top.slice(0,5).map(p=>p.id)};
  }
  if(q.includes('action') && (q.includes('work')||q.includes('effective')||q.includes('worked'))){
    const completed=ctx.actions.completed;
    const measured=ctx.actions.measured;
    const effective=ctx.actions.effective;
    return {answer:`${completed} action${completed===1?'':'s'} are marked completed; ${measured} have a before/after measurement, and ${effective} show a positive reduction in negative feedback. Use the problem detail view to inspect each outcome.`,source:'rules'};
  }
  if(q.includes('improv')||q.includes('better')){
    return {answer:improving.length?`The clearest improving signals are ${improving.slice(0,3).map(formatProblem).join('; ')}.`:'No problems currently have a clear improving/monitoring signal.',source:'rules',problem_ids:improving.slice(0,3).map(p=>p.id)};
  }
  return {answer:`Current workspace health is ${ctx.health.score}/100. ${ctx.problems.length} recurring problems are tracked, with ${worsening.length} worsening. The strongest current issue is ${lead?formatProblem(lead):'not yet established'}. Try asking “What should we fix first?”, “Why are customers complaining more?”, or “Did our actions work?”`,source:'rules',problem_ids:lead?[lead.id]:[]};
}

async function answerCopilot(question, ctx){
  const fallback=deterministicAnswer(question,ctx);
  if(!process.env.OPENAI_API_KEY) return fallback;
  try{
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const response=await client.responses.create({
      model:'gpt-5-mini',
      input:`You are FeedbackOS Copilot, an analytical assistant for a product/operations team. Answer the user's question using ONLY the workspace data below. Do not invent facts. Be concise but useful. Name relevant problems as "Problem #ID — title". If the data is insufficient, say so and recommend the next data/action needed. Do not claim to have taken an action. Return ONLY the answer text, no markdown heading.

USER QUESTION:
${question}

WORKSPACE DATA:
${JSON.stringify(ctx)}`
    });
    const text=String(response.output_text||'').trim();
    return text?{answer:text,source:'ai',problem_ids:fallback.problem_ids||[]}:fallback;
  }catch(error){
    console.error('Copilot AI fallback:',error.message);
    return fallback;
  }
}

module.exports={answerCopilot};
