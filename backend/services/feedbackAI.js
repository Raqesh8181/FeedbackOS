async function analyzeFeedbackDetailed(message) {
  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    input: `
You are analyzing customer feedback for a company.

Analyze this feedback:

"${message}"

Return ONLY valid JSON with these fields:

{
  "sentiment": "positive | neutral | negative",
  "category": "short category",
  "severity": "low | medium | high | critical",
  "summary": "one short sentence describing the issue"
}

Rules:
- sentiment describes the customer's overall feeling.
- category should describe the main business area.
- severity should represent how serious the issue is for the customer/business.
- summary should be concise.
`,
  });

  return { analysis: JSON.parse(response.output_text), usage: response.usage || {}, model: process.env.OPENAI_MODEL || "gpt-5-mini" };
}

async function analyzeFeedback(message) {
  const result = await analyzeFeedbackDetailed(message);
  return result.analysis;
}

module.exports = { analyzeFeedback, analyzeFeedbackDetailed };