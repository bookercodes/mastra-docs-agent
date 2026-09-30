/**
 * Run worker: node --experimental-strip-types --env-file=.env.replay scripts/replay-kapa.ts
 * Requires Node 22.13+. No npm dependencies. Add --once for a single poll.
 * Kapa contract: https://docs.kapa.ai/api/reference/query-v-1-projects-threads-list
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Turn = {
  id: string;
  thread: string;
  resource: string;
  question: string;
  createdAt: string;
  status: 'queued' | 'sending' | 'uncertain';
};
type State = {
  version: 1;
  project: string;
  target: string;
  startAt: string;
  updatedSince: string;
  completed: Record<string, true>;
  resources: Record<string, string>;
  queue: Turn[];
};
type QuestionAnswer = {
  id: string;
  thread_id?: string;
  question: string;
  created_at: string;
  end_user_id?: string | null;
  query_type: string;
  is_redacted?: boolean;
};
type Thread = { id: string; question_answers: QuestionAnswer[]; has_more_question_answers?: boolean };
type Page = { results: Thread[]; next_cursor: string | null };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in your environment file.`);
  return value;
}

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function timestamp(value: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid timestamp: ${value}`);
  return new Date(value).toISOString();
}

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

class PollError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs = 0) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfter(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

let stopping = false;
let wake: (() => void) | undefined;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log('stopping', { signal, message: 'Finishing the active request and saving progress.' });
  wake?.();
}

async function wait(milliseconds: number) {
  // Chunk very long Retry-After values to avoid Node's timer overflow limit.
  const until = Date.now() + milliseconds;
  while (!stopping && Date.now() < until) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.min(until - Date.now(), 2_147_483_647));
      function done() { clearTimeout(timer); wake = undefined; resolve(); }
      wake = done;
      if (stopping) done();
    });
  }
}

async function runCycle() {
  const apiKey = required('KAPA_API_KEY');
  const project = required('KAPA_PROJECT_ID');
  const target = new URL(required('MASTRA_AGENT_URL')).href;
  const base = new URL(process.env.KAPA_API_BASE_URL || 'https://api.kapa.ai/');
  const stateFile = resolve(process.env.REPLAY_STATE_FILE || './replay-state.json');
  const maxTurns = integer('REPLAY_MAX_TURNS', 20);
  const timeout = integer('REPLAY_TIMEOUT_SECONDS', 180) * 1_000;
  const types = new Set((process.env.REPLAY_QUERY_TYPES || 'conversation,agent_conversation,zendesk_agent_conv').split(',').map(x => x.trim()));
  const skip = new Set((process.env.REPLAY_SKIP_THREAD_IDS || '').split(',').map(x => x.trim()));
  const scannedAt = new Date().toISOString();
  let state: State;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.version !== 1 || state.project !== project || state.target !== target ||
        !state.completed || !state.resources || !Array.isArray(state.queue)) {
      throw new Error('State does not match this project/target or has an invalid format. Use a separate state file.');
    }
    timestamp(state.startAt);
    timestamp(state.updatedSince);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const startAt = timestamp(process.env.REPLAY_START_AT || new Date(Date.now() - 60_000).toISOString());
    state = { version: 1, project, target, startAt, updatedSince: startAt, completed: {}, resources: {}, queue: [] };
  }

  async function save() {
    await mkdir(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, stateFile);
  }

  // Save the initial boundary even if the first fetch fails.
  await save();

  async function get<T>(url: URL): Promise<T> {
    try {
      const response = await fetch(url, {
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
      if (!response.ok) {
        const delay = retryAfter(response);
        await response.body?.cancel();
        throw new PollError(`Kapa GET ${url.pathname}: HTTP ${response.status}`, delay);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof PollError) throw error;
      throw new PollError(`Kapa GET ${url.pathname}: ${(error as Error).message}`);
    }
  }

  // An interrupted POST may already have executed. Never automatically resend it.
  for (const turn of state.queue) {
    if (turn.status === 'sending') turn.status = 'uncertain';
  }

  const known = new Set([...Object.keys(state.completed), ...state.queue.map(turn => turn.id)]);
  const cursorHistory = new Set<string>();
  let cursor: string | null = null;
  let fetched = 0;
  const additions: Turn[] = [];
  do {
    if (stopping) return { failures: 0, retry: false, retryAfterMs: 0 };
    const url = new URL(`query/v1/projects/${encodeURIComponent(project)}/threads/`, base);
    // Overlap polling windows to cover indexing delays and boundary timestamps.
    url.searchParams.set('updated_since', new Date(Math.max(Date.parse(state.startAt), Date.parse(state.updatedSince) - 120_000)).toISOString());
    url.searchParams.set('sort', 'asc');
    url.searchParams.set('page_size', '100');
    url.searchParams.set('include', 'end_user');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await get<Page>(url);
    if (!Array.isArray(page.results) || !(page.next_cursor === null || typeof page.next_cursor === 'string')) {
      throw new Error('Unexpected Kapa thread-list response; expected results and next_cursor.');
    }
    for (let thread of page.results) {
      if (stopping) return { failures: 0, retry: false, retryAfterMs: 0 };
      if (!thread.id || !Array.isArray(thread.question_answers)) throw new Error('Invalid Kapa thread.');
      if (skip.has(thread.id)) continue;
      // List results omit query_type and can truncate turns; fetch details when needed.
      if (thread.has_more_question_answers || thread.question_answers.some(qa =>
        !('end_user_id' in qa) || typeof qa.query_type !== 'string')) {
        const id = thread.id;
        thread = await get<Thread>(new URL(`query/v1/threads/${encodeURIComponent(id)}/`, base));
        if (thread.id !== id || !Array.isArray(thread.question_answers) || thread.has_more_question_answers) {
          throw new Error(`Could not retrieve the full conversation for ${id}.`);
        }
      }
      const turns = [...thread.question_answers].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      for (const qa of turns) {
        if (typeof qa.id !== 'string' || !qa.id || typeof qa.question !== 'string' || typeof qa.query_type !== 'string') {
          throw new Error(`Unexpected question/answer fields in thread ${thread.id}.`);
        }
        const createdAt = timestamp(qa.created_at);
        if (qa.thread_id && qa.thread_id !== thread.id) throw new Error(`Thread mismatch for ${qa.id}.`);
        if (createdAt < state.startAt || known.has(qa.id) || !types.has(qa.query_type) || qa.is_redacted || !qa.question.trim()) continue;
        // A thread keeps the same owner even if a later message has no user ID.
        const resource = state.resources[thread.id] || turns.find(turn => turn.end_user_id)?.end_user_id || thread.id;
        state.resources[thread.id] = resource;
        additions.push({ id: qa.id, thread: thread.id, resource, question: qa.question, createdAt, status: 'queued' });
        known.add(qa.id);
      }
      fetched++;
    }
    cursor = page.next_cursor;
    if (cursor) {
      if (cursorHistory.has(cursor)) throw new Error('Kapa returned a repeated pagination cursor.');
      cursorHistory.add(cursor);
    }
  } while (cursor);

  // Commit the fetched queue and polling checkpoint together, before generating anything.
  state.queue.push(...additions);
  state.queue.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  state.updatedSince = scannedAt;
  await save();
  log('fetched', { threads: fetched, newTurns: additions.length, queued: state.queue.length });

  const blocked = new Set(state.queue.filter(turn => turn.status === 'uncertain').map(turn => turn.thread));
  let sent = 0;
  let attempted = 0;
  let failures = blocked.size;
  let retry = false;
  let retryAfterMs = 0;
  for (const turn of [...state.queue]) {
    if (stopping) break;
    if (skip.has(turn.thread)) continue;
    if (blocked.has(turn.thread)) {
      if (turn.status === 'uncertain') log('needs-review', { threadId: turn.thread, questionAnswerId: turn.id, stateFile });
      continue;
    }
    if (attempted >= maxTurns) break;
    attempted++;
    turn.status = 'sending';
    await save();
    if (stopping) {
      turn.status = 'queued';
      await save();
      break;
    }
    const started = Date.now();
    let rateLimited = false;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.MASTRA_AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.MASTRA_AUTH_TOKEN}`;
      const response = await fetch(target, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          messages: [{ role: 'user', content: turn.question }],
          memory: { thread: turn.thread, resource: turn.resource },
        }),
      });
      if (!response.ok) {
        rateLimited = response.status === 429;
        retryAfterMs = Math.max(retryAfterMs, retryAfter(response));
        // These statuses reject the request before generation. Other failures may be partial.
        turn.status = [400, 401, 403, 404, 422, 429].includes(response.status) ? 'queued' : 'uncertain';
        await response.body?.cancel();
        throw new Error(`Mastra POST: HTTP ${response.status}`);
      }
      const result = await response.json() as { text?: string; finishReason?: string };
      if (typeof result.text !== 'string' || !result.text.trim() || result.finishReason === 'error') {
        throw new Error('Mastra returned no usable answer.');
      }
    } catch (error) {
      if (turn.status === 'sending') turn.status = 'uncertain';
      blocked.add(turn.thread);
      failures++;
      retry = true;
      await save();
      log('failed', { threadId: turn.thread, questionAnswerId: turn.id, status: turn.status, error: (error as Error).message });
      if (rateLimited) break;
      continue;
    }
    // Checkpoint each successful turn. A disk failure must stop the run here.
    state.completed[turn.id] = true;
    state.queue = state.queue.filter(item => item.id !== turn.id);
    await save();
    sent++;
    log('replayed', { threadId: turn.thread, questionAnswerId: turn.id, seconds: (Date.now() - started) / 1_000 });
  }
  log('finished', { sent, remaining: state.queue.length, failures });
  return { failures, retry, retryAfterMs };
}

async function main() {
  const once = process.argv.includes('--once');
  const interval = integer('REPLAY_POLL_SECONDS', 60) * 1_000;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  log('started', { mode: once ? 'once' : 'worker', pollSeconds: interval / 1_000 });
  let consecutiveFailures = 0;
  while (!stopping) {
    const started = Date.now();
    let retry = false;
    let retryAfterMs = 0;
    try {
      const result = await runCycle();
      retry = result.retry;
      retryAfterMs = result.retryAfterMs;
      if (once && result.failures) process.exitCode = 1;
    } catch (error) {
      // Configuration, invalid state and checkpoint-write errors must stop the worker.
      if (!(error instanceof PollError)) throw error;
      log('poll-failed', { error: error.message });
      retry = true;
      retryAfterMs = error.retryAfterMs;
      if (once) process.exitCode = 1;
    }
    if (once || stopping) break;
    consecutiveFailures = retry ? consecutiveFailures + 1 : 0;
    const delay = retry
      ? Math.max(interval, Math.min(900_000, interval * 2 ** Math.min(consecutiveFailures - 1, 10)), retryAfterMs)
      : Math.max(0, interval - (Date.now() - started));
    log('waiting', { seconds: Math.ceil(delay / 1_000), backoff: retry });
    await wait(delay);
  }
  log('stopped');
}

main().catch(error => {
  console.error(JSON.stringify({ event: 'error', error: (error as Error).message }));
  process.exitCode = 1;
});
