import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildActualWorker } from './build.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Miniflare, Log, LogLevel } = require('miniflare');
let runtime, db, bundle;
const networkAttempts = [];
const entry = `
import { createActualDb, quoteActual, prepareActualCartShare } from './actual';
import { getDb, withActualDb } from './db-shim';
import { sql } from 'drizzle-orm';
import { productPrices, storefrontCartShares } from '../../../drizzle/schema';
export default { async fetch(request, env) {
  try {
    const input = await request.json();
    const db = createActualDb(env.DB);
    let result;
    if(input.kind === 'quote') result = await quoteActual(db,input.quote);
    else if(input.kind === 'cart') result = await prepareActualCartShare(db,input.lines);
    else if(input.kind === 'context') {
      const db2=createActualDb(env.DB2);
      const contexts = await Promise.all([db,db2].map((current,index) => withActualDb(current,async()=> {
        await Promise.resolve();
        const first = getDb() === current;
        const quote=await quoteActual(getDb(),{productUnitId:1,tier:'RETAIL',quantity:1});
        await Promise.resolve();
        return {first,last:getDb()===current,price:quote.line.unitPrice};
      })));
      let outside; try {getDb()} catch(error) {outside=error.message;}
      result = {contexts,outside};
    } else if(input.kind === 'guard') {
      const stage = createActualDb(env.DB,()=>{throw new Error('unexpected staging callback')});
      if(input.op==='transaction') result=await db.transaction(async()=>{throw new Error('transaction body was entered')});
      else if(input.op==='insert') result=await db.insert(storefrontCartShares).values({token:'x',lines:[],expiresAt:new Date()});
      else if(input.op==='other-insert') result=await stage.insert(productPrices).values({productUnitId:1,priceTier:'RETAIL',price:'2.00'});
      else if(input.op==='changed-cart') result=await stage.insert(storefrontCartShares).values({id:1,token:'x',lines:[],expiresAt:new Date()});
      else result=await db.execute(sql.raw(input.sql));
    } else throw new Error('unsupported test operation');
    return Response.json(result);
  } catch(error) {
    const messages=[]; for(let current=error;current;current=current.cause) messages.push(current.message);
    return Response.json({code:error.code ?? 'ERROR',message:messages.join(' | ')},{status:400});
  }
}};`;

test.before(async () => {
  bundle = await buildActualWorker({ stdin: entry, write: false });
  runtime = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text,
    cf: false, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'actual-services-local', DB2: 'actual-services-context-local' },
    host: '127.0.0.1', port: 0, log: new Log(LogLevel.NONE),
    outboundService: async request => { networkAttempts.push(request.url); return new Response('NETWORK_UNAVAILABLE', { status: 503 }); },
  });
  db = await runtime.getD1Database('DB');
  for (const binding of ['DB', 'DB2']) {
    const bindingDb = await runtime.getD1Database(binding);
    await bindingDb.exec('CREATE TABLE productPrices (id INTEGER PRIMARY KEY, productUnitId INTEGER NOT NULL, priceTier TEXT NOT NULL, price TEXT NOT NULL, UNIQUE(productUnitId,priceTier)); CREATE TABLE storefrontCartShares (id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, lines TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT DEFAULT CURRENT_TIMESTAMP);');
    await bindingDb.prepare('INSERT INTO productPrices(productUnitId,priceTier,price) VALUES (1,\'RETAIL\',?)').bind(binding === 'DB' ? '0.10' : '999.00').run();
  }
  await db.batch([
    db.prepare('INSERT INTO productPrices(productUnitId,priceTier,price) VALUES (2,\'WHOLESALE\',\'42.25\')'),
    db.prepare('INSERT INTO productPrices(productUnitId,priceTier,price) VALUES (3,\'RETAIL\',\'0.05\')'),
    db.prepare('INSERT INTO productPrices(productUnitId,priceTier,price) VALUES (4,\'RETAIL\',\'9999999999999.99\')'),
    db.prepare('INSERT INTO productPrices(productUnitId,priceTier,price) VALUES (5,\'RETAIL\',\'1.01\')'),
  ]);
});
test.after(async () => { if (runtime) await runtime.dispose(); });

