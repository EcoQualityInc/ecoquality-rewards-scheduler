import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const productionOrigin = 'https://ecoqualityinc.com';
const queueNames = ['orders', 'rewards', 'notifications', 'codes', 'poll'];
const maxResponseBytes = 2048;
const maxTimeoutMs = 20000;

class SchedulerFailure extends Error {}
const fail = (code) => {
  throw new SchedulerFailure(code);
};

export function schedulerConfig(env) {
  if (env.REWARDS_SCHEDULER_ENABLED !== 'true') return null;
  const origin = env.REWARDS_SCHEDULER_ORIGIN ?? productionOrigin;
  const localTest =
    env.CI === 'true' && env.REWARDS_SCHEDULER_ALLOW_LOCALHOST_TEST === 'true';
  let localOrigin = false;
  if (localTest && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) {
    try {
      const url = new URL(origin);
      localOrigin = url.origin === origin && Number(url.port) <= 65535;
    } catch {
      fail('configuration_invalid');
    }
  }
  const secret = env.REWARDS_WORKER_SECRET;
  const owner = env.REWARDS_SCHEDULER_OWNER;
  const queues = (env.REWARDS_SCHEDULER_QUEUES ?? '').split(',');
  if (
    (origin !== productionOrigin && !localOrigin) ||
    typeof owner !== 'string' ||
    owner.trim().length < 3 ||
    owner.length > 160 ||
    typeof secret !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(secret) ||
    queues.length > 5 ||
    new Set(queues).size !== queues.length ||
    queues.some((queue) => !queueNames.includes(queue))
  )
    fail('configuration_invalid');
  return {origin, secret, queues};
}

function countersFor(queue, payload) {
  const keys =
    queue === 'orders' || queue === 'rewards'
      ? ['orders', 'rewards', 'review']
      : [queue === 'poll' ? 'polled' : queue];
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(payload, key) ||
        !Number.isSafeInteger(payload[key]) ||
        payload[key] < 0 ||
        payload[key] > (key === 'polled' ? 50 : 1),
    )
  )
    fail('response_invalid');
  if (
    (queue === 'orders' &&
      (payload.rewards !== 0 || payload.review > payload.orders)) ||
    (queue === 'rewards' &&
      (payload.orders !== 0 || payload.rewards + payload.review > 1))
  )
    fail('response_invalid');
  return Object.fromEntries(keys.map((key) => [key, payload[key]]));
}

async function readCounters(response, queue) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    ) ||
    !response.body
  )
    fail('response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) fail('response_invalid');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('response_invalid');
  }
  return countersFor(queue, payload);
}

export async function runScheduler(env, {timeoutMs = maxTimeoutMs} = {}) {
  const config = schedulerConfig(env);
  if (!config) return {status: 'disabled', queues: []};
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs)
    fail('configuration_invalid');
  const queues = [];
  for (const queue of config.queues) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${config.origin}/api/rewards/jobs?queue=${queue}`,
        {
          method: 'POST',
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.secret}`,
          },
          body: '{}',
          signal: controller.signal,
        },
      );
      if (response.status !== 200) fail('http_failure');
      queues.push({queue, counters: await readCounters(response, queue)});
    } catch (error) {
      if (error instanceof SchedulerFailure) throw error;
      fail('transport_failure');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return {status: 'completed', queues};
}

export async function main(
  env,
  {write = (text) => console.log(text), ...options} = {},
) {
  try {
    const result = await runScheduler(env, options);
    write(
      result.status === 'disabled'
        ? 'Rewards scheduler disabled'
        : `Rewards scheduler completed: ${result.queues.map(({queue, counters}) => `${queue}=${JSON.stringify(counters)}`).join(' ')}`,
    );
    return 0;
  } catch (error) {
    // Never log raw errors, response bodies, headers, env, origins or private keys.
    const code =
      error instanceof SchedulerFailure ? error.message : 'scheduler_failure';
    write(`Rewards scheduler failed: ${code}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main(process.env);
}
