const crypto=require('crypto');
function normalize(value){return String(value??'').trim().toLowerCase().replace(/\s+/g,' ')}
function key(field,from,to){return `${normalize(field)}|${normalize(from)}|${normalize(to)}`}
function patternHash(field,from,to){return crypto.createHash('sha256').update(key(field,from,to)).digest('hex')}
function buildCorrectionSignals(overrides){const rows=Array.isArray(overrides)?overrides:[];const map=new Map();for(const r of rows){const k=key(r.field_name,r.old_value,r.new_value);const x=map.get(k)||{field_name:r.field_name,from_value:r.old_value||'',to_value:r.new_value||'',count:0,reasons:[]};x.count++;if(r.reason)x.reasons.push(r.reason);map.set(k,x)}return [...map.values()].sort((a,b)=>b.count-a.count)}
function buildLearningExplanation(signal){return `Human-reviewed feedback changed ${signal.field_name} from “${signal.from_value||'empty'}” to “${signal.to_value||'empty'}” ${signal.count} time(s). This is a learning signal, not an automatic model change.`}
function confidenceFromCount(count){return Math.min(0.99,0.5+Math.log10(Math.max(1,count))*0.2)}
module.exports={normalize,buildCorrectionSignals,buildLearningExplanation,confidenceFromCount,patternHash};
