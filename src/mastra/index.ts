import { BraintrustExporter } from '@mastra/braintrust';
import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { docsAgent } from './agents/docs-agent';
import { readDocs, searchDocs } from './tools/docs-tools';

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  agents: { docsAgent },
  tools: { searchDocs, readDocs },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: 'file:./mastra.db',
    }),
    domains: {
      observability: new DuckDBStore({ path: './mastra.duckdb' }).observability,
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra-docs-agent',
        exporters: [
          new MastraStorageExporter(),
          new BraintrustExporter({
            projectName: process.env.BRAINTRUST_PROJECT_NAME || 'mastra-docs-agent',
          }),
        ],
      },
    },
  }),
});
