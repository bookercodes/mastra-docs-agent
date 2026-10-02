import { BraintrustExporter } from '@mastra/braintrust';
import { ArizeExporter } from '@mastra/arize';
import { LangfuseExporter } from '@mastra/langfuse';
import { LangSmithExporter } from '@mastra/langsmith';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { MastraPlatformExporter, MastraStorageExporter, Observability } from '@mastra/observability';
import { docsAgent } from './agents/docs-agent';
import { readDocs, searchDocs } from './tools/docs-tools';

export const storage = new LibSQLStore({
  id: 'mastra-storage',
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
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
