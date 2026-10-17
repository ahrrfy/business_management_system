import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudLab, createCloudBudget } from './lab.mjs';
import { runCloudCases } from './cloud.test.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--confirm-synthetic-sandbox')) {
    process.stderr.write('CONFIRM_SYNTHETIC_SANDBOX_REQUIRED: no cloud request was made.\n'); process.exitCode = 1;
  } else {
    const start = new Date(), budget = createCloudBudget(650), cases = [];
    const sourceHashes = {};
    for (const file of ['../commands.mjs','../schema.sql','lab.mjs','cloud.test.mjs','run.mjs']) {
      sourceHashes[file] = createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
    }
    let lab, fatal, finalFixture;
    try {
      lab = await createCloudLab({ confirmSyntheticSandbox:true, budget });
      finalFixture = await runCloudCases(lab, async result => {
        cases.push(result); process.stdout.write(`${result.status.toUpperCase()} ${result.name} (${result.requests} API calls)\n`);
        if (result.error) process.stdout.write(JSON.stringify(result.error)+'\n');
      });
    } catch (error) { fatal = {code:error.code ?? 'CLOUD_RUN_FAILED',message:error.message}; process.stderr.write(JSON.stringify(fatal)+'\n'); }
    finally { await lab?.close(); }
    const evidence = { date:start.toISOString(), finishedAt:new Date().toISOString(), node:process.version,
      runtime:'local JavaScript business commands against real Cloudflare D1 REST SQL', workerDeployed:false,
      resource:lab?.identity, sourceHashes, cases, finalFixture, counts:{pass:cases.filter(item=>item.status==='pass').length,fail:cases.filter(item=>item.status==='fail').length},
      metrics:budget, ...(fatal ? {fatal} : {}) };
    await mkdir(path.join(root,'results'),{recursive:true});
    await writeFile(path.join(root,'results','latest.json'),JSON.stringify(evidence,null,2)+'\n');
    process.stdout.write(JSON.stringify({counts:evidence.counts,requests:budget.requests,rowsRead:budget.rowsRead,rowsWritten:budget.rowsWritten,maxInflight:budget.maxInflight})+'\n');
    process.exitCode = fatal || evidence.counts.fail ? 1 : 0;
  }
}
