// اختبار السباق الحقيقي: عدّة عمليات OS تدّعي نفس الشريحة في آنٍ واحد ⇒ يجب أن يفوز واحد فقط.
// (يُثبت إغلاق ثغرة ٦/٦ على مستوى العمليات لا داخل عملية واحدة فقط.)
// وضع الطفل: node coord-race.test.mjs --child <id>  (RACE_ROOT في البيئة)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { claimAtomic, buildClaimRecord, readAllClaims } from "./coord-core.mjs";

const self = fileURLToPath(import.meta.url);
const childIdx = process.argv.indexOf("--child");

if (childIdx >= 0) {
  const id = process.argv[childIdx + 1];
  const root = process.env.RACE_ROOT;
  const res = claimAtomic(root, "race-slice", buildClaimRecord({
    slice: "race-slice", sessionKey: `s-${id}`, branch: `session/${id}`, worktree: `/wt/${id}`, ownedFiles: ["x"],
  }));
  process.stdout.write(res.ok ? "WON" : `LOST:${res.code}`);
  process.exit(res.ok ? 0 : 0);
} else {
  const root = path.join(os.tmpdir(), `coordrace-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const K = 10;
  const run = (i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [self, "--child", String(i)], { env: { ...process.env, RACE_ROOT: root } });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.on("close", () => resolve(buf.trim()));
  });
  try {
    const results = await Promise.all(Array.from({ length: K }, (_, i) => run(i)));
    const won = results.filter((r) => r === "WON").length;
    const lost = results.filter((r) => r.startsWith("LOST:EEXIST")).length;
    const claims = readAllClaims(root);
    console.log(`  نتائج ${K} عملية متزامنة: WON=${won} · LOST(EEXIST)=${lost}`);
    if (won !== 1) { console.error(`✗ فشل: فاز ${won} (يجب ١ فقط)`); process.exit(1); }
    if (lost !== K - 1) { console.error(`✗ فشل: خسر ${lost} بـ EEXIST (يجب ${K - 1})`); process.exit(1); }
    if (claims.length !== 1) { console.error(`✗ فشل: ${claims.length} ادّعاء في السجلّ (يجب ١)`); process.exit(1); }
    console.log(`\n✅ السباق محسوم: فاز واحد فقط من ${K} — القفل الذرّي يمنع التزاحم حتماً.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
