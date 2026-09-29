# Mastra Docs Agent

A single agent that answers Mastra questions from the official documentation, with source links and practical TypeScript examples.

## Run

Use Node.js 22.13+ and pnpm. Install dependencies, then copy the environment file:

```sh
pnpm install
cp .env.example .env
```

Set `OPENROUTER_API_KEY` in `.env`, then start Mastra Studio. Locally, storage defaults to `file:./mastra.db`. For deployment, inject `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use your hosted database:

```sh
pnpm run dev
```

Open [localhost:4111](http://localhost:4111), select **Mastra Docs**, and ask:

- How do I give a Mastra agent a custom tool?
- How do I add conversation memory to an agent?
- When should I use a workflow instead of an agent?

## How it works

The agent searches titles and URLs in [mastra.ai/llms.txt](https://mastra.ai/llms.txt), reads the relevant Markdown pages, and cites them in its answers. Index searches return up to 20 matches, and the index is cached in memory for five minutes. Page content is fetched on demand. Both tools use a 15-second request timeout; page reads are restricted to URLs in the official index.

The model is `openrouter/qwen/qwen3.8-27b`, configured in `src/mastra/agents/docs-agent.ts`, with up to eight steps per response. Basic conversation history keeps the last ten messages available for follow-ups and is persisted in local SQLite or the configured Turso database. Studio handles conversation identifiers automatically; API callers should supply their own memory thread and resource IDs.

This project has no crawler, embeddings, vector database, workflows, or evals. It requires internet access to Mastra's documentation and the model provider.

During `pnpm run dev`, `MastraStorageExporter` writes agent and tool traces to local DuckDB (`./mastra.duckdb` in the server's working directory), while conversation history uses SQLite or Turso. This reconnects the existing local DuckDB trace store. Production builds use the configured SQLite/Turso database for storage, without loading DuckDB. Inspect traces in Studio's Observability view.

`MastraPlatformExporter` also sends telemetry to Mastra Platform using its runtime environment configuration. Outside Platform, configure `MASTRA_PLATFORM_ACCESS_TOKEN` and `MASTRA_PROJECT_ID` to enable this exporter; without an access token it stays disabled.

To also send traces to Braintrust, set `BRAINTRUST_API_KEY` in `.env`. The Braintrust project defaults to `mastra-docs-agent`; override it with `BRAINTRUST_PROJECT_NAME`. Without a Braintrust key, its exporter is disabled and database trace storage continues.

Additional exporters read their configuration from `.env` locally or your deployment environment:

| Exporter | Required configuration | Optional configuration |
| --- | --- | --- |
| LangSmith | `LANGSMITH_API_KEY` | `LANGCHAIN_PROJECT` (set to `mastra-docs-agent` in `.env.example`), `LANGSMITH_ENDPOINT` |
| Arize AX | `ARIZE_API_KEY`, `ARIZE_SPACE_ID` | `ARIZE_PROJECT_NAME` |
| Langfuse | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | `LANGFUSE_BASE_URL` (set to the URL for your region or self-hosted instance) |

Each exporter stays disabled until its required configuration is present. For Arize Phoenix instead of AX, set `PHOENIX_COLLECTOR_ENDPOINT` and optionally `PHOENIX_API_KEY` and `PHOENIX_PROJECT_NAME`, leaving the Arize AX variables unset.

## Build

```sh
pnpm run build
pnpm run start
```
