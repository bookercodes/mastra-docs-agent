import { BraintrustExporter } from '@mastra/braintrust';
import { ArizeExporter } from '@mastra/arize';
import { LangfuseExporter } from '@mastra/langfuse';
import { LangSmithExporter } from '@mastra/langsmith';
import { Mastra } from '@mastra/core/mastra';
import { PostgresStoreVNext } from '@mastra/pg';
import { MastraPlatformExporter, MastraStorageExporter, Observability } from '@mastra/observability';
import { docsAgent } from './agents/docs-agent';
import { readDocs, searchDocs } from './tools/docs-tools';

export const storage = new PostgresStoreVNext({
  id: 'mastra-storage',
  connectionString: process.env.DATABASE_URL!,
  observability: {
    connectionString: process.env.DATABASE_URL!,
  },
});

export const mastra = new Mastra({
  agents: { docsAgent },
  tools: { searchDocs, readDocs },
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
            projectName: process.env.BRAINTRUST_PROJECT_NAME || 'mastra-docs-agent',
          }),
        ],
      },
    },
  }),
});
