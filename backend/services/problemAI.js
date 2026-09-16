const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function analyzeProblem(feedbackMessages) {
  const feedbackText = feedbackMessages
    .map((message, index) => `${index + 1}. ${message}`)
    .join("\n");

  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: `
You are an AI customer feedback analyst.

These customer feedback messages appear to describe the same underlying problem:

${feedbackText}

Identify the underlying business problem.

Return ONLY valid JSON:

{
  "title": "short problem title",
  "description": "one or two sentence explanation",
  "impact": "customer/business impact",
  "category": "short category",
  "recommended_team": "team responsible for investigating this problem",
  "severity": "low | medium | high | critical",
  "priority": "low | medium | high | critical"
}

Rules:
- Focus on the underlying problem, not individual wording.
- The title should describe the recurring problem clearly.
- recommended_team should be the most appropriate internal team.
- severity describes how serious the customer/business impact is.
- priority describes how urgently the company should investigate it.
`,
  });

  return JSON.parse(response.output_text);
}

module.exports = {
  analyzeProblem,
};