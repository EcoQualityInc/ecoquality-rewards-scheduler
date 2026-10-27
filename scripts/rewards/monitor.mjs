import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Independent read-only health check. It never claims or advances business work.
export async function monitorRewards({env = process.env, fetchImpl = fetch} = {}) {
  if (env.REWARDS_SCHEDULER_ENABLED === 'true') return;
  try {
    if (env.REWARDS_SCHEDULER_ENABLED !== 'false' ||
      env.REWARDS_SCHEDULER_OWNER !== 'EcoQualityInc' ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(env.REWARDS_WORKER_SECRET ?? '')) throw Error();
    const response = await fetchImpl('https://ecoqualityinc.com/api/rewards/jobs?queue=health', {
      method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20000),
      headers: {Authorization: `Bearer ${env.REWARDS_WORKER_SECRET}`, 'Content-Type': 'application/json'},
      body: '{}',
    });
    if (response.status !== 200) {await response.body?.cancel(); throw Error();}
    const reader = response.body?.getReader();
    if (!reader) throw Error();
    const chunks = []; let size = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64) {await reader.cancel(); throw Error();}
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!value || Object.keys(value).length !== 1 || value.healthy !== 1) throw Error();
  } catch {throw new Error('Rewards health check failed.');}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await monitorRewards(); process.stdout.write('Rewards health verified.\n');}
  catch {process.stderr.write('Rewards health check failed. Review the private Rewards administration.\n'); process.exitCode = 1;}
}
