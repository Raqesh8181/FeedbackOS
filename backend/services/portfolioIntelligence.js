function n(v,d=0){const x=Number(v);return Number.isFinite(x)?x:d}
function score(i){
  const impact=Math.max(0,Math.min(100,n(i.target_impact,20)));
  const confidence=Math.max(0,Math.min(100,n(i.confidence,60)));
  const effort=Math.max(1,n(i.effort_points,5));
  const urgency={critical:100,high:75,medium:50,low:25}[String(i.priority||'medium').toLowerCase()]||50;
  const risk=Math.max(0,Math.min(100,n(i.execution_risk,40)));
  const value=(impact*.45+confidence*.25+urgency*.20+(100-risk)*.10);
  const efficiency=value/effort;
  return {value:Number(value.toFixed(2)),efficiency:Number(efficiency.toFixed(2))};
}
function recommendation(i){
  const s=score(i); const effort=n(i.effort_points,5); const cap=n(i.capacity_available,0);
  if(String(i.status)==='completed'||String(i.status)==='cancelled') return {decision:'keep',reason:'Already completed or cancelled.'};
  if(s.efficiency>=15 && s.value>=70) return {decision:'fund_now',reason:'High expected value with strong value-per-effort.'};
  if(s.value>=60 && effort<=cap && cap>0) return {decision:'fund_now',reason:'Good expected impact and fits available capacity.'};
  if(s.value>=50) return {decision:'sequence',reason:'Promising initiative, but it should be sequenced against higher-value work.'};
  return {decision:'defer',reason:'Expected value is currently too low or execution risk is too high.'};
}
function portfolioSummary(items){
  const scored=items.map(i=>({...i,...score(i),...recommendation(i)}));
  return {
    total:scored.length,
    fund_now:scored.filter(x=>x.decision==='fund_now').length,
    sequence:scored.filter(x=>x.decision==='sequence').length,
    defer:scored.filter(x=>x.decision==='defer').length,
    allocated_effort:scored.filter(x=>x.decision==='fund_now').reduce((a,x)=>a+n(x.effort_points),0),
    expected_impact:scored.filter(x=>x.decision==='fund_now').reduce((a,x)=>a+n(x.target_impact),0),
    items:scored.sort((a,b)=>b.efficiency-a.efficiency)
  };
}
module.exports={score,recommendation,portfolioSummary};
