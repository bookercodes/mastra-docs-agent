import { BraintrustExporter } from '@mastra/braintrust';
import { ArizeExporter } from '@mastra/arize';
import { LangfuseExporter } from '@mastra/langfuse';
import { LangSmithExporter } from '@mastra/langsmith';
import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { PostgresStoreVNext } from '@mastra/pg';
import { MastraPlatformExporter, MastraStorageExporter, Observability } from '@mastra/observability';
import { docsAgent } from './agents/docs-agent';
import { readDocs, searchDocs } from './tools/docs-tools';

// Load the native DuckDB adapter only for local development.
export const storage = process.env.NODE_ENV === 'development'
  ? new MastraCompositeStore({
      id: 'composite-storage',
      default: new LibSQLStore({
        id: 'mastra-storage',
        url: 'file:./mastra.db',
      }),
      domains: {
        observability: new (await import('@mastra/duckdb')).DuckDBStore({ path: './mastra.duckdb' }).observability,
      },
    })
  : new PostgresStoreVNext({
      id: 'mastra-storage',
      connectionString: process.env.DATABASE_URL!,
      observability: {
        connectionString: process.env.OBSERVABILITY_DATABASE_URL || process.env.DATABASE_URL!,
      },
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
