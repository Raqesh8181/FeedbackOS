async function createProblemFromFeedback(
  feedbackId,
  similarFeedback,
  pool
) {
  const feedbackIds = [
    Number(feedbackId),
    ...similarFeedback.map((item) => Number(item.id)),
  ];

  const [feedbackRows] = await pool.query(
    `SELECT id, message, category, severity
     FROM feedback
     WHERE id IN (?)`,
    [feedbackIds]
  );

  if (feedbackRows.length === 0) {
    throw new Error("No feedback found");
  }

  const firstFeedback = feedbackRows[0];

  const title = firstFeedback.message;

  const description = feedbackRows
    .map((feedback) => feedback.message)
    .join(" | ");

  const category = firstFeedback.category || "general";
  const severity = firstFeedback.severity || "medium";

  const priority =
    severity === "critical"
      ? "critical"
      : severity === "high"
      ? "high"
      : severity === "medium"
      ? "medium"
      : "low";

  const [problemResult] = await pool.query(
    `INSERT INTO problems
     (title, description, category, severity, priority, status, feedback_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      title,
      description,
      category,
      severity,
      priority,
      "detected",
      feedbackRows.length,
    ]
  );

  const problemId = problemResult.insertId;

  for (const feedback of feedbackRows) {
    await pool.query(
      `INSERT INTO problem_feedback
       (problem_id, feedback_id)
       VALUES (?, ?)`,
      [problemId, feedback.id]
    );
  }

  return {
    problemId,
    feedbackCount: feedbackRows.length,
  };
}

module.exports = {
  createProblemFromFeedback,
};