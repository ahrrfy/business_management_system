import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  if (!Array.isArray(configured)) {
    fail("android.buildArchs must be an array when configured");
  }

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
    fail("ZIP64 AABs are not supported by this verifier");
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
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nameEnd > buffer.length || nextOffset > buffer.length) {
      fail(`truncated central-directory entry at index ${index}`);
    }

    names.push(buffer.toString("utf8", nameStart, nameEnd));
    offset = nextOffset;
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

export function findAabArtifacts(rootDirectory) {
  if (!existsSync(rootDirectory)) return [];

  const artifacts = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".aab")) {
        artifacts.push(entryPath);
      }
    }
  };

  visit(rootDirectory);
  return artifacts.sort();
}

export function easBuildRequiresAabVerification(easConfig, env) {
  if (env.EAS_BUILD !== "true" || env.EAS_BUILD_PLATFORM !== "android") {
    return false;
  }

  const profileName = env.EAS_BUILD_PROFILE;
  if (!profileName)
    fail("EAS_BUILD_PROFILE is missing on an Android EAS build");

  const seenProfiles = new Set();
  let currentProfileName = profileName;
  const profileChain = [];
  while (currentProfileName) {
    if (seenProfiles.has(currentProfileName)) {
      fail(
        `EAS build profile inheritance contains a cycle at '${currentProfileName}'`,
      );
    }
    seenProfiles.add(currentProfileName);

    const profile = easConfig.build?.[currentProfileName];
    if (!profile) {
      fail(
        `EAS build profile '${currentProfileName}' is missing from eas.json`,
      );
    }
    profileChain.push(profile);

    if (profile.extends !== undefined && typeof profile.extends !== "string") {
      fail(
        `EAS build profile '${currentProfileName}' has an invalid extends value`,
      );
    }
    currentProfileName = profile.extends;
  }

  const resolvedProfile = profileChain.reverse().reduce(
    (resolved, profile) => {
      const { android, extends: _extends, ...common } = profile;
      return {
        ...resolved,
        ...common,
        android: { ...resolved.android, ...android },
      };
    },
    { android: {} },
  );
  const {
    applicationArchivePath,
    buildType,
    gradleCommand,
    distribution: androidDistribution,
    developmentClient: androidDevelopmentClient,
  } = resolvedProfile.android;
  const distribution = androidDistribution ?? resolvedProfile.distribution;
  const developmentClient =
    androidDevelopmentClient ?? resolvedProfile.developmentClient;

  let buildsAab;
  if (gradleCommand !== undefined) {
    if (typeof gradleCommand !== "string") {
      fail(`EAS build profile '${profileName}' has an invalid gradleCommand`);
    }
    const tasks = gradleCommand
      .split(/\s+/)
      .filter((token) => token && !token.startsWith("-"))
      .map((token) => token.split(":").at(-1)?.toLowerCase() ?? "");
    buildsAab = tasks.some((task) => task.startsWith("bundle"));
    const buildsApk = tasks.some((task) => task.startsWith("assemble"));
    if (buildsAab === buildsApk) {
      fail(
        `cannot determine the Android artifact type from gradleCommand '${gradleCommand}'`,
      );
    }
  } else if (developmentClient === true) {
    buildsAab = false;
  } else if (buildType !== undefined) {
    buildsAab = buildType === "app-bundle";
  } else {
    buildsAab = distribution !== "internal" && developmentClient !== true;
  }

  if (buildsAab && applicationArchivePath !== undefined) {
    fail(
      `EAS build profile '${profileName}' uses android.applicationArchivePath, which this AAB verifier does not support`,
    );
  }
  return buildsAab;
}

function verifyAab(artifact) {
  assertAabHasReactNativeDsos(zipEntryNames(readFileSync(artifact)));
  console.log(`Android release ABI artifact gate passed: ${artifact}`);
}

function artifactArgument(args) {
  const index = args.indexOf("--aab");
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail("--aab requires a path");
  return path.resolve(process.cwd(), value);
}

function assertKnownArguments(args) {
  const known = new Set(["--aab", "--eas-on-success"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!known.has(argument)) fail(`unknown argument: ${argument}`);
    if (argument === "--aab") index += 1;
  }
  if (args.includes("--aab") && args.includes("--eas-on-success")) {
    fail("use either --aab or --eas-on-success, not both");
  }
}

export function verifyEasAabOnSuccess(
  easConfig,
  {
    env = process.env,
    outputDirectory = path.join(
      projectDirectory,
      "android",
      "app",
      "build",
      "outputs",
    ),
  } = {},
) {
  if (!easBuildRequiresAabVerification(easConfig, env)) {
    console.log("Android AAB artifact gate skipped for this EAS build profile");
    return;
  }

  const artifacts = findAabArtifacts(outputDirectory);
  if (artifacts.length === 0) {
    fail(`no AAB found below ${outputDirectory}`);
  }
  for (const artifact of artifacts) verifyAab(artifact);
}

function main() {
  const args = process.argv.slice(2);
  assertKnownArguments(args);

  const appConfig = require(path.join(projectDirectory, "app.config.js"));
  assertReleaseConfigSupportsAllAbis(appConfig);

  const easConfig = JSON.parse(
    readFileSync(path.join(projectDirectory, "eas.json"), "utf8"),
  );
  if (args.includes("--eas-on-success")) {
    verifyEasAabOnSuccess(easConfig);
    return;
  }

  const artifact = artifactArgument(args);
  if (artifact) {
    verifyAab(artifact);
    return;
  }
  if (process.env.EAS_BUILD === "true") {
    easBuildRequiresAabVerification(easConfig, process.env);
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
