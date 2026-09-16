const VALID = {
  sentiment: new Set(['positive','neutral','negative']),
  severity: new Set(['low','medium','high','critical'])
};

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function textMatch(expected, actual) {
  const a = normalize(expected);
  const b = normalize(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  const compact = x => x.replace(/[^a-z0-9]+/g, '');
  return compact(a) === compact(b);
}

function scoreCase(expected, actual) {
  const e = expected || {};
  const a = actual || {};
  const sentiment = textMatch(e.sentiment, a.sentiment);
  const category = textMatch(e.category, a.category);
  const severity = textMatch(e.severity, a.severity);
  const summary = textMatch(e.summary, a.summary);
  const fields = [sentiment, category, severity, summary];
  return {
    sentiment_match: sentiment,
    category_match: category,
    severity_match: severity,
    summary_match: summary,
    score: fields.filter(Boolean).length / fields.length
  };
}

function aggregateResults(results) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return { total: 0, sentiment_accuracy: 0, category_accuracy: 0, severity_accuracy: 0, summary_match_rate: 0, overall_score: 0 };
  const avg = key => rows.reduce((n, r) => n + (r[key] ? 1 : 0), 0) / rows.length;
  const sentiment_accuracy = avg('sentiment_match');
  const category_accuracy = avg('category_match');
  const severity_accuracy = avg('severity_match');
  const summary_match_rate = avg('summary_match');
  return { total: rows.length, sentiment_accuracy, category_accuracy, severity_accuracy, summary_match_rate, overall_score: (sentiment_accuracy + category_accuracy + severity_accuracy + summary_match_rate) / 4 };
}

function regression(previousScore, currentScore, threshold = 0.05) {
  const previous = Number(previousScore || 0);
  const current = Number(currentScore || 0);
  return previous > 0 && current < previous - Number(threshold || 0.05);
}

function validateCase(expected) {
  if (expected.sentiment && !VALID.sentiment.has(normalize(expected.sentiment))) throw new Error('Invalid expected sentiment');
  if (expected.severity && !VALID.severity.has(normalize(expected.severity))) throw new Error('Invalid expected severity');
  if (!expected.input_text || !String(expected.input_text).trim()) throw new Error('Evaluation case input is required');
  return true;
}

module.exports = { normalize, textMatch, scoreCase, aggregateResults, regression, validateCase };
