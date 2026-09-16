const { cosineSimilarity } = require("./similarity");

const SIMILARITY_THRESHOLD = 0.75;

function isSimilarFeedback(similarity) {
  return similarity >= SIMILARITY_THRESHOLD;
}

async function findSimilarFeedback(feedbackId, pool) {
  const [rows] = await pool.query(
    `SELECT id, message, embedding
     FROM feedback
     WHERE embedding IS NOT NULL`
  );

  const target = rows.find(
    (row) => row.id === Number(feedbackId)
  );

  if (!target) {
    throw new Error("Feedback or embedding not found");
  }

  const targetEmbedding =
    typeof target.embedding === "string"
      ? JSON.parse(target.embedding)
      : target.embedding;

  return rows
    .filter((row) => row.id !== Number(feedbackId))
    .map((row) => {
      const embedding =
        typeof row.embedding === "string"
          ? JSON.parse(row.embedding)
          : row.embedding;

      const similarity = cosineSimilarity(
        targetEmbedding,
        embedding
      );

      return {
        id: row.id,
        message: row.message,
        similarity,
      };
    })
    .filter((row) => isSimilarFeedback(row.similarity))
    .sort((a, b) => b.similarity - a.similarity);
}

module.exports = {
  SIMILARITY_THRESHOLD,
  isSimilarFeedback,
  findSimilarFeedback,
};