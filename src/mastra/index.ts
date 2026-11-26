import { BraintrustExporter } from '@mastra/braintrust';
import { currentSpan } from 'braintrust';
import { ArizeExporter } from '@mastra/arize';
import { LangfuseExporter } from '@mastra/langfuse';
import { LangSmithExporter } from '@mastra/langsmith';
import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { MastraPlatformExporter, MastraStorageExporter, Observability } from '@mastra/observability';
import { docsAgent } from './agents/docs-agent';
import { readDocs, searchDocs } from './tools/docs-tools';
import { toneScorer } from './scorers/tone-scorer';
import { answerSimilarityScorer } from './scorers/answer-similarity-scorer';
import { referenceAnswerQualityScorer } from './scorers/reference-answer-quality-scorer';

const hostedStorage = new LibSQLStore({
  id: 'hosted-storage',
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

// Share datasets with production; persist other development data locally.
export const storage = process.env.NODE_ENV === 'development'
  ? new MastraCompositeStore({
      id: 'development-storage',
      default: new LibSQLStore({
        id: 'local-storage',
        url: `file:${process.env.INIT_CWD ?? process.cwd()}/mastra-dev.db`,
      }),
      domains: { datasets: hostedStorage.stores?.datasets },
    })
  : hostedStorage;

export const mastra = new Mastra({
  agents: { docsAgent },
  tools: { searchDocs, readDocs },
  scorers: { toneScorer, answerSimilarityScorer, referenceAnswerQualityScorer },
  storage,
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra-docs-agent',
        exporters: [
          new MastraStorageExporter(),
          new MastraPlatformExporter(),
          new LangSmithExporter({ projectName: 'docs-agent' }),
          new ArizeExporter(),
          new LangfuseExporter(),
          new BraintrustExporter({
            currentSpan,
            projectName: process.env.BRAINTRUST_PROJECT_NAME || 'mastra-docs-agent',
          }),
        ],
      },
    },
  }),
});
