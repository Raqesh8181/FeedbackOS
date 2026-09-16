function calculatePriority({
  frequency,
  severity,
  recencyDays,
}) {
  const severityScore = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };

  const severityValue =
    severityScore[severity?.toLowerCase()] || 1;

  // More feedback = higher urgency
  const frequencyScore = Math.min(frequency, 10);

  // Recent problems are more urgent
  let recencyScore = 1;

  if (recencyDays <= 1) {
    recencyScore = 4;
  } else if (recencyDays <= 3) {
    recencyScore = 3;
  } else if (recencyDays <= 7) {
    recencyScore = 2;
  }

  const score =
    frequencyScore +
    severityValue * 2 +
    recencyScore;

  let priority = "low";

  if (score >= 15) {
    priority = "critical";
  } else if (score >= 11) {
    priority = "high";
  } else if (score >= 7) {
    priority = "medium";
  }

  return {
    score,
    priority,
  };
}

module.exports = {
  calculatePriority,
};