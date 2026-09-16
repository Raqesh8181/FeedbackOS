const pool = require('../db');

function safeLimit(value, fallback = 20) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.floor(n))) : fallback;
}

async function overview() {
  const [[summary]] = await pool.query(`
    SELECT
      COUNT(*) AS total_feedback,
      COUNT(DISTINCT NULLIF(TRIM(customer_name), '')) AS named_customers,
      COUNT(DISTINCT NULLIF(TRIM(source), '')) AS sources,
      COUNT(DISTINCT NULLIF(TRIM(category), '')) AS categories,
      COALESCE(SUM(sentiment='negative'),0) AS negative_feedback,
      COALESCE(SUM(sentiment='positive'),0) AS positive_feedback
    FROM feedback
  `);

  const [sources] = await pool.query(`
    SELECT COALESCE(NULLIF(TRIM(source),''),'Unknown') AS segment,
           COUNT(*) AS feedback_count,
           COALESCE(SUM(sentiment='negative'),0) AS negative_count,
           COALESCE(SUM(sentiment='positive'),0) AS positive_count,
           COALESCE(SUM(severity IN ('high','critical')),0) AS high_severity_count,
           COUNT(DISTINCT NULLIF(TRIM(customer_name),'')) AS customers
    FROM feedback
    GROUP BY COALESCE(NULLIF(TRIM(source),''),'Unknown')
    ORDER BY negative_count DESC, feedback_count DESC
    LIMIT 20
  `);

  const [categories] = await pool.query(`
    SELECT COALESCE(NULLIF(TRIM(category),''),'Uncategorized') AS segment,
           COUNT(*) AS feedback_count,
           COALESCE(SUM(sentiment='negative'),0) AS negative_count,
           COALESCE(SUM(sentiment='positive'),0) AS positive_count,
           COALESCE(SUM(severity IN ('high','critical')),0) AS high_severity_count,
           COUNT(DISTINCT NULLIF(TRIM(customer_name),'')) AS customers
    FROM feedback
    GROUP BY COALESCE(NULLIF(TRIM(category),''),'Uncategorized')
    ORDER BY negative_count DESC, feedback_count DESC
    LIMIT 20
  `);

  const [customers] = await pool.query(`
    SELECT TRIM(customer_name) AS customer,
           COUNT(*) AS feedback_count,
           COALESCE(SUM(sentiment='negative'),0) AS negative_count,
           COALESCE(SUM(sentiment='positive'),0) AS positive_count,
           COALESCE(SUM(severity IN ('high','critical')),0) AS high_severity_count,
           COUNT(DISTINCT problem_id) AS problems
    FROM feedback
    WHERE customer_name IS NOT NULL AND TRIM(customer_name) <> ''
    GROUP BY TRIM(customer_name)
    ORDER BY negative_count DESC, feedback_count DESC
    LIMIT 20
  `);

  const segmentHealth = rows => rows.map(x => ({
    ...x,
    negative_rate: Number(x.feedback_count) ? Number((Number(x.negative_count) / Number(x.feedback_count) * 100).toFixed(1)) : 0,
    health: Number(x.negative_count) > 0 && Number(x.negative_count) / Math.max(1, Number(x.feedback_count)) >= 0.5 ? 'At risk' :
      Number(x.high_severity_count) > 0 ? 'Watch' : 'Healthy'
  }));

  return {
    summary: {
      total_feedback: Number(summary.total_feedback || 0),
      named_customers: Number(summary.named_customers || 0),
      sources: Number(summary.sources || 0),
      categories: Number(summary.categories || 0),
      negative_feedback: Number(summary.negative_feedback || 0),
      positive_feedback: Number(summary.positive_feedback || 0)
    },
    sources: segmentHealth(sources),
    categories: segmentHealth(categories),
    customers: segmentHealth(customers)
  };
}

async function customer(customerName) {
  const name = String(customerName || '').trim();
  if (!name) return null;
  const [[summary]] = await pool.query(`
    SELECT TRIM(customer_name) AS customer,
           COUNT(*) AS feedback_count,
           COALESCE(SUM(sentiment='negative'),0) AS negative_count,
           COALESCE(SUM(sentiment='positive'),0) AS positive_count,
           COALESCE(SUM(severity IN ('high','critical')),0) AS high_severity_count,
           COUNT(DISTINCT problem_id) AS problems
    FROM feedback
    WHERE TRIM(customer_name)=?
    GROUP BY TRIM(customer_name)
  `,[name]);
  if (!summary) return null;
  const [feedback] = await pool.query(`
    SELECT id, message, sentiment, category, severity, problem_id, created_at
    FROM feedback WHERE TRIM(customer_name)=?
    ORDER BY created_at DESC LIMIT 50
  `,[name]);
  const [problems] = await pool.query(`
    SELECT p.id, p.title, p.priority, p.status, p.feedback_count, p.health
    FROM problems p
    INNER JOIN (SELECT DISTINCT problem_id FROM feedback WHERE TRIM(customer_name)=? AND problem_id IS NOT NULL) f ON f.problem_id=p.id
    ORDER BY FIELD(p.priority,'critical','high','medium','low'), p.feedback_count DESC
    LIMIT 20
  `,[name]);
  return {
    summary: {...summary,
      feedback_count:Number(summary.feedback_count), negative_count:Number(summary.negative_count),
      positive_count:Number(summary.positive_count), high_severity_count:Number(summary.high_severity_count),
      problems:Number(summary.problems), negative_rate:Number(summary.feedback_count)?Number((summary.negative_count/summary.feedback_count*100).toFixed(1)):0
    }, feedback, problems
  };
}

async function segment(type, value) {
  const allowed = {source:'source', category:'category'};
  const column = allowed[type];
  if (!column) throw new Error('Invalid segment type');
  const v = String(value || '').trim();
  if (!v) return null;
  const [feedback] = await pool.query(`
    SELECT id, customer_name, message, sentiment, category, severity, problem_id, created_at
    FROM feedback
    WHERE COALESCE(NULLIF(TRIM(${column}),''),'${type === 'source' ? 'Unknown' : 'Uncategorized'}')=?
    ORDER BY created_at DESC LIMIT 100
  `,[v]);
  const negative = feedback.filter(x=>x.sentiment==='negative').length;
  const high = feedback.filter(x=>['high','critical'].includes(x.severity)).length;
  return {
    type, value:v, feedback_count:feedback.length, negative_count:negative,
    negative_rate:feedback.length?Number((negative/feedback.length*100).toFixed(1)):0,
    high_severity_count:high, feedback
  };
}

module.exports = { overview, customer, segment };
