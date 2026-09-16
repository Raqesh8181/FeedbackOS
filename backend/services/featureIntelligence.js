const FEATURE_RULES = [
  {name:'Checkout & Payment', area:'Payments', words:['checkout','payment','pay','card','transaction','upi','failed payment','authorization']},
  {name:'Refunds', area:'Payments', words:['refund','refunded','money back','reimbursement']},
  {name:'Delivery & ETA', area:'Fulfillment', words:['delivery','deliver','eta','late','delay','shipping','courier','arrival']},
  {name:'Order Tracking', area:'Fulfillment', words:['tracking','track order','order status','where is my order']},
  {name:'Order Details', area:'Orders', words:['order page','order screen','order details','order history','orders']},
  {name:'Search', area:'Discovery', words:['search','find a product','search results','filter']},
  {name:'Login & Signup', area:'Account', words:['login','log in','sign in','signup','sign up','password','otp']},
  {name:'Notifications', area:'Engagement', words:['notification','notifications','push alert','email alert']},
  {name:'Mobile App', area:'Platform', words:['app crash','crashes','crash','ios','android','mobile app','app freezes','freezes']},
  {name:'Support', area:'Support', words:['support','agent','customer service','helpdesk','ticket']},
  {name:'Subscription', area:'Billing', words:['subscription','plan','renewal','cancel subscription','upgrade plan']},
  {name:'Performance', area:'Platform', words:['slow','loading','latency','timeout','hang','performance']}
];

function classify(text='') {
  const s=String(text).toLowerCase();
  const scored=FEATURE_RULES.map(r=>({r,score:r.words.reduce((n,w)=>n+(s.includes(w)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  if(!scored.length) return {feature_name:'Other',product_area:'Other',confidence:0};
  const top=scored[0];
  const confidence=Math.min(0.99,0.55 + top.score*0.12 + (scored[1]&&scored[1].score<top.score?0.08:0));
  return {feature_name:top.r.name,product_area:top.r.area,confidence:Number(confidence.toFixed(2))};
}

async function classifyFeedback(pool) {
  const [rows]=await pool.query("SELECT id,message FROM feedback WHERE feature_name IS NULL OR feature_name='' OR feature_name='Other'");
  let updated=0;
  for(const f of rows){const x=classify(f.message);await pool.query('UPDATE feedback SET feature_name=?,product_area=?,feature_confidence=? WHERE id=?',[x.feature_name,x.product_area,x.confidence,f.id]);updated++;}
  return {updated,total:rows.length};
}

async function overview(pool){
  const [rows]=await pool.query(`SELECT COALESCE(feature_name,'Other') feature_name,COALESCE(product_area,'Other') product_area,
    COUNT(*) feedback_count,SUM(sentiment='negative') negative_count,SUM(sentiment='positive') positive_count,
    COUNT(DISTINCT customer_name) customers,MAX(created_at) last_seen,
    AVG(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END)*100 negative_rate
    FROM feedback GROUP BY COALESCE(feature_name,'Other'),COALESCE(product_area,'Other') ORDER BY negative_rate DESC,feedback_count DESC`);
  const [recent]=await pool.query(`SELECT COALESCE(feature_name,'Other') feature_name,
    SUM(created_at>=DATE_SUB(NOW(),INTERVAL 7 DAY) AND sentiment='negative') recent_negative,
    SUM(created_at>=DATE_SUB(NOW(),INTERVAL 14 DAY) AND created_at<DATE_SUB(NOW(),INTERVAL 7 DAY) AND sentiment='negative') previous_negative
    FROM feedback GROUP BY COALESCE(feature_name,'Other')`);
  const trend={}; for(const r of recent){const a=Number(r.recent_negative||0),b=Number(r.previous_negative||0);trend[r.feature_name]=b?Number((((a-b)/b)*100).toFixed(1)):a>0?100:0;}
  const items=rows.map(r=>({...r,risk:Number(r.negative_rate||0)>=60?'High':Number(r.negative_rate||0)>=30?'Watch':'Healthy',risk_change_percent:trend[r.feature_name]||0}));
  const [[summary]]=await pool.query(`SELECT COUNT(DISTINCT COALESCE(feature_name,'Other')) features,COUNT(*) feedback,
    SUM(sentiment='negative') negative,COUNT(DISTINCT CASE WHEN sentiment='negative' THEN COALESCE(feature_name,'Other') END) affected_features FROM feedback`);
  return {summary,items};
}

async function detail(pool,name){
  const [rows]=await pool.query(`SELECT id,message,sentiment,severity,category,customer_name,problem_id,created_at FROM feedback WHERE COALESCE(feature_name,'Other')=? ORDER BY created_at DESC LIMIT 100`,[name]);
  const [[stats]]=await pool.query(`SELECT COUNT(*) feedback_count,SUM(sentiment='negative') negative_count,COUNT(DISTINCT customer_name) customers,AVG(feature_confidence)*100 confidence FROM feedback WHERE COALESCE(feature_name,'Other')=?`,[name]);
  const [problems]=await pool.query(`SELECT p.id,p.title,p.priority,p.status,p.health,p.feedback_count FROM problems p JOIN (SELECT DISTINCT problem_id FROM feedback WHERE COALESCE(feature_name,'Other')=? AND problem_id IS NOT NULL) f ON f.problem_id=p.id ORDER BY p.feedback_count DESC LIMIT 30`,[name]);
  return {feature:name,summary:stats,feedback:rows,problems};
}

module.exports={classify,classifyFeedback,overview,detail};
