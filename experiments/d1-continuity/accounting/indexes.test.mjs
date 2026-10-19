import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { Miniflare, Log, LogLevel } from "miniflare";
import { initializationSql as prior } from "../returns/schema.ts";
import { initializationSql as current } from "./schema.ts";
import { namespaceSql } from "./namespace.ts";
import { sqlStatements } from "../cash/sql-statements.mjs";
test("native sqlite_master retains every inherited index in default and namespaced initialization", async () => {
  const mf = new Miniflare({
    cf: false,
    log: new Log(LogLevel.NONE),
    modules: true,
    script: 'export default{fetch(){return new Response("test")}}',
    d1Databases: { PRIOR: "prior", CURRENT: "current", NAMESPACE: "namespace" },
  });
  try {
    const databases = await Promise.all(
      ["PRIOR", "CURRENT", "NAMESPACE"].map((n) => mf.getD1Database(n)),
    );
    for (const [i, sql] of [prior, current, current].entries())
      await databases[i].batch(
        sqlStatements(sql).map((s) =>
          databases[i].prepare(i === 2 ? namespaceSql(s) : s),
        ),
      );
    const indexes = await Promise.all(
      databases.map(
        async (db) =>
          (
            await db
              .prepare(
                "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
              )
              .all()
          ).results,
      ),
    );
    assert.equal(indexes[0].length, 14);
    assert.equal(indexes[1].length, 18);
    assert.equal(indexes[2].length, 18);
    for (const index of indexes[0])
      assert.deepEqual(
        indexes[1].find((i) => i.name === index.name),
        index,
      );
    for (const index of indexes[1])
      assert.deepEqual(
        indexes[2].find((i) => i.name === "q1gl_" + index.name),
        {
          name: "q1gl_" + index.name,
          tbl_name: "q1gl_" + index.tbl_name,
          sql: namespaceSql(index.sql),
        },
      );
    await mkdir("experiments/d1-continuity/accounting/results/namespace", {
      recursive: true,
    });
    await writeFile(
      "experiments/d1-continuity/accounting/results/namespace/native-indexes.json",
      JSON.stringify(
        {
          passed: true,
          prior: indexes[0],
          current: indexes[1],
          namespaced: indexes[2],
        },
        null,
        2,
      ),
    );
  } finally {
    await mf.dispose();
  }
});
