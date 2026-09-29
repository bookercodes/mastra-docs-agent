import { BraintrustExporter } from '@mastra/braintrust';
import { ArizeExporter } from '@mastra/arize';
import { LangfuseExporter } from '@mastra/langfuse';
import { LangSmithExporter } from '@mastra/langsmith';
import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { MastraPlatformExporter, MastraStorageExporter, Observability } from '@mastra/observability';
import { docsAgent } from './agents/docs-agent';
import { readDocs, searchDocs } from './tools/docs-tools';

const database = new LibSQLStore({
  id: 'mastra-storage',
  url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

// Load the native DuckDB adapter only for local development.
const localObservability = process.env.NODE_ENV === 'development'
  ? new (await import('@mastra/duckdb')).DuckDBStore({ path: './mastra.duckdb' }).observability
  : undefined;

export const storage = new MastraCompositeStore({
  id: 'composite-storage',
  default: database,
  domains: { observability: localObservability },
});

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
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
          new LangSmithExporter(),
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
