import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";
import {
  buildAccountingWorker as buildReturnsWorker,
  accountingRoot as returnsRoot,
} from "./build.mjs";
import { sqlStatements } from "../cash/sql-statements.mjs";
import { namespaceBinding } from "./namespace.ts";
import { captureLegacy } from "./namespace-baseline.mjs";
export const namespaceEnabled = process.env.ACCOUNTING_NAMESPACE === "1";
export const resultRoot =
  "experiments/d1-continuity/accounting/results" +
  (namespaceEnabled
    ? "/namespace"
    : process.env.ACCOUNTING_RESULTS_SCOPE
      ? "/" + process.env.ACCOUNTING_RESULTS_SCOPE
      : "");
export const creditIdentity = {
  labId: namespaceEnabled
    ? "actual-accounting-q1-namespace"
    : "actual-accounting-q1-native",
  schemaVersion: namespaceEnabled
    ? "actual-accounting-q1-namespace-v1"
    : "actual-accounting-q1-native-v1",
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
  namespace = namespaceEnabled,
} = {}) {
  const b = path.join(
      returnsRoot,
      "build",
      (namespace
        ? "namespace-"
        : process.env.ACCOUNTING_RESULTS_SCOPE
          ? process.env.ACCOUNTING_RESULTS_SCOPE + "-"
          : "") + name,
    ),
    secret = secretOverride ?? "synthetic-credit-native-secret-only",
    outbound = [];
  const journalOnly = `const u=new URL(req.url);if(u.pathname.startsWith('/journal-only/')){u.pathname=u.pathname.slice(13);const h=new Headers(req.headers);h.delete('x-cash-profile');return core.fetch(new Request(u,{method:req.method,headers:h}),{LAB_TOKEN:env.LAB_TOKEN,RECOVERY_LOG:env.RECOVERY_LOG});}`;
  const nsImport = namespace
    ? "import{namespaceEnvironment}from'../accounting/namespace';"
    : "";
  const nsEnv = namespace ? "env=namespaceEnvironment(env);" : "";
  const direct = `${nsImport}import core from '../credit/worker';export default{fetch(req,env){${nsEnv}${journalOnly}const actor=req.headers.get('x-test-actor');return core.fetch(req,actor==='2'?{...env,TEST_ACTOR:{userId:2,branchId:2,role:'cashier'}}:env);}};`;
  const entry = `${nsImport}import coordinated,{CreditWriter}from'../credit/coordinated-worker';import core from'../credit/worker';import{cashTestBindings}from'../cash/test-bindings';export class TestCreditWriter extends CreditWriter{state={preparations:0,released:false,waiting:false,restartWaiting:false,restartReleased:false,abort:()=>this.ctx.abort('CREDIT_WRITER_RESET_AFTER_PRIMARY')};environment(req){const test=cashTestBindings({...${namespace ? "namespaceEnvironment(this.env)" : "this.env"},CREDIT_PREPARED:()=>this.state.preparations++},req,this.state);return req.headers.get('x-test-actor')==='2'?{...test.env,TEST_ACTOR:{userId:2,branchId:2,role:'cashier'}}:test.env;}fetch(req){const p=new URL(req.url).pathname;if(p==='/test-state')return Response.json({...this.queue.stats(),instance:this.instance,waiting:this.state.waiting,restartWaiting:this.state.restartWaiting,primaryReads:this.state.primaryReads??0,preparations:this.state.preparations});if(p==='/test-release'){this.state.released=true;return Response.json({released:true});}if(p==='/test-release-restart'){this.state.restartReleased=true;return Response.json({released:true});}if(p==='/test-reset')this.ctx.abort('CREDIT_WRITER_RESET');return super.fetch(req);}}export default {fetch(req,env,ctx){${nsEnv}${journalOnly}return coordinated.fetch(req,env,ctx);}};`;
  await buildReturnsWorker({
    namespace,
    candidate,
    stdin: coordinated ? entry : direct,
    outfile: path.join(b, "worker.mjs"),
  });
  const legacyDir = path.join(b, "legacy");
  if (namespace)
    await buildReturnsWorker({
      stdin: "import core from'../credit/worker';export default core;",
      outfile: path.join(legacyDir, "worker.mjs"),
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
  const legacyOptions = {
    ...options,
    modules: [
      { type: "ESModule", path: path.join(legacyDir, "worker.mjs") },
      { type: "CompiledWasm", path: path.join(legacyDir, "sql-wasm.wasm") },
    ],
  };
  const source =
    coordinated || namespace
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
              ...(coordinated
                ? {
                    durableObjects: {
                      CREDIT_WRITER: {
                        className: "TestCreditWriter",
                        useSQLite: true,
                      },
                    },
                  }
                : {}),
            },
            ...(coordinated
              ? [
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
                ]
              : []),
            ...(namespace
              ? [
                  {
                    ...legacyOptions,
                    name: "legacy",
                    d1Databases: {
                      DB: "credit-primary",
                      RECOVERY_LOG: "credit-journal",
                    },
                  },
                ]
              : []),
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
  const restoreOptions = {
    ...options,
    cf: false,
    log: new Log(process.env.RETURNS_DEBUG ? LogLevel.DEBUG : LogLevel.NONE),
    d1Databases: { DB: "credit-restore" },
    ...(persistDir ? { d1Persist: path.join(persistDir, "restore") } : {}),
  };
  const restore = new Miniflare(
    namespace
      ? {
          cf: false,
          log: options.log,
          ...(persistDir
            ? { d1Persist: path.join(persistDir, "restore") }
            : {}),
          workers: [
            { ...restoreOptions, name: "restore" },
            {
              ...legacyOptions,
              name: "legacy",
              d1Databases: { DB: "credit-restore" },
            },
          ],
        }
      : restoreOptions,
  );
  try {
    if (process.env.RETURNS_DEBUG) console.log("bindings");
    const rawDb = await source.getD1Database(
        "DB",
        coordinated || namespace ? "primary" : undefined,
      ),
      rawJournal = await source.getD1Database(
        "RECOVERY_LOG",
        coordinated || namespace ? "primary" : undefined,
      ),
      rawRestore = await restore.getD1Database(
        "DB",
        namespace ? "restore" : undefined,
      ),
      db = namespace ? namespaceBinding(rawDb) : rawDb,
      journal = namespace ? namespaceBinding(rawJournal) : rawJournal,
      rd = namespace ? namespaceBinding(rawRestore) : rawRestore;
    const init = (db, s) =>
      db.batch(sqlStatements(s).map((s) => db.prepare(s)));
    const initialize = async (primaryDb, restoreDb, journalDb, dir, labId) => {
      for (const [d, role] of [
        [primaryDb, "primary"],
        [restoreDb, "restore"],
      ]) {
        for (const f of ["schema.sql", "fixture.sql"]) {
          if (process.env.RETURNS_DEBUG) console.log(role, f);
          await init(d, await readFile(path.join(dir, f), "utf8"));
        }
        if (multipleCashiers)
          await init(
            d,
            await readFile(path.join(dir, "multi-cashier.sql"), "utf8"),
          );
        await init(
          d,
          `CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL);INSERT INTO cashSandboxIdentity VALUES('${labId}','${role}');`,
        );
      }
      await init(
        journalDb,
        await readFile(path.join(dir, "journal.sql"), "utf8"),
      );
    };
    await initialize(
      namespace ? rawDb : db,
      namespace ? rawRestore : rd,
      namespace ? rawJournal : journal,
      namespace ? legacyDir : b,
      "actual-accounting-q1-native",
    );
    let requests = 0;
    const pageBytes = [];
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
      const responseText = await r.text();
      if (
        r.status === 200 &&
        (/\/snapshot\?table=/.test(route) || /\/recovery-log/.test(route))
      ) {
        const size = new TextEncoder().encode(responseText).byteLength;
        assert.ok(
          size <= 131072,
          "namespace response page exceeds byte ceiling",
        );
        pageBytes.push({ route, bytes: size });
      }
      return {
        status: r.status,
        body: JSON.parse(responseText),
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
    let legacyRecords,
      legacyBefore,
      sourceFrozen = false;
    const verifyLegacy = async () => {
      if (!namespace) return;
      const after = {
        ...(sourceFrozen
          ? { primary: legacyBefore.primary, journal: legacyBefore.journal }
          : await captureLegacy({ primary: rawDb, journal: rawJournal })),
        ...(await captureLegacy({ restore: rawRestore })),
      };
      assert.deepEqual(
        after,
        legacyBefore,
        "complete bare DDL and rows changed",
      );
      await writeFile(
        resultRoot + "/legacy-" + name + ".json",
        JSON.stringify(
          {
            before: legacyBefore,
            after,
            sourceVerifiedBeforeDisposal: sourceFrozen,
          },
          null,
          2,
        ),
      );
      return after;
    };
    if (namespace) {
      const legacy = await source.getWorker("legacy"),
        legacyRestore = await restore.getWorker("legacy");
      await ok(
        legacy,
        "/sale",
        saleInput("legacy-collision-history", {
          commandType: "CASH_SALE",
          payment: { method: "CASH", amount: "2500.00" },
        }),
      );
      const log = await ok(legacy, "/recovery-log");
      legacyRecords = log.body.records;
      await ok(legacyRestore, "/restore", { records: log.body.records });
      legacyBefore = await captureLegacy({
        primary: rawDb,
        restore: rawRestore,
        journal: rawJournal,
      });
      await mkdir(resultRoot, { recursive: true });
      await initialize(db, rd, journal, b, "actual-accounting-q1-namespace");
      await verifyLegacy();
    }
    return {
      source,
      restore,
      db,
      journal,
      rd,
      rawDb,
      rawJournal,
      rawRestore,
      legacyBefore,
      legacyRecords,
      verifyLegacy,
      async freezeLegacySource() {
        await verifyLegacy();
        sourceFrozen = true;
      },
      init,
      call,
      ok,
      secret,
      outbound,
      buildDir: b,
      pageBytes,
      requests: () => requests,
      second: coordinated ? await source.getWorker("second") : null,
      async close() {
        await verifyLegacy();
        await source.dispose();
        await restore.dispose();
      },
    };
  } catch (error) {
    await Promise.allSettled([source.dispose(), restore.dispose()]);
    throw error;
  }
}
