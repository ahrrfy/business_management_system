import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";
import {
  buildAccountingWorker as buildReturnsWorker,
  accountingRoot as returnsRoot,
} from "./build.mjs";
import { sqlStatements } from "../cash/sql-statements.mjs";
export const creditIdentity = {
  labId: "actual-accounting-q1-native",
  schemaVersion: "actual-accounting-q1-native-v1",
};
export const saleInput = (id, patch = {}) => ({
  commandType: "SALE",
  branchId: 1,
  shiftId: 1,
  sourceType: "POS",
  customerId: 1,
  clientRequestId: id,
  lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
  ...patch,
});
export async function nativeLab({
  coordinated = false,
  candidate = false,
  name = "native",
  persistDir,
  multipleCashiers = false,
  secretOverride,
} = {}) {
  const b = path.join(returnsRoot, "build", name),
    secret = secretOverride ?? "synthetic-credit-native-secret-only",
    outbound = [];
  const journalOnly = `const u=new URL(req.url);if(u.pathname.startsWith('/journal-only/')){u.pathname=u.pathname.slice(13);const h=new Headers(req.headers);h.delete('x-cash-profile');return core.fetch(new Request(u,{method:req.method,headers:h}),{LAB_TOKEN:env.LAB_TOKEN,RECOVERY_LOG:env.RECOVERY_LOG});}`;
  const direct = `import core from '../credit/worker';export default{fetch(req,env){${journalOnly}const actor=req.headers.get('x-test-actor');return core.fetch(req,actor==='2'?{...env,TEST_ACTOR:{userId:2,branchId:2,role:'cashier'}}:env);}};`;
  const entry = `import coordinated,{CreditWriter}from'../credit/coordinated-worker';import core from'../credit/worker';import{cashTestBindings}from'../cash/test-bindings';export class TestCreditWriter extends CreditWriter{state={preparations:0,released:false,waiting:false,restartWaiting:false,restartReleased:false,abort:()=>this.ctx.abort('CREDIT_WRITER_RESET_AFTER_PRIMARY')};environment(req){const test=cashTestBindings({...this.env,CREDIT_PREPARED:()=>this.state.preparations++},req,this.state);return req.headers.get('x-test-actor')==='2'?{...test.env,TEST_ACTOR:{userId:2,branchId:2,role:'cashier'}}:test.env;}fetch(req){const p=new URL(req.url).pathname;if(p==='/test-state')return Response.json({...this.queue.stats(),instance:this.instance,waiting:this.state.waiting,restartWaiting:this.state.restartWaiting,primaryReads:this.state.primaryReads??0,preparations:this.state.preparations});if(p==='/test-release'){this.state.released=true;return Response.json({released:true});}if(p==='/test-release-restart'){this.state.restartReleased=true;return Response.json({released:true});}if(p==='/test-reset')this.ctx.abort('CREDIT_WRITER_RESET');return super.fetch(req);}}export default {fetch(req,env,ctx){${journalOnly}return coordinated.fetch(req,env,ctx);}};`;
  await buildReturnsWorker({
    candidate,
    stdin: coordinated ? entry : direct,
    outfile: path.join(b, "worker.mjs"),
  });
  const options = {
    modules: [
      { type: "ESModule", path: path.join(b, "worker.mjs") },
      { type: "CompiledWasm", path: path.join(b, "sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      LAB_TOKEN: secret,
      ...(multipleCashiers ? { CREDIT_MULTI_CASHIER_LAB: "1" } : {}),
    },
    outboundService: (req) => {
      outbound.push(req.url);
      return new Response("HOSTINGER_UNAVAILABLE", { status: 503 });
    },
  };
  const source = coordinated
    ? new Miniflare({
        cf: false,
        log: new Log(
          process.env.RETURNS_DEBUG ? LogLevel.DEBUG : LogLevel.NONE,
        ),
        ...(persistDir
          ? {
              d1Persist: path.join(persistDir, "source"),
              durableObjectsPersist: path.join(persistDir, "do"),
            }
          : {}),
        workers: [
          {
            ...options,
            name: "primary",
            d1Databases: {
              DB: "credit-primary",
              RECOVERY_LOG: "credit-journal",
            },
            durableObjects: {
              CREDIT_WRITER: { className: "TestCreditWriter", useSQLite: true },
            },
          },
          {
            ...options,
            name: "second",
            durableObjects: {
              CREDIT_WRITER: {
                className: "TestCreditWriter",
                scriptName: "primary",
              },
            },
          },
        ],
      })
    : new Miniflare({
        ...options,
        cf: false,
        log: new Log(
          process.env.RETURNS_DEBUG ? LogLevel.DEBUG : LogLevel.NONE,
        ),
        d1Databases: { DB: "credit-primary", RECOVERY_LOG: "credit-journal" },
      });
  const restore = new Miniflare({
    ...options,
    cf: false,
    log: new Log(process.env.RETURNS_DEBUG ? LogLevel.DEBUG : LogLevel.NONE),
    d1Databases: { DB: "credit-restore" },
    ...(persistDir ? { d1Persist: path.join(persistDir, "restore") } : {}),
  });
  try {
    if (process.env.RETURNS_DEBUG) console.log("bindings");
    const db = await source.getD1Database(
        "DB",
        coordinated ? "primary" : undefined,
      ),
      journal = await source.getD1Database(
        "RECOVERY_LOG",
        coordinated ? "primary" : undefined,
      ),
      rd = await restore.getD1Database("DB");
    const init = (db, s) =>
      db.batch(sqlStatements(s).map((s) => db.prepare(s)));
    for (const [d, role] of [
      [db, "primary"],
      [rd, "restore"],
    ]) {
      for (const f of ["schema.sql", "fixture.sql"]) {
        if (process.env.RETURNS_DEBUG) console.log(role, f);
        await init(d, await readFile(path.join(b, f), "utf8"));
      }
      if (multipleCashiers)
        await init(
          d,
          await readFile(path.join(b, "multi-cashier.sql"), "utf8"),
        );
      await init(
        d,
        `CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL);INSERT INTO cashSandboxIdentity VALUES('actual-accounting-q1-native','${role}');`,
      );
    }
    await init(journal, await readFile(path.join(b, "journal.sql"), "utf8"));
    let requests = 0;
    const call = async (
      target,
      route,
      input,
      fault = "",
      actor = "",
      terminal = "",
      retry = false,
    ) => {
      requests++;
      const start = performance.now(),
        r = await (
          target === source || target === restore
            ? target.dispatchFetch.bind(target)
            : target.fetch.bind(target)
        )("http://credit.test" + route, {
          method: input === undefined ? "GET" : "POST",
          headers: {
            authorization: "Bearer " + secret,
            "content-type": "application/json",
            "x-cash-profile": "1",
            ...(retry ? { "x-cash-retry": "1" } : {}),
            ...(fault ? { "x-cash-fault": fault } : {}),
            ...(actor ? { "x-test-actor": actor } : {}),
            ...(terminal ? { "x-credit-lab-terminal": terminal } : {}),
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
      return {
        status: r.status,
        body: await r.json(),
        ms: performance.now() - start,
        profile: JSON.parse(r.headers.get("x-cash-profile") ?? "null"),
        writer: JSON.parse(r.headers.get("x-cash-writer") ?? "null"),
        confirmedRead: r.headers.get("x-cash-replay") === "confirmed-read",
      };
    };
    const ok = async (...args) => {
      const r = await call(...args);
      assert.equal(r.status, 200, JSON.stringify(r));
      return r;
    };
    return {
      source,
      restore,
      db,
      journal,
      rd,
      init,
      call,
      ok,
      secret,
      outbound,
      buildDir: b,
      requests: () => requests,
      second: coordinated ? await source.getWorker("second") : null,
      async close() {
        await source.dispose();
        await restore.dispose();
      },
    };
  } catch (error) {
    await Promise.allSettled([source.dispose(), restore.dispose()]);
    throw error;
  }
}
