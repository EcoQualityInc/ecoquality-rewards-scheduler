import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';

const runner =
  await import('../../scripts/rewards/actions-scheduler.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  });
const secret = 'synthetic_worker_key_not_a_real_secret_1234';
const allQueues = 'orders,rewards,notifications,codes,poll';
const replies = {
  orders: {orders: 1, rewards: 0, review: 1},
  rewards: {orders: 0, rewards: 1, review: 0},
  notifications: {notifications: 1},
  codes: {codes: 1},
  poll: {polled: 50},
};
function implementation() {
  assert.ok(runner, 'bounded Actions scheduler runner must exist');
  return runner;
}
async function local(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body,
    });
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    requests,
    env: {
      CI: 'true',
      REWARDS_SCHEDULER_ALLOW_LOCALHOST_TEST: 'true',
      REWARDS_SCHEDULER_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      REWARDS_SCHEDULER_ENABLED: 'true',
      REWARDS_SCHEDULER_OWNER: 'Synthetic operator',
      REWARDS_SCHEDULER_QUEUES: allQueues,
      REWARDS_WORKER_SECRET: secret,
    },
  };
}
function reply(res, body, status = 200, type = 'application/json') {
  res.writeHead(status, {'Content-Type': type});
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

test('disabled gate performs no I/O and needs no secret or owner', async () => {
  const {runScheduler} = implementation();
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
    assert.deepEqual(await runScheduler({REWARDS_SCHEDULER_ENABLED: flag}), {
      status: 'disabled',
      queues: [],
    });
  }
});

test('production configuration pins the literal origin and rejects preview, URL and credential variants', async (t) => {
  const {schedulerConfig, runScheduler} = implementation();
  const {env, requests} = await local(t, (_req, res) => reply(res, {}));
  const production = {
    ...env,
    REWARDS_SCHEDULER_ALLOW_LOCALHOST_TEST: undefined,
    REWARDS_SCHEDULER_ORIGIN: 'https://ecoqualityinc.com',
  };
  assert.equal(schedulerConfig(production).origin, 'https://ecoqualityinc.com');
  for (const origin of [
    'https://www.ecoqualityinc.com',
    'https://ecoqualityinc.com/',
    'https://ecoqualityinc.com?share=private',
    'https://ecoqualityinc.com.evil.example',
    'https://preview.example',
    'http://ecoqualityinc.com',
    'https://ecoqualityinc.com:443',
    env.REWARDS_SCHEDULER_ORIGIN,
  ]) {
    await assert.rejects(
      runScheduler({...production, REWARDS_SCHEDULER_ORIGIN: origin}),
      /configuration_invalid/,
    );
  }
  for (const change of [
    {CI: undefined},
    {REWARDS_SCHEDULER_ALLOW_LOCALHOST_TEST: 'false'},
    {REWARDS_SCHEDULER_OWNER: ''},
    {REWARDS_SCHEDULER_QUEUES: ''},
    {REWARDS_SCHEDULER_QUEUES: 'orders,orders'},
    {REWARDS_SCHEDULER_QUEUES: 'orders,unknown'},
    {REWARDS_WORKER_SECRET: 'short'},
    {REWARDS_WORKER_SECRET: 'x'.repeat(257)},
    {REWARDS_WORKER_SECRET: `${secret}\n`},
    {REWARDS_SCHEDULER_ORIGIN: 'http://127.0.0.1.evil.example:1234'},
    {REWARDS_SCHEDULER_ORIGIN: 'http://127.0.0.1:65536'},
    {REWARDS_SCHEDULER_ORIGIN: `${env.REWARDS_SCHEDULER_ORIGIN}/private`},
  ])
    await assert.rejects(
      runScheduler({...env, ...change}),
      /configuration_invalid/,
    );
  assert.equal(requests.length, 0);
});

