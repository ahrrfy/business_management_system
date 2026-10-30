import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);
const policy = readFileSync(
  resolve(process.cwd(), "scripts/ci-policy.mjs"),
  "utf8",
);

function jobBlock(name: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);

  const remainder = workflow.slice(start + `  ${name}:`.length);
  const nextJobOffset = remainder.search(/^  [a-z][a-z0-9-]*:\r?$/m);
  return workflow.slice(
    start,
    nextJobOffset === -1
      ? workflow.length
      : start + `  ${name}:`.length + nextJobOffset,
  );
}

describe("CI critical-path policy", () => {
  it("يقسم الاختبارات إلى ثماني شرائح ويضع MySQL المؤقتة في الذاكرة ويُقصي الاختبارات الوحدوية المكرّرة", () => {
    const testShards = jobBlock("test-shards");

    expect(testShards).toContain("shard: [1, 2, 3, 4, 5, 6, 7, 8]");
    expect(testShards).toContain("total: [8]");
    expect(testShards).toContain('VITEST_EXCLUDE_UNIT: "1"');
    expect(testShards).toContain(
      "--shard=${{ matrix.shard }}/${{ matrix.total }}",
    );
    expect(testShards).toContain("--tmpfs /var/lib/mysql");
    // TCP cannot reach MySQL's temporary --skip-networking init server. The
    // first successful authenticated final-server probe disables its scheduler;
    // subsequent probes must not race the strict all-foreground session census.
    expect(testShards).toContain(
      '--health-cmd="mysql --protocol=TCP -h 127.0.0.1 -uroot -e \'SET GLOBAL event_scheduler=OFF; SELECT 1\'"',
    );
    expect(testShards).toContain("--health-start-interval=1s");
    expect(testShards).toContain("--health-start-period=90s");
    expect(testShards).toContain("--health-retries=10");
    const jobMinutes = Number(testShards.match(/timeout-minutes: (\d+)/)?.[1]);
    const healthHours = Number(testShards.match(/--health-interval=(\d+)h/)?.[1]);
    expect(jobMinutes).toBeGreaterThan(0);
    expect(healthHours * 60).toBeGreaterThan(jobMinutes);
    expect(testShards).not.toContain("mysqladmin ping");
  });

  it("يتجاوز العمل الثقيل فقط عند اقتصار PR على التوثيق", () => {
    const scope = jobBlock("scope");
    const testShards = jobBlock("test-shards");
    const qualityBuild = jobBlock("quality-build");

    expect(scope).toContain("heavy:");
    expect(scope).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(scope).toContain("node scripts/ci-policy.mjs scope");
    expect(testShards).toContain("needs: scope");
    expect(testShards).toContain("needs.scope.outputs.heavy == 'true'");
    expect(qualityBuild).toContain("needs: scope");
    expect(qualityBuild).toContain("needs.scope.outputs.heavy == 'true'");
  });

  it("ينفّذ حالات النطاق والبوابة الإيجابية والسلبية", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "scripts/ci-policy.mjs"), "--selftest"],
      { encoding: "utf8" },
    );

    expect(output).toContain("ci-policy selftest: OK");
    expect(policy).toContain('"--no-renames"');
    expect(policy).toContain('"-z"');
    expect(policy).toContain('"--diff-filter=ACDMRT"');
  });

  it("يشغّل الجودة والبناء والحزمة الوحدوية الحاجبة بالتوازي مع شرائح الاختبار", () => {
    const qualityBuild = jobBlock("quality-build");

    expect(qualityBuild).toContain("needs: scope");
    expect(qualityBuild).toContain("pnpm check");
    expect(qualityBuild).toContain("pnpm build");
    expect(qualityBuild).toContain(
      "pnpm exec cross-env TZ=UTC vitest run --config vitest.unit.config.ts",
    );
    const unitStepMatch = qualityBuild.match(
      /- name: الحزمة الوحدوية الكاملة[\s\S]*?(?=\r?\n\s*- name:)/,
    );
    expect(unitStepMatch).not.toBeNull();
    expect(unitStepMatch![0]).not.toContain("continue-on-error: true");
  });

  it("يبقي الفحص المحمي بوابة تجميع خفيفة لا تعيد العمل", () => {
    const gate = jobBlock("check-test-build");

    expect(gate).toContain("needs: [scope, test-shards, quality-build, backup-safety]");
    expect(gate).toContain("needs.backup-safety.result");
    expect(gate).toContain("needs.scope.outputs.heavy");
    expect(gate).toContain("needs.test-shards.result");
    expect(gate).toContain("needs.quality-build.result");
    expect(gate).toContain("node scripts/ci-policy.mjs gate");
    expect(gate).toContain("actions/checkout");
    expect(gate).not.toContain("pnpm install");
    expect(gate).not.toContain("pnpm build");
  });

  it("يشغّل البوابات الإلزامية (check-test-build وauthz-guard وaudit) على التزامات merge_group في طابور الدمج", () => {
    const securityWorkflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/security.yml"),
      "utf8",
    );
    const scope = jobBlock("scope");
    const authzGuard = jobBlock("authz-guard");

    expect(workflow).toMatch(/merge_group:\r?\n\s+branches:\s*\[main\]/);
    expect(securityWorkflow).toMatch(
      /merge_group:\r?\n\s+branches:\s*\[main\]/,
    );
    expect(scope).toContain("github.event.merge_group.base_sha");
    expect(scope).toContain("github.event.merge_group.head_sha");
    expect(authzGuard).toContain("github.event.merge_group.base_sha");
  });
});
