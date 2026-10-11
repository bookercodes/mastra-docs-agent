import { createAnswerSimilarityScorer } from '@mastra/evals/scorers/prebuilt';

export const answerSimilarityScorer = createAnswerSimilarityScorer({
  model: 'openrouter/openai/gpt-6-astra',
  options: { requireGroundTruth: true },
});
