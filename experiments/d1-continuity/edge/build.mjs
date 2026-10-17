import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const edgeRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(edgeRoot, '../../..');
const originals = [
  'server/services/pricing.ts', 'server/services/billing.ts', 'server/services/money.ts',
  'server/services/storefrontCartShareService.ts', 'drizzle/schema.ts', 'shared/errors.ts',
];
const normalize = value => value.replaceAll('\\', '/');

/** These two exact substitutions are the complete test-only port boundary. */
function isolatedDependencies() {
  return {
    name: 'actual-service-isolated-db',
    setup(builder) {
      builder.onResolve({ filter: /^\./ }, args => {
        const target = path.resolve(args.resolveDir, args.path).replace(/\.ts$/, '');
        if (target === path.join(root, 'server/db')) return { path: path.join(edgeRoot, 'db-shim.ts') };
        if (target === path.join(root, 'server/services/storefrontService')) return { path: 'storefront-product', namespace: 'unsupported-storefront' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'unsupported-storefront' }, () => ({
        contents: 'export function storefrontProduct() { throw new Error("Unsupported actual-service operation: storefrontProduct graph has not been ported"); }',
        loader: 'js',
      }));
    },
  };
}

export async function buildActualWorker(options = {}) {
  const outfile = options.outfile ?? path.join(edgeRoot, 'build/worker.mjs');
  const write = options.write ?? true;
  const result = await build({
    absWorkingDir: root,
    ...(options.stdin ? { stdin: { contents: options.stdin, resolveDir: edgeRoot, sourcefile: 'actual-test-entry.ts', loader: 'ts' } } : { entryPoints: [options.entry ?? path.join(edgeRoot, 'worker.ts')] }),
    outfile,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'import', 'default'],
    external: ['node:*'],
    treeShaking: true,
    // Generated dependency lint directives reference plugins outside this project.
    minifyWhitespace: true,
    legalComments: 'none',
    metafile: true,
    plugins: [isolatedDependencies()],
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs).map(normalize);
  const forbidden = inputs.filter(input => /(?:^|\/)mysql2(?:\/|$)|(?:^|\/)server\/db\.ts$|(?:^|\/)commands\.mjs$|node_modules\/.*(?:firebase|openai|stripe|twilio)/i.test(input));
  const services = inputs.filter(input => input.startsWith('server/services/'));
  const unsupportedServices = inputs.filter(input => input.startsWith('server/') && !originals.includes(input));
  if (forbidden.length || unsupportedServices.length) throw new Error(`Unexpected production dependency: ${[...forbidden, ...unsupportedServices].join(', ')}`);
  for (const source of originals) {
    if (!inputs.includes(source)) throw new Error(`Missing original source in Worker graph: ${source}`);
  }
  const hashes = Object.fromEntries(await Promise.all(originals.map(async source => [source, createHash('sha256').update(await readFile(path.join(root, source))).digest('hex')])));
  const evidence = {
    originalSourceSha256: hashes,
    substitutions: {
      'server/db.ts': 'experiments/d1-continuity/edge/db-shim.ts (request-scoped getDb only)',
      'server/services/storefrontService.ts': 'throwing storefrontProduct stub (resolve cart is not exposed)',
    },
    forbiddenDependencies: forbidden,
    originalServices: services,
    metafile: result.metafile,
  };
  if (write) {
    await mkdir(path.dirname(outfile), { recursive: true });
    await writeFile(outfile, result.outputFiles[0].contents);
    await writeFile(path.join(path.dirname(outfile), 'source-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return { ...result, evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildActualWorker();
  console.log(JSON.stringify({ worker: 'build/worker.mjs', bytes: result.outputFiles[0].contents.length, sourceHashes: result.evidence.originalSourceSha256 }));
}
