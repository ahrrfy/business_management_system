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
  it("يقسم الاختبارات إلى ثماني شرائح ويضع MySQL المؤقتة في الذاكرة", () => {
    const testShards = jobBlock("test-shards");

    expect(testShards).toContain("shard: [1, 2, 3, 4, 5, 6, 7, 8]");
    expect(testShards).toContain("total: [8]");
    expect(testShards).toContain(
      "--shard=${{ matrix.shard }}/${{ matrix.total }}",
    );
    expect(testShards).toContain("--tmpfs /var/lib/mysql");
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

  it("يشغّل الجودة والبناء بالتوازي مع شرائح الاختبار", () => {
    const qualityBuild = jobBlock("quality-build");

    expect(qualityBuild).toContain("needs: scope");
    expect(qualityBuild).toContain("pnpm check");
    expect(qualityBuild).toContain("pnpm build");
  });

  it("يبقي الفحص المحمي بوابة تجميع خفيفة لا تعيد العمل", () => {
    const gate = jobBlock("check-test-build");

    expect(gate).toContain("needs: [scope, test-shards, quality-build]");
    expect(gate).toContain("needs.scope.outputs.heavy");
    expect(gate).toContain("needs.test-shards.result");
    expect(gate).toContain("needs.quality-build.result");
    expect(gate).toContain("node scripts/ci-policy.mjs gate");
    expect(gate).not.toContain("actions/checkout");
    expect(gate).not.toContain("pnpm install");
    expect(gate).not.toContain("pnpm build");
  });
});
