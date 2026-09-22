import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELEASE_ANDROID_ABIS,
  REQUIRED_REACT_NATIVE_DSOS,
  assertAabHasReactNativeDsos,
  assertReleaseConfigSupportsAllAbis,
  easBuildRequiresAabVerification,
  findAabArtifacts,
  verifyEasAabOnSuccess,
  zipEntryNames,
} from "./check-android-release-abis.mjs";

function configWithBuildArchs(buildArchs) {
  const android = { minSdkVersion: 26 };
  if (buildArchs !== undefined) android.buildArchs = buildArchs;
  return {
    plugins: [["expo-build-properties", { android }]],
  };
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

const completeDsoEntries = RELEASE_ANDROID_ABIS.flatMap((abi) =>
  REQUIRED_REACT_NATIVE_DSOS.map((dso) => `base/lib/${abi}/${dso}`),
);

test("keeps Expo's complete default ABI set when buildArchs is omitted", () => {
  assert.doesNotThrow(() =>
    assertReleaseConfigSupportsAllAbis(configWithBuildArchs(undefined)),
  );
});

test("rejects a release configuration that omits x86 ABIs", () => {
  assert.throws(
    () =>
      assertReleaseConfigSupportsAllAbis(
        configWithBuildArchs(["arm64-v8a", "armeabi-v7a"]),
      ),
    /omits x86, x86_64/,
  );
});

test("reads and accepts a complete AAB central directory", () => {
  const entries = zipEntryNames(centralDirectoryFixture(completeDsoEntries));
  assert.deepEqual(entries, completeDsoEntries);
  assert.doesNotThrow(() => assertAabHasReactNativeDsos(entries));
});

test("rejects malformed or unsupported AAB central directories", () => {
  assert.throws(() => zipEntryNames(Buffer.alloc(0)), /record missing/);

  const zip64 = centralDirectoryFixture([]);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(() => zipEntryNames(zip64), /ZIP64/);

  const invalidSignature = centralDirectoryFixture([completeDsoEntries[0]]);
  invalidSignature.writeUInt32LE(0, 0);
  assert.throws(
    () => zipEntryNames(invalidSignature),
    /invalid central-directory entry/,
  );

  const truncatedEntry = centralDirectoryFixture([completeDsoEntries[0]]);
  truncatedEntry.writeUInt16LE(0xffff, 28);
  assert.throws(
    () => zipEntryNames(truncatedEntry),
    /truncated central-directory entry/,
  );
});

test("rejects an AAB without x86_64 React Native DSOs", () => {
  assert.throws(
    () =>
      assertAabHasReactNativeDsos(
        completeDsoEntries.filter((entry) => !entry.includes("/x86_64/")),
      ),
    /base\/lib\/x86_64\/libreactnative\.so/,
  );
});

test("requires artifact verification only for Android app-bundle profiles", () => {
  const easConfig = {
    build: {
      "play-internal": {
        distribution: "store",
        android: { buildType: "app-bundle" },
      },
      "qa-apk": {
        distribution: "internal",
        android: { buildType: "apk" },
      },
    },
  };

  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      EAS_BUILD: "true",
      EAS_BUILD_PLATFORM: "android",
      EAS_BUILD_PROFILE: "play-internal",
    }),
    true,
  );
  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      EAS_BUILD: "true",
      EAS_BUILD_PLATFORM: "android",
      EAS_BUILD_PROFILE: "qa-apk",
    }),
    false,
  );
  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      EAS_BUILD: "true",
      EAS_BUILD_PLATFORM: "ios",
      EAS_BUILD_PROFILE: "play-internal",
    }),
    false,
  );
});

test("honors Android-scoped EAS profile properties", () => {
  const easConfig = {
    build: {
      "android-internal": {
        distribution: "store",
        android: { distribution: "internal" },
      },
      "android-development": {
        android: { developmentClient: true },
      },
    },
  };
  const env = {
    EAS_BUILD: "true",
    EAS_BUILD_PLATFORM: "android",
  };

  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "android-internal",
    }),
    false,
  );
  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "android-development",
    }),
    false,
  );
});

test("applies platform precedence after resolving EAS profile inheritance", () => {
  const easConfig = {
    build: {
      "base-android-internal": {
        android: { distribution: "internal" },
      },
      "child-global-store": {
        extends: "base-android-internal",
        distribution: "store",
      },
      "base-global-internal": {
        distribution: "internal",
      },
      "child-android-store": {
        extends: "base-global-internal",
        android: { distribution: "store" },
      },
    },
  };
  const env = {
    EAS_BUILD: "true",
    EAS_BUILD_PLATFORM: "android",
  };

  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "child-global-store",
    }),
    false,
  );
  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "child-android-store",
    }),
    true,
  );
});

test("treats a development client as APK even when buildType says AAB", () => {
  assert.equal(
    easBuildRequiresAabVerification(
      {
        build: {
          development: {
            developmentClient: true,
            android: { buildType: "app-bundle" },
          },
        },
      },
      {
        EAS_BUILD: "true",
        EAS_BUILD_PLATFORM: "android",
        EAS_BUILD_PROFILE: "development",
      },
    ),
    false,
  );
});

test("rejects an unsupported custom AAB archive path before the build", () => {
  assert.throws(
    () =>
      easBuildRequiresAabVerification(
        {
          build: {
            custom: {
              distribution: "store",
              android: {
                buildType: "app-bundle",
                applicationArchivePath: "artifacts/*.aab",
              },
            },
          },
        },
        {
          EAS_BUILD: "true",
          EAS_BUILD_PLATFORM: "android",
          EAS_BUILD_PROFILE: "custom",
        },
      ),
    /applicationArchivePath, which this AAB verifier does not support/,
  );
});

