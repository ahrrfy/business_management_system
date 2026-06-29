// راكض قياس دافئ: ينفّذ كل استعلام عدّة مرّات ويُبلّغ min/median/max (ms) + EXPLAIN مختصر.
// الاستعمال: node scripts/bench/runBench.mjs [--runs=6] [--from=2026-05-01] [--to=2026-05-31]
// يقرأ DATABASE_URL من .env (يجب أن تكون قاعدة bench معزولة).
import "dotenv/config";
import mysql from "mysql2/promise";
import { performance } from "node:perf_hooks";

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.split("=")[1] : d; };
const RUNS = Number(arg("runs", 6));
const FROM = arg("from", "2026-05-01");
const TO = arg("to", "2026-05-31");
const TO_NEXT = new Date(new Date(`${TO}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

const url = process.env.DATABASE_URL;
const u = new URL(url);
if ((u.port || "3306") === "3306" || ["erp", "erp_test"].includes(u.pathname.slice(1))) {
  console.error("⛔ يجب قاعدة bench معزولة (لا 3306/erp/erp_test)."); process.exit(1);
}
const conn = await mysql.createConnection({ uri: url });

const base = (where) => `SELECT COUNT(*) c, COALESCE(SUM(ii.total),0) rev
  FROM invoiceItems ii JOIN invoices i ON i.id = ii.invoiceId WHERE ${where}`;
const nonSarg = (br) => `DATE(i.invoiceDate) >= '${FROM}' AND DATE(i.invoiceDate) <= '${TO}' AND i.invoiceStatus NOT IN ('CANCELLED')${br ? ` AND i.branchId=${br}` : ""}`;
const sarg = (br) => `i.invoiceDate >= '${FROM} 00:00:00' AND i.invoiceDate < '${TO_NEXT} 00:00:00' AND i.invoiceStatus NOT IN ('CANCELLED')${br ? ` AND i.branchId=${br}` : ""}`;

const cases = [
  ["non-sargable, no branch", base(nonSarg(null))],
  ["sargable,     no branch", base(sarg(null))],
  ["non-sargable, branch=1 ", base(nonSarg(1))],
  ["sargable,     branch=1 ", base(sarg(1))],
];

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

try {
  console.log(`قياس على ${u.pathname.slice(1)} | نافذة ${FROM}..${TO} | ${RUNS} تشغيلات/استعلام\n`);
  for (const [label, q] of cases) {
    // EXPLAIN: التقط الفهرس المستعمل وصفوف الفحص على invoices
    const [exp] = await conn.query(`EXPLAIN FORMAT=JSON ${q}`);
    const plan = JSON.parse(exp[0]["EXPLAIN"]);
    const findInv = (o) => {
      if (!o || typeof o !== "object") return null;
      if (o.table_name === "i") return o;
      for (const v of Object.values(o)) { const r = findInv(v); if (r) return r; }
      return null;
    };
    const it = findInv(plan.query_block);
    const key = it?.key ?? "(none)";
    const rowsEx = it?.rows_examined_per_scan ?? "?";
    const access = it?.access_type ?? "?";

    const times = [];
    for (let r = 0; r < RUNS; r++) {
      const t = performance.now();
      await conn.query(q);
      times.push(performance.now() - t);
    }
    const measured = times.slice(1); // أهمل الإحماء
    console.log(`${label} | invoices: ${access} key=${key} rows_est=${rowsEx}`);
    console.log(`   ms: min=${Math.min(...measured).toFixed(0)} med=${median(measured).toFixed(0)} max=${Math.max(...measured).toFixed(0)}\n`);
  }
  await conn.end();
} catch (e) {
  await conn.end().catch(() => {});
  console.error("✗", e?.sqlMessage ?? e?.message ?? e);
  process.exit(1);
}
