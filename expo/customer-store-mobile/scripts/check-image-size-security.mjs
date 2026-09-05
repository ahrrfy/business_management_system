import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const expectedVersion = "1.2.1";
const advisoryIds = new Set([
  "CVE-2025-71329",
  "CVE-2025-71330",
  "GHSA-5p2g-fcmc-qvqq",
  "GHSA-w3rx-r6r6-pgpr",
]);

function fail(message) {
  console.error(`[image-size security] ${message}`);
  process.exitCode = 1;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

const packageJsonPath = require.resolve("image-size/package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (packageJson.version !== expectedVersion) {
  fail(
    `Metro resolved image-size@${packageJson.version}; review the patch target and the upstream advisories.`,
  );
} else {
  const imageSizeEntry = require.resolve("image-size");
  const regressionProgram = String.raw`
const imageSizeModule = require(${JSON.stringify(imageSizeEntry)});
const imageSize = imageSizeModule.imageSize || imageSizeModule.default || imageSizeModule;

const maliciousInputs = [
  // CVE-2025-71330: ICNS entry whose length is zero.
  Buffer.from([0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10, 0x69, 0x73, 0x33, 0x32, 0x00, 0x00, 0x00, 0x00]),
  // CVE-2025-71329: valid JXL container prefix followed by a zero-sized jxlp box.
  Buffer.from([
    0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x6a, 0x78, 0x6c, 0x20,
    0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x20,
    0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x70,
  ]),
];

for (const input of maliciousInputs) {
  try {
    imageSize(input);
  } catch {
    // Rejection is expected; termination is the security property under test.
  }
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const dimensions = imageSize(png);
if (dimensions.width !== 1 || dimensions.height !== 1) {
  throw new Error("normal PNG parsing regressed");
}
`;

  const regression = spawnSync(process.execPath, ["-e", regressionProgram], {
    encoding: "utf8",
    timeout: 2_000,
  });

  if (regression.error?.code === "ETIMEDOUT") {
    fail(
      "crafted input hung the parser; the local DoS patch is missing or ineffective.",
    );
  } else if (regression.status !== 0) {
    fail(
      `parser regression check failed: ${regression.stderr || regression.error?.message || "unknown error"}`,
    );
  } else {
    console.log("[image-size security] local DoS mitigation passed.");
  }
}

if (process.argv.includes("--check-upstream")) {
  const [registryResponse, metroResponse] = await Promise.all([
    fetch("https://registry.npmjs.org/image-size", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }),
    fetch("https://registry.npmjs.org/metro/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }),
  ]);
  if (!registryResponse.ok || !metroResponse.ok) {
    throw new Error(
      `npm registry returned image-size=${registryResponse.status}, metro=${metroResponse.status}`,
    );
  }

  const [metadata, latestMetro] = await Promise.all([
    registryResponse.json(),
    metroResponse.json(),
  ]);
  const candidateVersions = Object.keys(metadata.versions ?? {})
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .filter((version) => compareVersions(version, expectedVersion) > 0)
    .sort(compareVersions);

  const osvResponse = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: candidateVersions.map((version) => ({
        package: { ecosystem: "npm", name: "image-size" },
        version,
      })),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!osvResponse.ok) {
    throw new Error(`OSV query returned HTTP ${osvResponse.status}`);
  }

  const osv = await osvResponse.json();
  const fixedCandidates = candidateVersions.filter((version, index) => {
    const vulnerabilities = osv.results?.[index]?.vulns ?? [];
    return !vulnerabilities.some((vulnerability) =>
      [vulnerability.id, ...(vulnerability.aliases ?? [])].some((id) =>
        advisoryIds.has(id),
      ),
    );
  });

  if (fixedCandidates.length > 0) {
    fail(
      `official image-size ${fixedCandidates.at(-1)} is not affected by the tracked advisories; evaluate it and remove the local patch.`,
    );
  } else {
    console.log(
      "[image-size security] no newer official release is fixed for both tracked advisories.",
    );
  }

  if (!latestMetro.dependencies?.["image-size"]) {
    fail(
      `Metro ${latestMetro.version} no longer depends on image-size; evaluate the compatible Expo/Metro upgrade and remove the patch.`,
    );
  }
}
