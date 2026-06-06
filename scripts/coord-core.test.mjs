// اختبارات coord-core بـ node العاري (بلا vitest/قاعدة بيانات): node scripts/coord-core.test.mjs
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rmSync, mkdirSync } from "node:fs";
import {
  claimAtomic, buildClaimRecord, readAllClaims, isStale, isLive,
  matchGlob, matchesAny, isHotFile, sessionKeyFor, projectKey,
  globToRegExp, normRel, DEFAULT_LEASE_MS,
} from "./coord-core.mjs";

let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass++; };

const tmp = path.join(os.tmpdir(), `coordtest-${process.pid}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

try {
  // ١) القفل الذرّي: أول ادّعاء ينجح، الثاني EEXIST (نفس الشريحة).
  const rec = buildClaimRecord({ slice: "branch-transfers", title: "التحويلات", sessionKey: "session__a__111111", branch: "session/a", worktree: "D:/wt-a", ownedFiles: ["server/services/transferService.ts"] });
  const a = claimAtomic(tmp, "branch-transfers", rec);
  assert.equal(a.ok, true, "أول ادّعاء يجب أن ينجح");
  const rec2 = buildClaimRecord({ slice: "branch-transfers", title: "التحويلات", sessionKey: "session__b__222222", branch: "session/b", worktree: "D:/wt-b", ownedFiles: ["x"] });
  const b = claimAtomic(tmp, "branch-transfers", rec2);
  assert.equal(b.ok, false, "الادّعاء الثاني لنفس الشريحة يجب أن يفشل");
  assert.equal(b.code, "EEXIST", "سبب الفشل EEXIST");
  assert.equal(b.existing.sessionKey, "session__a__111111", "المالك يبقى الأول");
  ok("القفل الذرّي: واحد فقط يفوز بنفس الشريحة (إغلاق ثغرة ٦/٦)");

  // ٢) شريحة مختلفة تُدّعى بحرّية.
  const c = claimAtomic(tmp, "work-orders", buildClaimRecord({ slice: "work-orders", sessionKey: "session__b__222222", branch: "session/b", worktree: "D:/wt-b", ownedFiles: ["server/services/workOrderService.ts"] }));
  assert.equal(c.ok, true, "شريحة مختلفة تنجح");
  assert.equal(readAllClaims(tmp).length, 2, "ادّعاءان نشطان");
  ok("شرائح مختلفة لا تتعارض");

  // ٣) كشف الأقفال المعطوبة (lease).
  const now = 1_000_000_000_000;
  const fresh = { heartbeatAt: now, leaseMs: DEFAULT_LEASE_MS, host: os.hostname() };
  assert.equal(isStale(fresh, now, { hostname: os.hostname() }), false, "نبض حديث = حيّ");
  const old = { heartbeatAt: now - DEFAULT_LEASE_MS - 60_000, leaseMs: DEFAULT_LEASE_MS, host: os.hostname() };
  assert.equal(isStale(old, now, { hostname: os.hostname() }), true, "انتهت المهلة = معطوب");
  const otherHost = { heartbeatAt: now - DEFAULT_LEASE_MS - 60_000, leaseMs: DEFAULT_LEASE_MS, host: "OTHER-PC" };
  assert.equal(isStale(otherHost, now, { hostname: os.hostname() }), false, "مضيف آخر لا يُسترجَع");
  const liveById = { ...old, sessionId: "sid-1" };
  assert.equal(isStale(liveById, now, { hostname: os.hostname(), liveSessionIds: ["sid-1"] }), false, "جلسة حيّة بالـ id لا تُسترجَع");
  assert.equal(isLive(fresh, now, { hostname: os.hostname() }), true, "isLive للنبض الحديث");
  ok("كشف الأقفال المعطوبة: متحفّظ (لا يسترجع حيّاً أبداً)");

  // ٤) مطابقة glob.
  assert.equal(matchGlob("server/services/x.ts", "server/services/x.ts"), true, "مطابقة دقيقة");
  assert.equal(matchGlob("server/routers/xRouter.ts", "server/routers/*.ts"), true, "نجمة ضمن مجلّد");
  assert.equal(matchGlob("server/routers/sub/x.ts", "server/routers/*.ts"), false, "نجمة لا تعبر الفواصل");
  assert.equal(matchGlob("client/src/pages/a/b.tsx", "client/src/pages/**"), true, "نجمتان تعبران الفواصل");
  assert.equal(matchesAny("server/services/x.ts", ["a/b.ts", "server/services/*.ts"]), true, "matchesAny");
  ok("مطابقة glob (دقيق + * + **)");

  // ٥) الملفات الساخنة (غير حسّاسة للحالة على ويندوز).
  assert.equal(isHotFile("client/src/App.tsx"), true, "App.tsx ساخن رغم اختلاف الحالة");
  assert.equal(isHotFile("server/routers.ts"), true, "routers.ts ساخن");
  assert.equal(isHotFile("server/routers/saleRouter.ts"), false, "راوتر فرعي ليس ساخناً");
  ok("تمييز الملفات الساخنة");

  // ٦) ثبات الهوية.
  assert.equal(sessionKeyFor("D:/wt-a", "session/work-orders"), sessionKeyFor("d:/wt-a", "session/work-orders"), "sessionKey ثابت (حالة المسار)");
  assert.notEqual(sessionKeyFor("D:/wt-a", "session/work-orders"), sessionKeyFor("D:/wt-b", "session/work-orders"), "worktree مختلف ⇒ مفتاح مختلف");
  assert.equal(projectKey("D:/business_management_system"), projectKey("d:/business_management_system"), "projectKey ثابت عبر حالة الأحرف");
  ok("ثبات sessionKey/projectKey");

  // ٧) تطبيع المسارات.
  assert.equal(normRel("client\\src\\App.tsx"), "client/src/app.tsx", "تطبيع الفواصل والحالة");
  assert.equal(normRel("./server/x.ts"), "server/x.ts", "إزالة ./ البادئة");
  ok("تطبيع المسارات");

  console.log(`\n✅ كل الاختبارات نجحت (${pass} مجموعة).`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
