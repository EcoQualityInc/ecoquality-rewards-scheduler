import {test} from 'node:test';
import assert from 'node:assert/strict';
const {monitorRewards} = await import('../scripts/rewards/monitor.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
const env = {REWARDS_SCHEDULER_ENABLED: 'false', REWARDS_SCHEDULER_OWNER: 'EcoQualityInc', REWARDS_WORKER_SECRET: 'synthetic-monitor-key-32-characters-only'};
test('monitor calls only the fixed read-only health queue with redirect refusal', async () => {
  assert.equal(typeof monitorRewards, 'function'); let requests = 0;
  await monitorRewards({env, fetchImpl: async (url, options) => {
    requests++; assert.equal(url, 'https://ecoqualityinc.com/api/rewards/jobs?queue=health');
    assert.equal(options.redirect, 'manual'); assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${env.REWARDS_WORKER_SECRET}`);
    return Response.json({healthy: 1});
  }});
  assert.equal(requests, 1);
});
test('retired financial-dispatch configuration cannot silently disable the independent monitor', async () => {
  await assert.rejects(monitorRewards({env: {...env, REWARDS_SCHEDULER_ENABLED: 'true'}, fetchImpl: () => assert.fail('no request')}), /Rewards health check failed/);
});
test('monitor rejects failures, redirects, malformed and oversized replies without leaking response text', async () => {
  for (const response of [new Response('private diagnostic', {status: 503}), new Response('', {status: 302}),
    Response.json({orders: 1}), new Response('x'.repeat(100)), Response.json({healthy: 1, extra: 1})]) {
    await assert.rejects(monitorRewards({env, fetchImpl: async () => response}), error => {
      assert.match(error.message, /^Rewards health check failed(?: \(HTTP [1-5]\d{2}\))?\.$/);
      assert.ok(!error.message.includes('private diagnostic')); return true;
    });
  }
});

test('failed HTTP health checks report only a sanitized status code', async () => {
  await assert.rejects(monitorRewards({env, fetchImpl: async () => new Response('private customer diagnostic', {status: 503})}),
    error => error.message === 'Rewards health check failed (HTTP 503).');
});
test('missing owner or private key fails before any request', async () => {
  for (const patch of [{REWARDS_SCHEDULER_OWNER: 'other'}, {REWARDS_WORKER_SECRET: ''}]) {
    await assert.rejects(monitorRewards({env: {...env, ...patch}, fetchImpl: () => assert.fail('no request')}));
  }
});
