// حارس حاوية القاعدة: يتأكّد أنّ erp-mysql تعمل، ويعيد تشغيلها إن سقطت.
// السبب: Docker Desktop ينهار أحياناً بعلّة AI Inference manager (CLAUDE.md §٣) ⇒ تتوقّف القاعدة
// والمتجر يقف. مهمة مجدولة كل ساعة تشغّل هذا فتعود الحاوية تلقائياً.
//
// الاستخدام: node scripts/docker-watchdog.mjs   (تُجدوَل عبر Task Scheduler — راجع scheduled-backup.xml)
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const container = process.env.DB_CONTAINER ?? "erp-mysql";
const logDir = process.env.LOG_DIR ?? "logs";
const stamp = new Date().toISOString();

function log(line) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "docker-watchdog.log"), `${stamp} ${line}\n`);
  } catch {
    /* تجاهل */
  }
  console.log(line);
}

function dockerOut(args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

try {
  // هل الحاوية تعمل؟
  const running = dockerOut(["ps", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"]);
  if (running === container) {
    log(`✓ ${container} تعمل.`);
    process.exit(0);
  }

  // موجودة لكن متوقّفة؟ شغّلها. غير موجودة؟ ارفعها عبر compose.
  const exists = dockerOut(["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"]);
  if (exists === container) {
    log(`⚠ ${container} متوقّفة — إعادة تشغيل…`);
    execFileSync("docker", ["start", container], { stdio: "inherit" });
    log(`✓ أُعيد تشغيل ${container}.`);
  } else {
    log(`⚠ ${container} غير موجودة — رفع عبر docker compose…`);
    execFileSync("docker", ["compose", "up", "-d", "mysql"], { stdio: "inherit" });
    log(`✓ رُفعت ${container} عبر compose.`);
  }
} catch (e) {
  log(`✗ فشل الحارس: ${e?.message ?? e} — قد يكون Docker Desktop نفسه متوقّفاً (تدخّل يدوي).`);
  process.exit(1);
}