async function call(input) {
  const response = await runtime.dispatchFetch('https://actual-lab.invalid/', { method: 'POST', body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}
async function quote(override = {}) {
  return call({ kind: 'quote', quote: { productUnitId: 1, tier: 'RETAIL', quantity: 3, ...override } });
}

test('original pricing and billing execute in real workerd D1 with exact money strings', async () => {
  const cents = await quote();
  assert.equal(cents.status, 200, JSON.stringify(cents.body));
  assert.deepEqual(cents.body.line, { unitPrice: '0.10', quantity: '3.000', discountAmount: '0.00', total: '0.30' });
  assert.deepEqual(cents.body.totals, { subtotal: '0.30', discountAmount: '0.00', taxAmount: '0.00', total: '0.30' });
  const tax = await quote({ productUnitId: 3, quantity: 1, taxRate: '10', fee: '1.23' });
  assert.deepEqual(tax.body.totals, { subtotal: '0.05', discountAmount: '0.00', taxAmount: '0.01', total: '1.29' });
  const precise = await quote({ productUnitId: 5, discount: '0.02', taxRate: '5', fee: '0.10' });
  assert.deepEqual(precise.body.totals, { subtotal: '3.03', discountAmount: '0.02', taxAmount: '0.15', total: '3.26' });
  const clamp = await quote({ discount: '999', taxRate: '100', fee: '1.23' });
  assert.deepEqual(clamp.body.totals, { subtotal: '0.30', discountAmount: '0.30', taxAmount: '0.00', total: '1.23' });
  const large = await quote({ productUnitId: 4, quantity: 999 });
  assert.equal(large.body.totals.total, '9989999999999990.01');
  assert.equal((await quote({ productUnitId: 2, tier: 'WHOLESALE', quantity: 1 })).body.line.unitPrice, '42.25');
});

test('original missing-tier rejection does not fall back to a different stored tier', async () => {
  const result = await quote({ productUnitId: 2 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'PRECONDITION_FAILED');
  assert.match(result.body.message, /لا يوجد سعر للوحدة \(2\) ضمن فئة \(RETAIL\)/);
});

test('quote rejects noncanonical values, out-of-range quantities and submitted prices', async () => {
  for (const discount of ['', '00', '1e2', 'NaN', 1, '+1', ' 1', '-1', '1.005', '10000000000000']) {
    assert.equal((await quote({ discount })).status, 400, String(discount));
  }
  for (const override of [{ quantity: 0 }, { quantity: 1000 }, { quantity: 1.5 }, { taxRate: '100.01' }, { tier: 'OTHER' }, { productUnitId: 0 }, { unitPrice: '0.01' }, { fee: '-1' }]) {
    assert.equal((await quote(override)).status, 400, JSON.stringify(override));
  }
});

test('original cart normalization, 18-byte token and seven-day expiry are staged without writes', async () => {
  const before = Date.now();
  const result = await call({ kind: 'cart', lines: [
    { productId: 1, productUnitId: 11, quantity: 600 },
    { productId: 2, productUnitId: 11, quantity: 500 },
    { productId: 3, productUnitId: 12, quantity: 2 },
    { productId: 4, productUnitId: 13, quantity: 0 },
    { productId: -1, productUnitId: 14, quantity: 3 },
  ] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { plan, result: created } = result.body;
  assert.match(created.token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(created.token, plan.token);
  assert.equal(created.lineCount, 2);
  assert.deepEqual(JSON.parse(plan.linesJson), [
    { productId: 2, productUnitId: 11, quantity: 999 }, { productId: 3, productUnitId: 12, quantity: 2 },
  ]);
  const expiry = Date.parse(created.expiresAt), ttl = 7 * 24 * 60 * 60 * 1000;
  assert.ok(expiry >= before + ttl && expiry <= Date.now() + ttl);
  assert.equal(plan.expiresAt, created.expiresAt.replace('T', ' ').replace('Z', ''));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM storefrontCartShares').first()).n, 0);
  const many = await call({ kind: 'cart', lines: Array.from({ length: 120 }, (_, index) => ({ productId: index + 1, productUnitId: index + 1, quantity: 1 })) });
  assert.equal(many.body.result.lineCount, 100);
  const empty = await call({ kind: 'cart', lines: [{ productId: 1, productUnitId: 1, quantity: 0 }] });
  assert.equal(empty.body.code, 'BAD_REQUEST');
  assert.match(empty.body.message, /أضف منتجاً واحداً/);
});

test('unexpected SQL, default mutations, changed staged INSERT and transactions fail closed', async () => {
  for (const input of [
    { op: 'insert' }, { op: 'other-insert' }, { op: 'changed-cart' },
    { sql: 'UPDATE productPrices SET price = \'0.01\'' },
    { sql: 'DELETE FROM productPrices' }, { sql: 'select price from productPrices' },
    { sql: 'select `price` from `productPrices` where (`productPrices`.`productUnitId` = ? and `productPrices`.`priceTier` = ?) limit ? for update' },
  ]) {
    const result = await call({ kind: 'guard', ...input });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Unsupported actual-service operation/, JSON.stringify(input));
  }
  const transaction = await call({ kind: 'guard', op: 'transaction' });
  assert.equal(transaction.status, 400);
  assert.match(transaction.body.message, /Transactions are not supported/);
  assert.doesNotMatch(transaction.body.message, /transaction body was entered/);
  assert.equal((await quote()).body.line.unitPrice, '0.10');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM storefrontCartShares').first()).n, 0);
});

test('AsyncLocalStorage isolates concurrent DB bindings and concurrent original cart-create requests', async () => {
  const scoped = await call({ kind: 'context' });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.deepEqual(scoped.body.contexts, [
    { first: true, last: true, price: '0.10' }, { first: true, last: true, price: '999.00' },
  ]);
  assert.match(scoped.body.outside, /no request database context/);
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => call({ kind: 'cart', lines: [{ productId: index + 1, productUnitId: index + 101, quantity: index + 1 }] })));
  assert.equal(new Set(results.map(value => value.body.result.token)).size, 24);
  results.forEach((value, index) => {
    assert.equal(value.status, 200);
    assert.deepEqual(JSON.parse(value.body.plan.linesJson), [{ productId: index + 1, productUnitId: index + 101, quantity: index + 1 }]);
  });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM storefrontCartShares').first()).n, 0);
});

test('bundle evidence includes unchanged original services, excludes production DB and synthetic commands; no outbound calls', () => {
  assert.equal(Object.keys(bundle.evidence.originalSourceSha256).length, 6);
  for (const hash of Object.values(bundle.evidence.originalSourceSha256)) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(bundle.evidence.forbiddenDependencies, []);
  assert.deepEqual(bundle.evidence.originalServices.sort(), [
    'server/services/billing.ts', 'server/services/money.ts', 'server/services/pricing.ts', 'server/services/storefrontCartShareService.ts',
  ]);
  assert.deepEqual(networkAttempts, []);
});
