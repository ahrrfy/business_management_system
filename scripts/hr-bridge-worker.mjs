#!/usr/bin/env node

/**
 * Bootstrap إنتاجي صغير لجسر الحضور.
 *
 * يبدأ الـwatchdog قبل تحميل الحزمة كي يغطي تعليق الاستيراد غير المتزامن، ثم يحمّل
 * JavaScript مبنياً مسبقاً. التعليق المتزامن يمسكه verifier الخارجي (PM2+TCP).
 * لا يُشغَّل TypeScript أو tsx داخل عملية الإنتاج.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import process from "node:process";
import policy from "./hr-bridge-runtime-policy.cjs";

const bootId = randomUUID();
const bootStartedAt = Date.now();
const preflightOnly = process.argv.includes("--preflight");

function checkpoint(phase, details = {}) {
  process.stdout.write(
    `${JSON.stringify({
      phase,
      bootId,
      pid: process.pid,
      elapsedMs: Date.now() - bootStartedAt,
      ...details,
    })}\n`,
  );
}

checkpoint("HR_BRIDGE_BOOT", { mode: preflightOnly ? "preflight" : "runtime" });

// يجب أن يبقى referenced كي يقتل import/startup غير المتزامن إذا لم يكتمل.
const startupWatchdog = setTimeout(() => {
  checkpoint("HR_BRIDGE_STARTUP_TIMEOUT", {
    timeoutMs: policy.startupTimeoutMs,
  });
  process.exit(1);
}, policy.startupTimeoutMs);

try {
  const { runHrBridgeWorker } = await import("../dist/hr-bridge-worker.js");
  checkpoint("HR_BRIDGE_MODULES_LOADED");

  const result = await runHrBridgeWorker({
    bootId,
    preflightOnly,
    databaseTimeoutMs: policy.databaseReadinessTimeoutMs,
    listenTimeoutMs: policy.tcpListenTimeoutMs,
    shutdownTimeoutMs: policy.shutdownTimeoutMs,
    onReady: () => {
      if (typeof process.send === "function") process.send("ready");
      checkpoint("HR_BRIDGE_READY_SENT");
    },
  });

  clearTimeout(startupWatchdog);
  if (result !== "running") process.exit(0);
} catch (error) {
  clearTimeout(startupWatchdog);
  checkpoint("HR_BRIDGE_STARTUP_FAILED", {
    error: error instanceof Error ? error.message : String(error),
  });
  // الخروج القسري مقصود: قد تكون عملية DB المعلّقة ما زالت تمسك event loop.
  process.exit(1);
}
