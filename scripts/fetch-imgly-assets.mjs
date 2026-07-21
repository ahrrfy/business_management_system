/**
 * يُهيّئ أصول @imgly/background-removal للاستضافة الذاتية (مسار CUT في استوديو الصور).
 * ينزّل **المجموعة الفرعية المطلوبة فقط** (نموذج isnet_quint8 + runtime onnxruntime CPU = ~٥٤م.ب)
 * من CDN الخاص بـ@imgly إلى `client/public/imgly-assets/` (يخدمها Vite على `/imgly-assets/`).
 * يُشغَّل مرّةً وقت الإعداد/النشر: `pnpm imgly:fetch`. الأصول gitignored. راجع
 * client/src/lib/imageStudio/README.md. النموذج/الجهاز يطابقان `segment.ts` (quint8/cpu).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "1.7.0"; // يطابق @imgly/background-removal في package.json
const CDN = `https://staticimgly.com/@imgly/background-removal-data/${VERSION}/dist/`;
const OUT = path.resolve("client/public/imgly-assets");

// الموارد المطلوبة فقط (quint8 + runtime CPU). لا jsep.wasm (WebGPU، ٢٢م.ب) ولا النماذج الأثقل.
const NEEDED = new Set([
  "/models/isnet_quint8",
  "/onnxruntime-web/ort-wasm-simd-threaded.wasm",
  "/onnxruntime-web/ort-wasm-simd-threaded.mjs",
  "/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs", // ~0م.ب، احتياطاً للمُحمِّل
]);

async function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchToFile(url, dest, expectHash) {
  // تخطٍّ متعادِل: إن وُجد الملف بالهاش الصحيح لا نُعيد التنزيل (استئناف آمن).
  try {
    const existing = await readFile(dest);
    if (!expectHash || (await sha256(existing)) === expectHash) return { bytes: existing.length, skipped: true };
  } catch {
    /* غير موجود ⇒ ننزّله */
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`فشل ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectHash && (await sha256(buf)) !== expectHash) throw new Error(`هاش غير مطابق: ${dest}`);
  await writeFile(dest, buf);
  return { bytes: buf.length, skipped: false };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`جلب المانيفست من ${CDN}resources.json …`);
  const manifest = await (await fetch(CDN + "resources.json")).json();
  await writeFile(path.join(OUT, "resources.json"), JSON.stringify(manifest));

  const chunks = [];
  for (const key of Object.keys(manifest)) {
    if (!NEEDED.has(key)) continue;
    for (const c of manifest[key].chunks) chunks.push(c.hash);
  }
  console.log(`تنزيل ${chunks.length} chunk للموارد المطلوبة (quint8 + runtime CPU)…`);

  let done = 0;
  let bytes = 0;
  for (const h of chunks) {
    const { bytes: b, skipped } = await fetchToFile(CDN + h, path.join(OUT, h), h);
    bytes += b;
    done++;
    if (done % 5 === 0 || done === chunks.length) {
      console.log(`  ${done}/${chunks.length} (${(bytes / 1048576).toFixed(1)}م.ب)${skipped ? " [موجود]" : ""}`);
    }
  }
  console.log(`✓ تمّت التهيئة: ${done} chunk، ${(bytes / 1048576).toFixed(1)}م.ب في ${OUT}`);
  console.log("  CUT مُفعَّل الآن (يعمل عبر publicPath=/imgly-assets/).");
}

main().catch((e) => {
  console.error("✗ فشلت التهيئة:", e.message);
  process.exit(1);
});
