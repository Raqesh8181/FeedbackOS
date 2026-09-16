const OpenAI = require('openai');

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function rankProblem(p) {
  const priorityWeight = { critical: 100, high: 70, medium: 40, low: 15 };
  const healthWeight = { Worsening: 30, Stable: 12, 'Insufficient data': 5, Improving: -10 };
  return (priorityWeight[p.priority] || 15) + Math.min(30, Number(p.feedback_count || 0) * 2) + (healthWeight[p.health] || 5);
}

function buildDeterministicSummary(data) {
  const { healthScore, weekly, problems, improving, worsening, actions, timeline } = data;
  const top = [...problems].sort((a,b)=>rankProblem(b)-rankProblem(a)).slice(0,3);
  const lead = top[0];
  const change = Number(weekly.negative_change || 0);
  let headline = healthScore.score >= 75 ? 'Customer feedback health is broadly healthy.' : healthScore.score >= 55 ? 'Customer feedback health is mixed and needs focused attention.' : 'Customer feedback health needs immediate attention.';
  if (change > 0) headline += ` Negative feedback is up ${change}% versus the previous 7 days.`;
  else if (change < 0) headline += ` Negative feedback is down ${Math.abs(change)}% versus the previous 7 days.`;
  else headline += ' Negative feedback is broadly flat week over week.';

  const bullets = [];
  if (lead) bullets.push(`${lead.title} is the highest-impact open problem (${lead.feedback_count} linked reports, ${lead.priority} priority, ${lead.health || 'insufficient data'}).`);
  if (improving.length) bullets.push(`${improving.length} problem${improving.length === 1 ? '' : 's'} show an improving or monitoring signal.`);
  if (worsening.length) bullets.push(`${worsening.length} problem${worsening.length === 1 ? '' : 's'} are worsening and should be reviewed before they become larger recurring issues.`);
  if (actions.completed) bullets.push(`${actions.completed} action${actions.completed === 1 ? '' : 's'} completed recently; use the before/after measurements to confirm impact.`);
  if (!bullets.length) bullets.push('Analyze more feedback to create enough evidence for stronger executive signals.');

  const next = top[0]?.recommended_action || 'Analyze the workspace and assign owners to the highest-priority recurring problems.';
  return {
    headline,
    bullets,
    next_action: next,
    top_problems: top.map(p => ({ id:p.id, title:p.title, priority:p.priority, health:p.health, feedback_count:Number(p.feedback_count||0), score:Math.round(rankProblem(p)) })),
    improvements: improving.slice(0,5).map(p => ({ id:p.id, title:p.title, feedback_count:Number(p.feedback_count||0) })),
    regressions: worsening.slice(0,5).map(p => ({ id:p.id, title:p.title, feedback_count:Number(p.feedback_count||0), priority:p.priority })),
    timeline: timeline.slice(-10)
  };
}

async function generateExecutiveSummary(data) {
  const fallback = buildDeterministicSummary(data);
  if (!process.env.OPENAI_API_KEY) return { ...fallback, source: 'rules' };

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: 'gpt-5-mini',
      input: `You are the executive intelligence layer of a customer feedback platform. Create a concise, decision-oriented summary from the structured workspace data below. Do not invent facts. Return ONLY valid JSON with: headline (string), bullets (array of 3-5 strings), next_action (string). Keep it practical for a product/operations leader.\n\nDATA:\n${JSON.stringify({
        healthScore: data.healthScore,
        weekly: data.weekly,
        topProblems: data.problems.slice(0,10),
        improving: data.improving.slice(0,8),
        worsening: data.worsening.slice(0,8),
        actions: data.actions,
        timeline: data.timeline.slice(-10)
      })}`
    });
    const ai = JSON.parse(response.output_text);
    return { ...fallback, headline: ai.headline || fallback.headline, bullets: Array.isArray(ai.bullets) && ai.bullets.length ? ai.bullets.slice(0,5) : fallback.bullets, next_action: ai.next_action || fallback.next_action, source: 'ai' };
  } catch (error) {
    console.error('Executive summary AI fallback:', error.message);
    return { ...fallback, source: 'rules' };
  }
}

module.exports = { generateExecutiveSummary, buildDeterministicSummary };
