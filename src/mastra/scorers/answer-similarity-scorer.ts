import { createAnswerSimilarityScorer } from '@mastra/evals/scorers/prebuilt';

export const answerSimilarityScorer = createAnswerSimilarityScorer({
  model: 'mastra/openai/gpt-6-astra',
  options: { requireGroundTruth: true },
});
