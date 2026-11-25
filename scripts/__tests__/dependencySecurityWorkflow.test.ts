import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("dependency security coverage", () => {
  it("يفحص Security Audit قفل الجذر بعد إزالة تطبيقات Expo", () => {
    const workflow = read(".github/workflows/security.yml");

    expect(workflow).toContain("pnpm-lock.yaml");
    expect(workflow).not.toContain("expo/customer-store-mobile/pnpm-lock.yaml");
    expect(workflow).not.toContain("expo/superapp-mobile/pnpm-lock.yaml");
    expect(workflow).toContain("--config=osv-scanner.toml");
  });

  it("يبقي فحص الثغرات مركزياً في OSV بلا اعتماد على npm audit المتقاعد", () => {
    const securityWorkflow = read(".github/workflows/security.yml");

    expect(securityWorkflow).toContain("osv-scanner scan");
  });

  it("يثبت الإصدارات العابرة الآمنة ويقصر الاستثناءات غير القابلة للترقية الآمنة", () => {
    const rootPackageJson = JSON.parse(read("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const rootOverrides = rootPackageJson.pnpm?.overrides ?? {};
    expect(rootOverrides["brace-expansion@<5.0.12"]).toBe("5.0.12");
    expect(rootOverrides["fast-uri@<3.1.9"]).toBe("3.1.9");
    expect(rootOverrides["ip-address@<10.7.4"]).toBe("10.7.4");
    expect(rootOverrides["dompurify@<3.4.17"]).toBe("3.4.17");
    expect(rootOverrides["serialize-javascript@<7.1.3"]).toBe("7.1.3");
    expect(rootOverrides["compression@<1.8.2"]).toBe("1.8.2");
    expect(rootOverrides["fast-copy@<4.1.0"]).toBe("4.1.0");
    expect(rootOverrides["postcss-selector-parser@<7.1.6"]).toBe("7.1.6");
    expect(rootOverrides["proxy-addr@<2.0.8"]).toBe("2.0.8");
    expect(rootOverrides["source-map-js@<1.2.2"]).toBe("1.2.2");
    expect(rootOverrides["qs@<6.16.1"]).toBe("6.16.1");
    expect(rootOverrides["glob@>=9.0.0 <14.0.2"]).toBe("14.0.2");
    expect(rootOverrides["minimatch@>=9.0.0 <11.0.1"]).toBe("11.0.1");
    expect(rootOverrides.deepmerge).toBe("npm:@stackline/deepmerge@1.1.0");

    const osvConfig = read("osv-scanner.toml");
    expect(osvConfig).toContain('id = "GHSA-g3hv-75wg-m249"');
    expect(osvConfig).toContain('id = "GHSA-fc5q-39xc-vjpf"');
    expect(osvConfig).toContain("ignoreUntil = 2027-02-28");
    expect(osvConfig.match(/\[\[IgnoredVulns\]\]/g)).toHaveLength(2);
    for (const retiredIgnore of [
      "GHSA-86w9-cpqp-85rv",
      "GHSA-vfj7-8cjw-p6xm",
      "GHSA-hp3w-g68c-fv3c",
      "GHSA-gcqx-w48m-w2h4",
    ]) {
      expect(osvConfig).not.toContain(`id = "${retiredIgnore}"`);
    }
    expect(osvConfig).toContain('reason = "');
  });

  it("مصدر Express يستخدم qs المصححة دون انهيار عند مصفوفة comma بقيمة toString غير قابلة للاستدعاء", () => {
    const appRequire = createRequire(resolve(process.cwd(), "package.json"));
    const expressRequire = createRequire(appRequire.resolve("express"));
    const qs = expressRequire("qs");
    expect(() =>
      qs.stringify(JSON.parse('{"a":[{"toString":"x"}]}'), {
        arrayFormat: "comma",
      }),
    ).not.toThrow();
    expect(() =>
      qs.stringify(JSON.parse('{"a":[{"toString":"x"}]}'), {
        arrayFormat: "comma",
        encodeValuesOnly: true,
      }),
    ).not.toThrow();
  });

  it("يستبدل deepmerge الضعيفة ببديل مصحح ومثبت في قفل الجذر", () => {
    for (const lock of ["pnpm-lock.yaml"]) {
      const lockSource = read(lock).replaceAll("\r\n", "\n");
      expect(lockSource).toContain("@stackline/deepmerge@1.1.0");
      expect(lockSource).toContain(
        "sha512-bEQ1EpXrlu9PTTgKD9z85MWYGjDMv79fF2qn2LYdmukpuj6onkn5kZlRAu0PaZvUv9ZQerwtDVgIEn2LYtsE7w==",
      );
      expect(lockSource).not.toMatch(/^  deepmerge@4\.3\.1:$/m);
      expect(lockSource).not.toMatch(/^      deepmerge: 4\.3\.1$/m);

      const manifest = JSON.parse(
        read(lock.replace("pnpm-lock.yaml", "package.json")),
      );
      expect(manifest.dependencies?.deepmerge).toBeUndefined();
      expect(manifest.pnpm?.overrides?.deepmerge).toBe(
        "npm:@stackline/deepmerge@1.1.0",
      );
    }
  });

  it("يمنع بديل deepmerge تسميم prototype في سلسلة Rollup الفعلية", () => {
    const appRequire = createRequire(resolve(process.cwd(), "package.json"));
    const pwaRequire = createRequire(appRequire.resolve("vite-plugin-pwa"));
    const workboxRequire = createRequire(pwaRequire.resolve("workbox-build"));
    const nodeResolveRequire = createRequire(
      workboxRequire.resolve("@rollup/plugin-node-resolve"),
    );
    const merge = nodeResolveRequire("deepmerge") as (
      target: Record<string, unknown>,
      source: Record<string, unknown>,
    ) => { session: Record<string, unknown> };
    const payload = JSON.parse(
      '{"session":{"__proto__":{"isAdmin":true}}}',
    ) as Record<string, unknown>;
    const result = merge({ session: null }, payload);

    expect(Object.getPrototypeOf(result.session)).toBe(Object.prototype);
    expect(Object.hasOwn(result.session, "isAdmin")).toBe(false);
    expect(result.session.isAdmin).toBeUndefined();
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it("يرقي كل مستهلكي node-forge وglob>=9 وminimatch>=9 ويقصر استثناء minimatch على مستهلكي CJS القدامى", () => {
    const allowedLegacyMinimatchPrefixes = [
      "@eslint/config-array@",
      "@eslint/eslintrc@",
      "eslint@",
      "eslint-plugin-import@",
      "eslint-plugin-react@",
      "filelist@1.0.6",
      "glob@7.2.3",
      "readdir-glob@1.1.3",
      "test-exclude@6.0.0",
    ];
    const isAtLeastSemver = (
      raw: string,
      minMajor: number,
      minMinor: number,
      minPatch: number,
    ) => {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
      if (!m) return false;
      const [, maj, min, pat] = m.map(Number);
      if (maj !== minMajor) return maj > minMajor;
      if (min !== minMinor) return min > minMinor;
      return pat >= minPatch;
    };
    for (const lock of ["pnpm-lock.yaml"]) {
      let parent = "";
      for (const line of read(lock).replaceAll("\r\n", "\n").split("\n")) {
        if (/^  \S/.test(line)) parent = line.trim().replace(/^['"]/, "");
        const nodeForge = /^      node-forge:\s*(.+)$/.exec(line)?.[1]?.trim();
        if (nodeForge) expect(nodeForge).toBe("1.4.3");
        const globVer = /^      glob:\s*(.+)$/.exec(line)?.[1]?.trim();
        if (globVer && !globVer.startsWith("7.")) {
          expect(isAtLeastSemver(globVer, 14, 0, 2)).toBe(true);
        }
        const mmVer = /^      minimatch:\s*(.+)$/.exec(line)?.[1]?.trim();
        if (mmVer && !isAtLeastSemver(mmVer, 11, 0, 1)) {
          expect(["3.1.5", "5.1.9"]).toContain(mmVer);
          expect(
            allowedLegacyMinimatchPrefixes.some((p) => parent.startsWith(p)),
          ).toBe(true);
        }
      }
      const manifest = JSON.parse(
        read(lock.replace("pnpm-lock.yaml", "package.json")),
      );
      expect(manifest.dependencies?.minimatch).toBeUndefined();
    }
  });

  it("يفتح Dependabot تحديثات أسبوعية للجذر وحده بعد إزالة تطبيقات Expo", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot.match(/package-ecosystem: npm/g)).toHaveLength(1);
    expect(dependabot).toContain('directory: "/"');
    expect(dependabot).not.toContain("/expo/superapp-mobile");
    expect(dependabot).not.toContain("/expo/customer-store-mobile");
    expect(dependabot.match(/interval: weekly/g)).toHaveLength(1);
    expect(dependabot.match(/safe-non-major-updates:/g)).toHaveLength(1);
    expect(dependabot.match(/- minor\s+- patch/g)).toHaveLength(1);
    expect(dependabot.match(/dependency-name: "\*"/g)).toHaveLength(1);
    expect(dependabot.match(/"version-update:semver-major"/g)).toHaveLength(1);
  });
});
