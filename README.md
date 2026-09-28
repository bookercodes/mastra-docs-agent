# Mastra Docs Agent

A single agent that answers Mastra questions from the official documentation, with source links and practical TypeScript examples.

## Run

Use Node.js 22.13+ and pnpm. Install dependencies, then copy the environment file:

```sh
pnpm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, then start Mastra Studio. Locally, storage defaults to `file:./mastra.db`. For deployment, inject `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use your hosted database:

```sh
pnpm run dev
```

Open [localhost:4111](http://localhost:4111), select **Mastra Docs**, and ask:

- How do I give a Mastra agent a custom tool?
- How do I add conversation memory to an agent?
- When should I use a workflow instead of an agent?

## How it works

The agent searches titles and URLs in [mastra.ai/llms.txt](https://mastra.ai/llms.txt), reads the relevant Markdown pages, and cites them in its answers. Index searches return up to 20 matches, and the index is cached in memory for five minutes. Page content is fetched on demand. Both tools use a 15-second request timeout; page reads are restricted to URLs in the official index.

The model is `openai/gpt-5.6-terra`, configured in `src/mastra/agents/docs-agent.ts`, with up to eight steps per response. Basic conversation history keeps the last ten messages available for follow-ups and is persisted in local SQLite or the configured Turso database. Studio handles conversation identifiers automatically; API callers should supply their own memory thread and resource IDs.

This project has no crawler, embeddings, vector database, workflows, or evals. It requires internet access to Mastra's documentation and the model provider.

Agent and tool traces are exported through `MastraStorageExporter` to the same database as conversation history. Inspect new runs in Studio's Observability view.

`MastraPlatformExporter` also sends telemetry to Mastra Platform using its runtime environment configuration. Outside Platform, configure `MASTRA_PLATFORM_ACCESS_TOKEN` and `MASTRA_PROJECT_ID` to enable this exporter; without an access token it stays disabled.

To also send traces to Braintrust, set `BRAINTRUST_API_KEY` in `.env`. The Braintrust project defaults to `mastra-docs-agent`; override it with `BRAINTRUST_PROJECT_NAME`. Without a Braintrust key, its exporter is disabled and database trace storage continues.

## Build

```sh
pnpm run build
pnpm run start
```
