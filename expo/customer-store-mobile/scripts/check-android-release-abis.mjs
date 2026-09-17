import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const RELEASE_ANDROID_ABIS = [
  "armeabi-v7a",
  "arm64-v8a",
  "x86",
  "x86_64",
];
export const REQUIRED_REACT_NATIVE_DSOS = [
  "libreactnative.so",
  "libhermes.so",
  "libfbjni.so",
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const require = createRequire(import.meta.url);

function fail(message) {
  throw new Error(`[android-release-abi] ${message}`);
}

function buildPropertiesAndroid(config) {
  const plugin = config.plugins?.find(
    (candidate) =>
      Array.isArray(candidate) && candidate[0] === "expo-build-properties",
  );
  if (!plugin) fail("expo-build-properties is missing from app.config.js");
  return plugin[1]?.android ?? {};
}

export function assertReleaseConfigSupportsAllAbis(config) {
  const configured = buildPropertiesAndroid(config).buildArchs;
  if (configured === undefined) return;
  if (!Array.isArray(configured))
    fail("android.buildArchs must be an array when configured");

  const missing = RELEASE_ANDROID_ABIS.filter(
    (abi) => !configured.includes(abi),
  );
  if (missing.length > 0) {
    fail(
      `android.buildArchs narrows the release and omits ${missing.join(
        ", ",
      )}; omit buildArchs to keep Expo's full release ABI set`,
    );
  }
}

function endOfCentralDirectoryOffset(buffer) {
  const signature = 0x06054b50;
  const firstPossibleOffset = Math.max(0, buffer.length - 65_557);
  for (
    let offset = buffer.length - 22;
    offset >= firstPossibleOffset;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  fail(
    "the artifact is not a readable ZIP/AAB (end-of-central-directory record missing)",
  );
}

export function zipEntryNames(buffer) {
  const eocd = endOfCentralDirectoryOffset(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    fail("ZIP64 AABs are not supported by this lightweight verifier");
  }

  const names = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      fail(`invalid central-directory entry at index ${index}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    names.push(buffer.toString("utf8", nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

export function assertAabHasReactNativeDsos(entryNames) {
  const entries = new Set(entryNames);
  const missing = [];
  for (const abi of RELEASE_ANDROID_ABIS) {
    for (const dso of REQUIRED_REACT_NATIVE_DSOS) {
      const entry = `base/lib/${abi}/${dso}`;
      if (!entries.has(entry)) missing.push(entry);
    }
  }
  if (missing.length > 0) {
    fail(`AAB is missing release DSOs:\n${missing.join("\n")}`);
  }
}

function centralDirectoryFixture(entryNames) {
  const entries = entryNames.map((name) => {
    const encodedName = Buffer.from(name);
    const entry = Buffer.alloc(46 + encodedName.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(encodedName.length, 28);
    encodedName.copy(entry, 46);
    return entry;
  });
  const centralDirectory = Buffer.concat(entries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, eocd]);
}

function runSelfTest() {
  const completeEntries = RELEASE_ANDROID_ABIS.flatMap((abi) =>
    REQUIRED_REACT_NATIVE_DSOS.map((dso) => `base/lib/${abi}/${dso}`),
  );
  const parsed = zipEntryNames(centralDirectoryFixture(completeEntries));
  assertAabHasReactNativeDsos(parsed);

  let caught = false;
  try {
    assertAabHasReactNativeDsos(
      parsed.filter((entry) => !entry.includes("/x86_64/")),
    );
  } catch (error) {
    caught =
      error instanceof Error &&
      error.message.includes("base/lib/x86_64/libreactnative.so");
  }
  if (!caught)
    fail("self-test did not catch a missing x86_64 React Native DSO");
}

function artifactArgument(args) {
  const index = args.indexOf("--aab");
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) fail("--aab requires a path");
  return path.resolve(process.cwd(), value);
}

function main() {
  runSelfTest();
  const appConfig = require(path.join(projectDirectory, "app.config.js"));
  assertReleaseConfigSupportsAllAbis(appConfig);

  const artifact = artifactArgument(process.argv.slice(2));
  if (artifact) {
    assertAabHasReactNativeDsos(zipEntryNames(readFileSync(artifact)));
    console.log(`Android release ABI gate passed for ${artifact}`);
    return;
  }
  console.log(
    `Android release ABI config gate passed: ${RELEASE_ANDROID_ABIS.join(", ")}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
