// حارس db:push: في الإنتاج push العاري يتجاوز بوّابة الهجرة (نسخة طازجة أولاً) — نرفضه (G2).
// التطوير/الاختبار لا يتغيّران. أوّل تثبيت على قاعدة فارغة: ALLOW_BARE_PUSH=1 pnpm db:push
import "dotenv/config";
import { execFileSync } from "node:child_process";

if (process.env.NODE_ENV === "production" && process.env.ALLOW_BARE_PUSH !== "1") {
  console.error("⛔ db:push عارٍ محظور في الإنتاج — استعمل بوّابة الهجرة:  pnpm db:backup && pnpm db:migrate:safe");
  console.error("   (لأوّل تثبيت على قاعدة فارغة فقط: ALLOW_BARE_PUSH=1 pnpm db:push)");
  process.exit(1);
}

try {
  execFileSync("pnpm", ["exec", "drizzle-kit", "push", ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} catch {
  process.exit(1);
}
