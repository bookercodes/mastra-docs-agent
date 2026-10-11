import { Eval } from 'braintrust';
import { mastra } from '../mastra';

Eval(process.env.BRAINTRUST_PROJECT_NAME || 'mastra-docs-agent', {
  // Select the dataset and scorers in Braintrust.
  data: [],
  task: async (input: string, { signal }) => {
    if (typeof input !== 'string' || !input.trim()) {
      throw new Error('Dataset input must be a non-empty question string.');
    }

    const response = await mastra.getAgent('docsAgent').generate(input, {
      abortSignal: signal,
      // Keep experiment scoring under Braintrust's control.
      scorers: {},
    });

    if (!response.text.trim()) {
      throw new Error('The agent did not return an answer.');
    }
    return response.text;
  },
  scores: [],
  maxConcurrency: 2,
  timeout: 300_000,
});