test("resolves inherited EAS build profile settings", () => {
  const easConfig = {
    build: {
      "base-apk": {
        distribution: "internal",
        android: { buildType: "apk" },
      },
      "inherited-apk": { extends: "base-apk" },
      "base-aab": {
        distribution: "store",
        android: { buildType: "app-bundle" },
      },
      "inherited-aab": { extends: "base-aab" },
    },
  };
  const env = {
    EAS_BUILD: "true",
    EAS_BUILD_PLATFORM: "android",
  };

  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "inherited-apk",
    }),
    false,
  );
  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "inherited-aab",
    }),
    true,
  );
});

test("honors Gradle commands that override the EAS build type", () => {
  const easConfig = {
    build: {
      "base-aab": {
        distribution: "store",
        android: { buildType: "app-bundle" },
      },
      "custom-apk": {
        extends: "base-aab",
        android: { gradleCommand: ":app:assembleRelease" },
      },
      "custom-aab": {
        distribution: "internal",
        developmentClient: true,
        android: {
          buildType: "apk",
          gradleCommand: ":app:bundleRelease --stacktrace",
        },
      },
    },
  };
  const env = {
    EAS_BUILD: "true",
    EAS_BUILD_PLATFORM: "android",
  };

  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "custom-apk",
    }),
    false,
  );
  assert.equal(
    easBuildRequiresAabVerification(easConfig, {
      ...env,
      EAS_BUILD_PROFILE: "custom-aab",
    }),
    true,
  );
});

test("rejects an ambiguous custom Gradle command", () => {
  assert.throws(
    () =>
      easBuildRequiresAabVerification(
        {
          build: {
            custom: {
              android: { gradleCommand: ":app:clean :app:build" },
            },
          },
        },
        {
          EAS_BUILD: "true",
          EAS_BUILD_PLATFORM: "android",
          EAS_BUILD_PROFILE: "custom",
        },
      ),
    /cannot determine the Android artifact type/,
  );
});

test("rejects cyclic EAS build profile inheritance", () => {
  assert.throws(
    () =>
      easBuildRequiresAabVerification(
        {
          build: {
            first: { extends: "second" },
            second: { extends: "first" },
          },
        },
        {
          EAS_BUILD: "true",
          EAS_BUILD_PLATFORM: "android",
          EAS_BUILD_PROFILE: "first",
        },
      ),
    /inheritance contains a cycle/,
  );
});

test("discovers the generated AAB below Gradle outputs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "android-aab-gate-"));
  try {
    const artifact = path.join(root, "bundle", "release", "app-release.aab");
    mkdirSync(path.dirname(artifact), { recursive: true });
    writeFileSync(artifact, centralDirectoryFixture(completeDsoEntries));
    assert.deepEqual(findAabArtifacts(root), [artifact]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when an Android store build produces no AAB", () => {
  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), "android-aab-empty-"),
  );
  try {
    assert.throws(
      () =>
        verifyEasAabOnSuccess(
          {
            build: {
              "play-internal": {
                distribution: "store",
                android: { buildType: "app-bundle" },
              },
            },
          },
          {
            env: {
              EAS_BUILD: "true",
              EAS_BUILD_PLATFORM: "android",
              EAS_BUILD_PROFILE: "play-internal",
            },
            outputDirectory,
          },
        ),
      /no AAB found/,
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("verifies the generated AAB for an Android store build", () => {
  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), "android-aab-complete-"),
  );
  try {
    const artifact = path.join(
      outputDirectory,
      "bundle",
      "release",
      "app-release.aab",
    );
    mkdirSync(path.dirname(artifact), { recursive: true });
    writeFileSync(artifact, centralDirectoryFixture(completeDsoEntries));

    assert.doesNotThrow(() =>
      verifyEasAabOnSuccess(
        {
          build: {
            "play-internal": {
              distribution: "store",
              android: { buildType: "app-bundle" },
            },
          },
        },
        {
          env: {
            EAS_BUILD: "true",
            EAS_BUILD_PLATFORM: "android",
            EAS_BUILD_PROFILE: "play-internal",
          },
          outputDirectory,
        },
      ),
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("skips AAB verification for APK and iOS builds", () => {
  const easConfig = {
    build: {
      "qa-apk": {
        distribution: "internal",
        android: { buildType: "apk" },
      },
      "play-internal": {
        distribution: "store",
        android: { buildType: "app-bundle" },
      },
    },
  };
  const missingOutputDirectory = path.join(
    tmpdir(),
    "android-aab-output-does-not-exist",
  );

  assert.doesNotThrow(() =>
    verifyEasAabOnSuccess(easConfig, {
      env: {
        EAS_BUILD: "true",
        EAS_BUILD_PLATFORM: "android",
        EAS_BUILD_PROFILE: "qa-apk",
      },
      outputDirectory: missingOutputDirectory,
    }),
  );
  assert.doesNotThrow(() =>
    verifyEasAabOnSuccess(easConfig, {
      env: {
        EAS_BUILD: "true",
        EAS_BUILD_PLATFORM: "ios",
        EAS_BUILD_PROFILE: "play-internal",
      },
      outputDirectory: missingOutputDirectory,
    }),
  );
});