test('one private POST per queue returns only bounded counters and no provider data', async (t) => {
  const {runScheduler} = implementation();
  const {env, requests} = await local(t, (req, res) => {
    const queue = new URL(req.url, 'http://127.0.0.1').searchParams.get(
      'queue',
    );
    reply(res, replies[queue]);
  });
  const result = await runScheduler(env);
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.queues,
    Object.entries(replies).map(([queue, counters]) => ({queue, counters})),
  );
  assert.deepEqual(
    requests.map((r) => r.url),
    allQueues.split(',').map((q) => `/api/rewards/jobs?queue=${q}`),
  );
  assert.ok(
    requests.every(
      (r) =>
        r.method === 'POST' &&
        r.body === '{}' &&
        r.headers.authorization === `Bearer ${secret}` &&
        r.headers['content-type'] === 'application/json',
    ),
  );
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('redirects never forward bearer headers or invoke a second request', async (t) => {
  const {runScheduler} = implementation();
  for (const status of [301, 302, 307, 308]) {
    const {env, requests} = await local(t, (_req, res) => {
      res.writeHead(status, {Location: '/capture-private-key'});
      res.end();
    });
    await assert.rejects(runScheduler(env), /http_failure/);
    assert.equal(requests.length, 1);
  }
});

test('HTTP failures stop subsequent queues without retries or private error output', async (t) => {
  const {main} = implementation();
  for (const status of [401, 404, 429, 503]) {
    const {env, requests} = await local(t, (_req, res) =>
      reply(res, `${secret} https://private.example/share`, status),
    );
    const output = [];
    assert.equal(await main(env, {write: (text) => output.push(text)}), 1);
    assert.deepEqual(output, ['Rewards scheduler failed: http_failure']);
    assert.equal(requests.length, 1);
  }
});

test('invalid JSON shapes, types and business counters cannot report success', async (t) => {
  const {runScheduler} = implementation();
  for (const [queue, body] of [
    ['orders', '{'],
    ['orders', 'null'],
    ['orders', '[]'],
    ['orders', {orders: '1', rewards: 0, review: 0}],
    ['orders', {orders: 0, rewards: 1, review: 0}],
    ['orders', {orders: 0, rewards: 0, review: 1}],
    ['orders', {...replies.orders, private: secret}],
    ['rewards', {orders: 0, rewards: 1, review: 1}],
    ['notifications', {notifications: -1}],
    ['codes', {codes: 1.5}],
    ['poll', {polled: 51}],
    ['poll', {polled: '10'}],
  ]) {
    const {env} = await local(t, (_req, res) => reply(res, body));
    await assert.rejects(
      runScheduler({...env, REWARDS_SCHEDULER_QUEUES: queue}),
      /response_invalid/,
    );
  }
});

test('HTML preview pages and oversized response streams fail closed', async (t) => {
  const {runScheduler} = implementation();
  for (const [body, type] of [
    ['<html>Share preview</html>', 'text/html'],
    [' '.repeat(4096), 'application/json'],
  ]) {
    const {env} = await local(t, (_req, res) => reply(res, body, 200, type));
    await assert.rejects(runScheduler(env), /response_invalid/);
  }
});

test('timeout bounds headers and streaming bodies with no automatic retry', async (t) => {
  const {runScheduler} = implementation();
  for (const headers of [false, true]) {
    const {env, requests} = await local(t, (_req, res) => {
      if (headers) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.write('{');
      }
    });
    await assert.rejects(
      runScheduler(env, {timeoutMs: 80}),
      /transport_failure/,
    );
    assert.equal(requests.length, 1);
  }
});

test('selected queues remain serial, bounded and safely summarized', async (t) => {
  const {main} = implementation();
  let active = 0,
    maxActive = 0;
  const {env, requests} = await local(t, (req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active--;
      const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('queue');
      reply(res, replies[q]);
    }, 5);
  });
  const output = [];
  assert.equal(
    await main(
      {...env, REWARDS_SCHEDULER_QUEUES: 'codes,poll'},
      {write: (text) => output.push(text)},
    ),
    0,
  );
  assert.equal(maxActive, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(output, [
    'Rewards scheduler completed: codes={"codes":1} poll={"polled":50}',
  ]);
});
