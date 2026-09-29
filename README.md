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

## Replay live Kapa traffic

`scripts/replay-kapa.ts` is a standalone, dependency-free TypeScript script for Node.js 22.13+. It polls Kapa once, queues new questions, and POSTs them to the non-streaming Mastra generate URL you configure. It sends the original questions and original thread/resource IDs; Kapa's answers are not sent to the agent.

Copy `.env.replay.example` to `.env.replay`, set `KAPA_API_KEY`, and check `KAPA_PROJECT_ID` and `MASTRA_AGENT_URL`. Keep the JSON state file on persistent disk. The first run starts with the last minute of traffic; set `REPLAY_START_AT` before that first run to backfill instead. Follow-ups use the responses your agent has generated since that starting point; earlier Kapa history is not imported.

On a Linux server, run it through `flock` (from util-linux) to prevent overlapping runs:

```sh
flock -n replay.lock node --experimental-strip-types --env-file=.env.replay scripts/replay-kapa.ts
```

Example crontab, every minute (replace the directory and Node path with yours):

```cron
* * * * * cd /srv/mastra-docs-agent && /usr/bin/flock -n replay.lock /usr/bin/node --experimental-strip-types --env-file=.env.replay scripts/replay-kapa.ts >> replay.log 2>&1
```

Use the same lock and state file for every invocation. If a run takes more than a minute, overlapping cron invocations skip it. Each run sends up to `REPLAY_MAX_TURNS` (default 20), sequentially, and leaves remaining turns queued. JSON logs record progress without logging questions or credentials. Rotate `replay.log` on the server.

The script uses Kapa's [List Threads endpoint](https://docs.kapa.ai/api/reference/query-v-1-projects-threads-list), cursor pagination, and a two-minute overlap on `updated_since`. Completed question/answer IDs prevent duplicates on normal subsequent runs. Retrieval-only searches and redacted/empty questions are excluded by default. Set `REPLAY_QUERY_TYPES` or `REPLAY_SKIP_THREAD_IDS` to adjust the selection. Missing user IDs fall back to the original thread ID; each thread keeps a stable resource ID.

Timeouts, interrupted POSTs, and server errors may have already produced an answer. Those turns become `uncertain` in the state file, and later turns in that conversation pause while other conversations continue. With cron stopped, inspect the destination history: if the turn completed, add its ID to `completed` with value `true` and remove it from `queue`; if it did not, change its status to `queued`. Resume cron afterward. There is no server-side idempotency guarantee, so the script deliberately avoids blindly retrying ambiguous POSTs. Clear request rejections (including HTTP 429) stay queued for the next run.

Keep the state file when restarting or redeploying the script. Removing it or using a backfill date against already-populated destination threads can replay old messages again. Changing the destination/project requires a different state file.

### Railway cron service

Connect the repository to the replay service and use `scripts/replay.Dockerfile` as its Dockerfile path, with the repository root as the build context. This image contains only the replay script and Node.js; it does not run the Mastra agent.

- Mount a persistent volume at `/data`. The image defaults `REPLAY_STATE_FILE` to `/data/replay-state.json`.
- Set the cron schedule to `*/5 * * * *` and restart policy to **Never**. Keep one replica and no HTTP healthcheck or public domain.
- Use the Docker image's default start command: `node --experimental-strip-types scripts/replay-kapa.ts`.
- Add `KAPA_API_KEY`, `KAPA_PROJECT_ID`, and `MASTRA_AGENT_URL` as Railway service variables. Add `MASTRA_AUTH_TOKEN` if the target requires authentication. Other replay settings are documented in `.env.replay.example`; do not override the volume state path with its local relative path.
- Railway skips scheduled executions while a previous execution remains active. Inspect run logs for `finished` and check `needs-review` entries before retrying uncertain turns.

For an existing replay, transfer its state file to the volume before the first run to preserve its checkpoint and deduplication history. Without an existing state file or `REPLAY_START_AT`, the first run starts from the preceding minute.
