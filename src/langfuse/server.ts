import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { context, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { z } from 'zod';

const processor = new LangfuseSpanProcessor();
const telemetry = new NodeSDK({ spanProcessors: [processor] });
telemetry.start();
const { mastra } = await import('../mastra');
const langfuse = new LangfuseClient();
const requestSchema = z.object({
  datasetName: z.string().min(1),
  datasetId: z.string().min(1),
  payload: z.preprocess(value => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.object({ runName: z.string().min(1).optional() }).default({})),
});

async function runExperiment({ datasetName, datasetId, payload }: z.infer<typeof requestSchema>) {
  const dataset = await langfuse.dataset.get(datasetName);
  if (dataset.id !== datasetId) throw new Error('Dataset does not match the configured Langfuse project');
  try {
    const result = await dataset.runExperiment({
      name: 'Mastra Docs',
      runName: payload.runName,
      maxConcurrency: 2,
      task: async ({ input }) => {
        const question = z.string().min(1).parse(input);
        const parent = trace.getSpan(context.active())?.spanContext();
        const response = await mastra.getAgent('docsAgent').generate(question, {
          scorers: {},
          abortSignal: AbortSignal.timeout(180_000),
          tracingOptions: parent && { traceId: parent.traceId, parentSpanId: parent.spanId },
        });
        if (!response.text.trim()) throw new Error('The agent returned no answer');
        return response.text;
      },
    });
    console.log(await result.format());
  } finally {
    await mastra.observability.flush();
    await processor.forceFlush();
  }
}

const jobs = new Set<Promise<void>>();
const app = new Hono();
app.use('/experiments', bodyLimit({ maxSize: 64 * 1024 }));
app.post('/experiments', async c => {
  const request = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!request.success) {
    return c.text('Expected datasetName, datasetId, and optional payload.runName', 400);
  }
  // Langfuse expects an immediate response; the SDK publishes results asynchronously.
  const job = runExperiment(request.data).catch(error => console.error('Experiment failed:', error));
  jobs.add(job);
  void job.finally(() => jobs.delete(job));
  return c.json({ status: 'started' }, 202);
});
const server = serve({ fetch: app.fetch, port: 8301, hostname: '127.0.0.1' }, () => {
  console.log('Langfuse webhook: http://127.0.0.1:8301/experiments');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.close();
    await Promise.all(jobs);
    await mastra.shutdown();
    await telemetry.shutdown();
    process.exit(0);
  });
}
