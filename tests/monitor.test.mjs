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
test('monitor does nothing while the GitHub business processor is enabled', async () => {
  await monitorRewards({env: {...env, REWARDS_SCHEDULER_ENABLED: 'true'}, fetchImpl: () => assert.fail('no request')});
});
test('monitor rejects failures, redirects, malformed and oversized replies without leaking response text', async () => {
  for (const response of [new Response('private diagnostic', {status: 503}), new Response('', {status: 302}),
    Response.json({orders: 1}), new Response('x'.repeat(100)), Response.json({healthy: 1, extra: 1})]) {
    await assert.rejects(monitorRewards({env, fetchImpl: async () => response}), error => {
      assert.equal(error.message, 'Rewards health check failed.'); return true;
    });
  }
});
test('missing owner or private key fails before any request', async () => {
  for (const patch of [{REWARDS_SCHEDULER_OWNER: 'other'}, {REWARDS_WORKER_SECRET: ''}]) {
    await assert.rejects(monitorRewards({env: {...env, ...patch}, fetchImpl: () => assert.fail('no request')}));
  }
});
