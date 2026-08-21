"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RELEASE_MANIFEST_VERSION = 2;
const RELEASE_STATE_VERSION = 2;
const RELEASE_ID = /^[a-f0-9]{64}$/;
const RELEASE_MODES = new Set(["enabled", "disabled"]);
const RELEASE_FILES = Object.freeze({
  bootstrap: "hr-bridge-worker.mjs",
  policy: "hr-bridge-runtime-policy.cjs",
  mode: "hr-bridge-mode.cjs",
  pm2App: "hr-bridge-pm2-app.cjs",
  pm2Config: "hr-bridge-pm2.config.cjs",
  artifact: "hr-bridge-worker.cjs",
  environment: "hr-bridge-environment.json",
});

function runtimeRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), ".runtime", "hr-bridge");
}

function releasesRoot(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "releases");
}

function statePath(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "state.json");
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fsyncFile(file) {
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertSafeDirectory(directory, code) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(code);
}

function releaseIdFor(hashes) {
  const stable = Object.keys(RELEASE_FILES)
    .sort()
    .map((key) => `${key}:${hashes[key]}`)
    .join("\n");
  return crypto.createHash("sha256").update(stable).digest("hex");
}

function canonicalEnvironmentBytes(policy, deploymentEnvironment) {
  if (
    !policy ||
    !Array.isArray(policy.allowedEnvironmentKeys) ||
    deploymentEnvironment == null ||
    typeof deploymentEnvironment !== "object" ||
    Array.isArray(deploymentEnvironment)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  }
  const allowed = [...policy.allowedEnvironmentKeys].sort();
  const values = {};
  for (const key of allowed) {
    if (!Object.hasOwn(deploymentEnvironment, key)) continue;
    const value = deploymentEnvironment[key];
    if (typeof value !== "string") {
      throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
    }
    values[key] = value;
  }
  values.NODE_ENV = "production";
  values.TZ = "UTC";
  values.HR_BRIDGE_LOAD_DOTENV = "0";
  const sortedValues = Object.fromEntries(
    Object.entries(values).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return `${JSON.stringify({ version: 1, values: sortedValues })}\n`;
}

function parseCanonicalEnvironment(file, policy) {
  assertRegularFile(file, "HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  if (
    process.platform !== "win32" &&
    (fs.statSync(file).mode & 0o777) !== 0o600
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_PERMISSIONS_INVALID");
  }
  const raw = fs.readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  }
  if (
    parsed?.version !== 1 ||
    parsed?.values == null ||
    typeof parsed.values !== "object" ||
    Array.isArray(parsed.values)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  }
  const allowed = new Set(policy.allowedEnvironmentKeys);
  if (
    Object.entries(parsed.values).some(
      ([key, value]) => !allowed.has(key) || typeof value !== "string",
    ) ||
    parsed.values.NODE_ENV !== "production" ||
    parsed.values.TZ !== "UTC" ||
    parsed.values.HR_BRIDGE_LOAD_DOTENV !== "0" ||
    raw !== canonicalEnvironmentBytes(policy, parsed.values)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_ENVIRONMENT_INVALID");
  }
  return Object.freeze({ ...parsed.values });
}

function assertReleaseId(id) {
  if (typeof id !== "string" || !RELEASE_ID.test(id)) {
    throw new Error("HR_BRIDGE_RELEASE_ID_INVALID");
  }
}

function assertRegularFile(file, code) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
}

function releaseDirectory(projectRoot, id) {
  assertReleaseId(id);
  return path.join(releasesRoot(projectRoot), id);
}

function validateRelease(projectRoot, id) {
  const directory = releaseDirectory(projectRoot, id);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("HR_BRIDGE_RELEASE_DIRECTORY_INVALID");
  }
  if (
    process.platform !== "win32" &&
    (directoryStat.mode & 0o777) !== 0o700
  ) {
    throw new Error("HR_BRIDGE_RELEASE_DIRECTORY_PERMISSIONS_INVALID");
  }

  const manifestPath = path.join(directory, "hr-bridge-release.json");
  assertRegularFile(manifestPath, "HR_BRIDGE_RELEASE_MANIFEST_INVALID");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("HR_BRIDGE_RELEASE_MANIFEST_INVALID");
  }
  if (
    manifest?.version !== RELEASE_MANIFEST_VERSION ||
    manifest?.id !== id ||
    manifest?.files == null ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(["createdAt", "files", "id", "sourceCommit", "version"]) ||
    JSON.stringify(Object.keys(manifest.files).sort()) !==
      JSON.stringify(Object.keys(RELEASE_FILES).sort()) ||
    (manifest.sourceCommit !== null &&
      (typeof manifest.sourceCommit !== "string" ||
        !/^[a-f0-9]{40}$/.test(manifest.sourceCommit))) ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    throw new Error("HR_BRIDGE_RELEASE_MANIFEST_INVALID");
  }

  const expectedEntries = [
    ...Object.values(RELEASE_FILES),
    "hr-bridge-release.json",
  ].sort();
  const actualEntries = fs.readdirSync(directory).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("HR_BRIDGE_RELEASE_CONTENTS_INVALID");
  }

  const paths = {};
  const hashes = {};
  for (const [key, name] of Object.entries(RELEASE_FILES)) {
    const file = path.join(directory, name);
    assertRegularFile(file, "HR_BRIDGE_RELEASE_FILE_INVALID");
    const hash = hashFile(file);
    if (manifest.files[key] !== hash) {
      throw new Error("HR_BRIDGE_RELEASE_HASH_MISMATCH");
    }
    paths[key] = file;
    hashes[key] = hash;
  }
  if (releaseIdFor(hashes) !== id) {
    throw new Error("HR_BRIDGE_RELEASE_ID_MISMATCH");
  }
  const policy = require(paths.policy);
  const environment = parseCanonicalEnvironment(paths.environment, policy);
  const { deriveHrBridgeMode } = require(paths.mode);
  const mode = deriveHrBridgeMode(environment).mode;
  return Object.freeze({
    id,
    directory,
    manifestPath,
    bootstrapPath: paths.bootstrap,
    policyPath: paths.policy,
    modePath: paths.mode,
    pm2AppPath: paths.pm2App,
    pm2ConfigPath: paths.pm2Config,
    artifactPath: paths.artifact,
    environmentPath: paths.environment,
    environmentHash: hashes.environment,
    mode,
    sourceCommit: manifest.sourceCommit,
    createdAt: manifest.createdAt,
  });
}

function prepareRelease(projectRoot, options) {
  const root = path.resolve(projectRoot);
  if (
    options == null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    options.deploymentEnvironment == null
  ) {
    throw new Error("HR_BRIDGE_RELEASE_PREPARE_INPUT_INVALID");
  }
  const sourceCommit = options.sourceCommit ?? null;
  const sourceRoot = path.resolve(options.sourceRoot ?? root);
  const sources = {
    bootstrap: path.join(
      sourceRoot,
      "scripts",
      "hr-bridge-release-worker.mjs",
    ),
    policy: path.join(sourceRoot, "scripts", "hr-bridge-runtime-policy.cjs"),
    mode: path.join(sourceRoot, "scripts", "hr-bridge-mode.cjs"),
    pm2App: path.join(sourceRoot, "scripts", "hr-bridge-pm2-app.cjs"),
    pm2Config: path.join(sourceRoot, "scripts", "hr-bridge-pm2.config.cjs"),
    artifact: path.join(sourceRoot, "dist", "hr-bridge-worker.cjs"),
  };
  const hashes = {};
  for (const [key, file] of Object.entries(sources)) {
    assertRegularFile(file, "HR_BRIDGE_RELEASE_SOURCE_INVALID");
    hashes[key] = hashFile(file);
  }
  const sourcePolicy = require(sources.policy);
  const environmentBytes = canonicalEnvironmentBytes(
    sourcePolicy,
    options.deploymentEnvironment,
  );
  require(sources.mode).deriveHrBridgeMode(
    JSON.parse(environmentBytes).values,
  );
  hashes.environment = hashBytes(environmentBytes);
  const id = releaseIdFor(hashes);
  const finalDirectory = releaseDirectory(root, id);
  fs.mkdirSync(releasesRoot(root), { recursive: true, mode: 0o700 });
  assertSafeDirectory(runtimeRoot(root), "HR_BRIDGE_RUNTIME_DIRECTORY_INVALID");
  assertSafeDirectory(releasesRoot(root), "HR_BRIDGE_RELEASES_DIRECTORY_INVALID");
  if (fs.existsSync(finalDirectory)) {
    const existing = validateRelease(root, id);
    fsyncDirectory(releasesRoot(root));
    return existing;
  }

  const temporaryDirectory = path.join(
    releasesRoot(root),
    `.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
  try {
    for (const [key, name] of Object.entries(RELEASE_FILES)) {
      const destination = path.join(temporaryDirectory, name);
      if (key === "environment") {
        fs.writeFileSync(destination, environmentBytes, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } else {
        fs.copyFileSync(sources[key], destination, fs.constants.COPYFILE_EXCL);
      }
      fs.chmodSync(destination, 0o600);
      fsyncFile(destination);
      if (hashFile(destination) !== hashes[key]) {
        throw new Error("HR_BRIDGE_RELEASE_COPY_HASH_MISMATCH");
      }
    }
    const manifestPath = path.join(
      temporaryDirectory,
      "hr-bridge-release.json",
    );
    const manifestFd = fs.openSync(manifestPath, "wx", 0o600);
    try {
      fs.writeFileSync(
        manifestFd,
        `${JSON.stringify(
        {
          version: RELEASE_MANIFEST_VERSION,
          id,
          sourceCommit:
            typeof sourceCommit === "string" ? sourceCommit : null,
          createdAt: new Date().toISOString(),
          files: hashes,
        },
        null,
        2,
        )}\n`,
        "utf8",
      );
      fs.fsyncSync(manifestFd);
    } finally {
      fs.closeSync(manifestFd);
    }
    fsyncDirectory(temporaryDirectory);
    try {
      fs.renameSync(temporaryDirectory, finalDirectory);
    } catch (error) {
      if (!fs.existsSync(finalDirectory)) throw error;
    }
    fsyncDirectory(releasesRoot(root));
  } finally {
    if (fs.existsSync(temporaryDirectory)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return validateRelease(root, id);
}

function emptyState() {
  return {
    version: RELEASE_STATE_VERSION,
    generation: 0,
    current: null,
    previous: null,
    pending: null,
  };
}

function normalizeDescriptor(value, code = "HR_BRIDGE_RELEASE_STATE_INVALID") {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !RELEASE_MODES.has(value.mode)
  ) {
    throw new Error(code);
  }
  assertReleaseId(value.id);
  return Object.freeze({ id: value.id, mode: value.mode });
}

function sameDescriptor(left, right) {
  return left?.id === right?.id && left?.mode === right?.mode;
}

function assertDescriptorMatchesRelease(projectRoot, descriptor, code) {
  if (!descriptor) return;
  const release = validateRelease(projectRoot, descriptor.id);
  if (release.mode !== descriptor.mode) throw new Error(code);
}

function normalizePending(value) {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.txId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.txId) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    ![
      "staged",
      "switching",
      "verified",
      "saved",
      "rolling-back",
      "rollback-saved",
    ].includes(value.phase)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
  }
  return Object.freeze({
    txId: value.txId,
    candidate: normalizeDescriptor(value.candidate),
    prior:
      value.prior == null ? null : normalizeDescriptor(value.prior),
    phase: value.phase,
    startedAt: value.startedAt,
  });
}

function readState(projectRoot) {
  const file = statePath(projectRoot);
  if (!fs.existsSync(file)) return emptyState();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
  }
  if (
    state?.version !== RELEASE_STATE_VERSION ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 0
  ) {
    throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
  }
  const normalized = {
    version: RELEASE_STATE_VERSION,
    generation: state.generation,
    current:
      state.current == null ? null : normalizeDescriptor(state.current),
    previous:
      state.previous == null ? null : normalizeDescriptor(state.previous),
    pending: state.pending == null ? null : normalizePending(state.pending),
  };
  if (
    normalized.pending &&
    !sameDescriptor(normalized.pending.prior, normalized.current)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
  }
  const descriptors = [
    normalized.current,
    normalized.previous,
    normalized.pending?.candidate,
    normalized.pending?.prior,
  ];
  for (const descriptor of descriptors) {
    assertDescriptorMatchesRelease(
      projectRoot,
      descriptor,
      "HR_BRIDGE_RELEASE_STATE_MODE_MISMATCH",
    );
  }
  return normalized;
}

function fsyncDirectory(directory, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(directory, "r");
      fs.fsyncSync(fd);
      return;
    } catch (error) {
      // Windows does not consistently permit fsync on directory handles.
      if (process.platform === "win32") return;
      lastError = error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  throw lastError ?? new Error("HR_BRIDGE_DIRECTORY_FSYNC_FAILED");
}

function ensureStateDurable(projectRoot) {
  const root = runtimeRoot(projectRoot);
  assertSafeDirectory(root, "HR_BRIDGE_RUNTIME_DIRECTORY_INVALID");
  const file = statePath(projectRoot);
  assertRegularFile(file, "HR_BRIDGE_RELEASE_STATE_INVALID");
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(root);
}

function writeState(projectRoot, state) {
  const root = runtimeRoot(projectRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertSafeDirectory(root, "HR_BRIDGE_RUNTIME_DIRECTORY_INVALID");
  const destination = statePath(projectRoot);
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error("HR_BRIDGE_RELEASE_STATE_INVALID");
  }
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const payload = `${JSON.stringify(
    { ...state, updatedAt: new Date().toISOString() },
    null,
    2,
  )}\n`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
    fsyncDirectory(root);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function withStateChange(state, changes) {
  return {
    version: RELEASE_STATE_VERSION,
    generation: state.generation + 1,
    current: state.current,
    previous: state.previous,
    pending: state.pending,
    ...changes,
  };
}

function beginActivation(projectRoot, candidate) {
  const descriptor = normalizeDescriptor(candidate);
  assertDescriptorMatchesRelease(
    projectRoot,
    descriptor,
    "HR_BRIDGE_RELEASE_CANDIDATE_MODE_MISMATCH",
  );
  const state = readState(projectRoot);
  if (state.pending) {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_PENDING");
  }
  if (state.current) validateRelease(projectRoot, state.current.id);
  if (state.previous) validateRelease(projectRoot, state.previous.id);
  const pending = {
    txId: crypto.randomUUID(),
    candidate: descriptor,
    prior: state.current,
    phase: "staged",
    startedAt: new Date().toISOString(),
  };
  writeState(projectRoot, withStateChange(state, {
    pending: {
      ...pending,
    },
  }));
  return Object.freeze(pending);
}

function establishBaseline(projectRoot, candidate) {
  const descriptor = normalizeDescriptor(candidate);
  assertDescriptorMatchesRelease(
    projectRoot,
    descriptor,
    "HR_BRIDGE_RELEASE_CANDIDATE_MODE_MISMATCH",
  );
  const state = readState(projectRoot);
  if (
    state.current != null ||
    state.previous != null ||
    state.pending != null
  ) {
    throw new Error("HR_BRIDGE_BASELINE_STATE_NOT_EMPTY");
  }
  writeState(
    projectRoot,
    withStateChange(state, {
      current: descriptor,
    }),
  );
}

const ALLOWED_PHASE_TRANSITIONS = Object.freeze({
  staged: new Set(["switching"]),
  switching: new Set(["verified", "rolling-back"]),
  verified: new Set(["saved", "rolling-back"]),
  saved: new Set(["rolling-back"]),
  "rolling-back": new Set(["rollback-saved"]),
  "rollback-saved": new Set(),
});

function markActivationPhase(projectRoot, txId, phase) {
  const state = readState(projectRoot);
  if (!state.pending || state.pending.txId !== txId) {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_MISMATCH");
  }
  if (!ALLOWED_PHASE_TRANSITIONS[state.pending.phase]?.has(phase)) {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_PHASE_INVALID");
  }
  writeState(
    projectRoot,
    withStateChange(state, {
      pending: { ...state.pending, phase },
    }),
  );
}

function commitActivation(projectRoot, txId) {
  const state = readState(projectRoot);
  if (!state.pending || state.pending.txId !== txId) {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_MISMATCH");
  }
  if (state.pending.phase !== "saved") {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_PHASE_INVALID");
  }
  const descriptor = state.pending.candidate;
  writeState(projectRoot, withStateChange(state, {
    current: descriptor,
    previous: sameDescriptor(state.current, descriptor)
      ? state.previous
      : state.current,
    pending: null,
  }));
}

function abortActivation(projectRoot, txId) {
  const state = readState(projectRoot);
  if (state.pending && state.pending.txId !== txId) {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_MISMATCH");
  }
  if (
    state.pending &&
    !["staged", "rollback-saved"].includes(state.pending.phase)
  ) {
    throw new Error("HR_BRIDGE_RELEASE_TRANSACTION_PHASE_INVALID");
  }
  writeState(projectRoot, withStateChange(state, { pending: null }));
}

function intentProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM من `kill(pid, 0)` يعني أنّ العمليةَ **قائمة** ولا نملك إشارتَها (pid أُعيد
    // تدويره إلى عمليةِ مستخدمٍ آخر — root مثلاً). رميُه كان يُخرج خطأً غيرَ رمز الانشغال
    // من `acquireRuntimeIntentLock` فيسقط النشر؛ والصوابُ اعتبارُها حيّة: الأسوأُ عندئذٍ
    // انتظارٌ زائد، والأسوأُ في المقابل حذفُ سجلِّ قفلٍ لمالكٍ حيّ.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function intentWait(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

// ويندوز يردّ `EPERM`/`EBUSY`/`EACCES` حين تُمَسّ مدخلةٌ يفتحها قارئٌ متزامن (مخالفةُ
// مشاركة). هي أخطاءٌ **عابرة** لا دليلَ فيها على فساد — بخلاف لينكس (خادمُ الإنتاج وCI)
// الذي لا يُنتجها أصلاً، فيبقى تصنيفُه صارماً كما هو.
const WINDOWS_TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
function isTransientSharingError(error) {
  return process.platform === "win32" && WINDOWS_TRANSIENT.has(error?.code);
}

function readIntentRecord(file, namespace) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    throw new Error("HR_BRIDGE_LOCK_INTENT_INVALID");
  }
  // ⭐ ٢١/٨ — **القراءةُ خارج مِظلّة `JSON.parse`.** كانت الاثنتان في `try` واحدٍ بـ`catch`
  // عارٍ يبتلع `errno` ويرمي `HR_BRIDGE_LOCK_INTENT_INVALID` **بلا `code`**. فملفٌّ يختفي
  // بين `lstatSync` و`readFileSync` — وهو ما يقع كلَّ يوم: المنافسُ ينظّف سجلاً ميّتاً في
  // `liveIntentRecords` أو يحرّر سجلَّه بعد خسارته — كان يُصنَّف **فساداً** لا اختفاءً.
  // و`liveIntentRecords` يتخطّى `ENOENT` وحده، فيُعيد رميَ الخطأ المُصنَّع ⇒ يخرج من
  // `acquireRuntimeIntentLock` غيرَ رمز الانشغال ⇒ يسقط المُدّعي وينهار الفحص.
  //
  // ⚠️ وهذا **السببُ الثاني**، وهو غيرُ الأوّل (نافذةُ الملفّ الفارغ التي أُغلقت بالكتابة
  // الذرّية) وغيرُ متناظر: يُصيب **مُدّعياً واحداً**، ثمّ يموت الآخرُ تبعاً بمهلته لأنّ
  // البروتوكول ينتظر منه إشارةً لن تصل — ولهذا بدا `[1,1]` تناظرياً وليس كذلك.
  //
  // العلاج: تمرير `errno` كما هو. لا تُصنّع خطأً في مسارٍ تُميّز فيه المُناداةُ اللاحقة
  // بـ`code`.
  let raw;
  for (let attempt = 1; ; attempt += 1) {
    try {
      raw = fs.readFileSync(file, "utf8");
      break;
    } catch (error) {
      // `ENOENT` يمرّ فوراً بـ`code` سليمٍ ليتخطّاه الماسح. أمّا مخالفةُ المشاركة على
      // ويندوز فعابرةٌ تزول بمحاولةٍ ثانية — ونُصرّ لأنّ **الملفّ موجود**: تخطّيه يكسر
      // الإقصاء المتبادل، وتركُه بلا محاولةٍ ثانية يُسقط النشر بلا سبب.
      if (attempt >= 5 || !isTransientSharingError(error)) throw error;
      intentWait(5 * attempt);
    }
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error("HR_BRIDGE_LOCK_INTENT_INVALID");
  }
  if (
    record?.version !== 1 ||
    record?.namespace !== namespace ||
    typeof record.token !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(record.token) ||
    typeof record.createdNs !== "string" ||
    !/^\d+$/.test(record.createdNs) ||
    typeof record.held !== "boolean" ||
    !Array.isArray(record.pids) ||
    record.pids.some((pid) => !Number.isInteger(pid) || pid <= 0)
  ) {
    throw new Error("HR_BRIDGE_LOCK_INTENT_INVALID");
  }
  return record;
}

function writeIntentRecord(file, record, replace = false) {
  // ٢٠/٨ — **الإنشاء صار ذرّياً كالاستبدال.** كان يفتح الاسم النهائيّ بـ`wx` ثمّ يكتب ثمّ
  // يُزامن ثمّ يُغلق، فيبقى الملفّ **فارغاً** طوال تلك النافذة. وقارئٌ متزامن يقرؤه فيفشل
  // `JSON.parse("")` ⇒ `HR_BRIDGE_LOCK_INTENT_INVALID` — وهو خطأٌ بلا `code` فلا يتخطّاه
  // `liveIntentRecords` (يتخطّى ENOENT وحده) بل يُعيد رميَه ⇒ يخرج من
  // `acquireRuntimeIntentLock` غيرَ رمز الانشغال فيسقط المُدّعي.
  //
  // ولأنّ النافذة تقع على الطرفين بالتناظر كان **الطفلان معاً** يسقطان — وهو `[1,1]` الذي
  // أوقف `pnpm prod:deploy` (الفحص في ذيل `pnpm build`، فتتّسع النافذة تحت حِمل البناء؛
  // ولهذا يمرّ منفرداً ويسقط بعد بناءٍ ثقيل).
  //
  // العلاج: اكتب في اسمٍ مؤقّت (يتخطّاه الماسح بلاحقة `.tmp-`) ثمّ `rename` — وهي **ذرّية**
  // على POSIX ⇒ لا يرى قارئٌ الاسمَ النهائيّ إلّا بمحتواه كاملاً. والتفرّد محفوظ: المؤقّت
  // يُفتح بـ`wx`، والاسم النهائيّ يحمل UUID لكلّ مُدّعٍ فلا تصادم.
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}
`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!replace) {
    // إنشاءٌ: نحفظ دلالة «لا تدُس اسماً قائماً» — الرابطُ الصلب يفشل بـEEXIST ذرّياً،
    // ثمّ نُزيل المؤقّت. (rename يدوس صامتاً، وهو ما لا نريده في مسار الإنشاء.)
    try {
      fs.linkSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return;
  }
  // على لينكس `rename` ذرّيّةٌ ولا تفشل لمشاركةٍ قطّ ⇒ محاولةٌ واحدة. وعلى ويندوز قد تردّ
  // `EPERM` لأنّ ماسحاً متزامناً يفتح الوجهة — عابرٌ يزول بمحاولةٍ ثانية.
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (attempt >= 5 || !isTransientSharingError(error)) {
        try { fs.unlinkSync(temporary); } catch { /* المؤقّت لا يُخلَّف وراءنا */ }
        throw error;
      }
      intentWait(5 * attempt);
    }
  }
}

function fsyncIntentDirectory(directory) {
  fsyncDirectory(directory);
}

function compareIntent(left, right) {
  const leftTime = BigInt(left.record.createdNs);
  const rightTime = BigInt(right.record.createdNs);
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  return left.record.token.localeCompare(right.record.token);
}

function intentCandidateWins(entries, ownFile) {
  if (
    entries.some(
      (entry) => entry.file !== ownFile && entry.record.held,
    )
  ) {
    return false;
  }
  return [...entries].sort(compareIntent)[0]?.file === ownFile;
}

// ⭐⭐ ٢١/٨ — **الغيابُ لا يُصدَّق حتى يَثبت دوامُه** (السببُ الثالث، أخطرُ الثلاثة).
//
// الماسحُ يتخطّى `ENOENT` لأنّ «الاسمُ غير موجود ⇒ لا منافس». هذا صحيحٌ على POSIX: هناك
// `rename(2)` **ذرّية** فلا تُغيّب الوجهةَ لحظةً واحدة. وليس صحيحاً على ويندوز:
// `MoveFileEx(REPLACE_EXISTING)` قد يكشف غياباً وجيزاً للوجهة — وكلُّ مُدّعٍ يُنفّذ
// استبدالاً واحداً (كتابةُ `held:true`) في كلّ ادّعاء.
//
// والنتيجة **ليست خطأً بل أسوأ منه: فائزان معاً.** أُثبت حتميّاً: منافسٌ حيٌّ محتجِزٌ
// يرتدّ اسمُه `ENOENT` في **الطورَين** (الترشيح ثمّ التثبّت) ⇒ يُمنح القفل. مرّةً واحدةً
// لا تكفي — الطورُ الثاني شبكةُ أمانٍ تمسكها؛ فلزم غيابٌ مزدوج، وهو ما يقع تحت الحِمل.
// وقد رُصد فعلاً على ويندوز مرّتين (`EEXIST` على ملفّ `winner` في الفاحص).
//
// العلاج: على ويندوز وحده، لا نُصدّق الغيابَ حتى نُعيد سرد المجلّد؛ فإن كان الاسمُ ما
// زال مسروداً فالغيابُ كان وهمَ استبدالٍ جارٍ ⇒ أعِد المسح. وعند نفاد المحاولات **نفشل
// مغلقين** (بلاغُ انشغال) لا مفتوحين: منحُ قفلٍ عند الشكّ هو العطبُ بعينه.
function scanIntentRecords(directory, namespace, ownFile) {
  const live = [];
  const vanished = [];
  const names = fs.readdirSync(directory);
  for (const name of names) {
    if (name.includes(".tmp-")) continue;
    if (!/^[0-9]+-[0-9a-f-]{36}\.json$/i.test(name)) {
      throw new Error("HR_BRIDGE_LOCK_INTENT_INVALID");
    }
    const file = path.join(directory, name);
    let record;
    try {
      record = readIntentRecord(file, namespace);
    } catch (error) {
      // اختفاءُ سجلٍّ أثناء المسح شرعيّ **على POSIX**: منافسٌ نظّف ميّتاً أو حرّر سجلَّه.
      // وعلى ويندوز يُسجَّل ليُتحقَّق من دوامه قبل تصديقه (انظر `liveIntentRecords`).
      //
      // ⛔ ولا يُتخطّى سجلٌّ **موجودٌ متعذّرُ القراءة**. جرّبتُ ذلك (٢١/٨) فكسرتُ الإقصاء
      // المتبادل فوراً: على ويندوز يردّ النظامُ `EPERM` لحظةَ يفتح منافسٌ الملفّ، فتخطّاه
      // كلٌّ منهما ⇒ ظنّ كلٌّ أنّه وحده ⇒ **فائزان معاً** (أمسكه الفاحصُ بـ`EEXIST` على
      // ملفّ `winner`). «لم أستطع قراءته» ≠ «ليس موجوداً»: الأولى تستوجب إعادةَ محاولةٍ
      // ثمّ فشلاً صريحاً، والثانية وحدها تستوجب التخطّي. المعالجةُ صارت في
      // `readIntentRecord` بإعادة محاولةٍ محدودة.
      if (error?.code === "ENOENT") { vanished.push(name); continue; }
      throw error;
    }
    const [, filePid, fileToken] = name.match(
      /^([0-9]+)-([0-9a-f-]{36})\.json$/i,
    );
    if (
      record.token !== fileToken ||
      !record.pids.includes(Number(filePid)) ||
      record.pids.length === 0
    ) {
      throw new Error("HR_BRIDGE_LOCK_INTENT_INVALID");
    }
    if (record.pids.some(intentProcessIsAlive)) {
      live.push({ file, record });
    } else if (file !== ownFile) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return { live, vanished, names };
}

// **شاهدُ الغياب الحاسم: الملفُّ المؤقّت.** «الاسمُ ليس مسروداً الآن» لا يُثبت شيئاً
// وحده — قد نكون داخل نافذة الاستبدال ذاتها التي غيّبته (أمسكها Codex على #696: تحقّقي
// الأوّل كان يقبل الغيابَ إن لم يَعُد الاسمُ **فوراً**، وهو احتمالٌ لا برهان).
//
// لكنّ بروتوكولَ `writeIntentRecord` يمنحنا برهاناً: كلُّ كتابةٍ تمرّ بملفٍّ مؤقّتٍ اسمُه
// `<الاسم النهائيّ>.tmp-…` يبقى قائماً حتى تكتمل النقلة. فلا توجد لحظةٌ يغيب فيها الاسمُ
// النهائيّ **ومؤقّتُه معاً** ما دام هناك كاتبٌ يعمل. إذاً:
//
//     غاب الاسم  ∧  لا مؤقّتَ له  ⇒  حُذف فعلاً  (لا منافس)
//     غاب الاسم  ∧  له مؤقّت     ⇒  كتابةٌ جارية (منافسٌ حيّ) ⇒ أعِد المسح
//
// وهذا **حاسمٌ لا احتماليّ**، ويُضاف إليه انتظارٌ وجيزٌ قبل إعادة السرد لئلّا نلتقط
// المجلّد في اللحظة نفسها. وعند نفاد المحاولات **نفشل مغلقين** (بلاغُ انشغال): منحُ
// قفلٍ عند الشكّ هو العطبُ بعينه.
//
// ⚠️ **بلا تفريعٍ بحسب المنصّة.** كان هنا `platform !== "win32"` يعود فوراً — فكان
// السلوكُ يختلف بين آلة التطوير وCI، ويستحيل أن يحرس اختبارٌ ما لا يعمل على لينكس
// (أمسكه Codex أيضاً). الكلفةُ على لينكس معدومةٌ عملياً: سردٌ إضافيٌّ واحد **فقط** حين
// يغيب اسمٌ أصلاً، وهناك لا يغيب إلّا بحذفٍ حقيقيّ فيعود من أوّل تحقّق.
// كتابةُ السجلّ تستغرق ميكروثانيات؛ ثانيتان هامشٌ سخيّ. وما تجاوز ذلك فهو بقيّةُ عمليةٍ
// ماتت — **تُتجاهَل ولا تُحذف**: مؤقّتٌ يتيمٌ يُعامَل «كتابةً جارية» أبداً يَحبس القفلَ
// حبساً دائماً، وحذفُ مؤقّتِ غيرِنا يُخاطر بكاتبٍ بطيء. التجاهلُ يتجنّب الخطرين.
const INTENT_TEMP_INFLIGHT_MS = 2_000;

function freshWriteTemps(directory, names) {
  const now = Date.now();
  const fresh = [];
  for (const name of names) {
    if (!name.includes(".tmp-")) continue;
    let stat;
    try {
      stat = fs.lstatSync(path.join(directory, name));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (now - stat.mtimeMs <= INTENT_TEMP_INFLIGHT_MS) fresh.push(name);
  }
  return fresh;
}

function intentSnapshotUnstable(directory, vanished) {
  const present = fs.readdirSync(directory);
  // (أ) اسمٌ رأيناه ثمّ تعذّر قراءتُه، وما زال مسروداً أو له مؤقّت ⇒ كتابةٌ جارية.
  if (
    vanished.some(
      (name) =>
        present.includes(name) ||
        present.some((entry) => entry.startsWith(`${name}.tmp-`)),
    )
  ) {
    return true;
  }
  // (ب) أيُّ مؤقّتٍ طازج ⇒ كاتبٌ يعمل الآن، ولقطتُنا قد تكون ناقصةً **بلا أن ندري**:
  // إن أسقط النظامُ المدخلةَ من السرد أثناء النقلة لم يصل الاسمُ إلى `vanished` أصلاً،
  // فلا ينفع تتبّعُ الغائبين وحده. المؤقّتُ هو الشاهدُ الوحيد الباقي عندئذٍ.
  return freshWriteTemps(directory, present).length > 0;
}

function liveIntentRecords(directory, namespace, ownFile = null) {
  for (let attempt = 1; ; attempt += 1) {
    const { live, vanished, names } = scanIntentRecords(directory, namespace, ownFile);
    if (vanished.length === 0 && freshWriteTemps(directory, names).length === 0) {
      return live;
    }
    // انتظارٌ **قبل** إعادة السرد: التحقّقُ الفوريّ قد يقع داخل النافذة نفسها التي
    // غيّبت الاسمَ فيبدو الغيابُ دائماً وهو لحظيّ (أمسكها Codex على #696).
    intentWait(2 * attempt);
    if (!intentSnapshotUnstable(directory, vanished)) return live;
    if (attempt >= 5) throw new Error("HR_BRIDGE_LOCK_INTENT_UNSTABLE");
  }
}

function acquireRuntimeIntentLock(projectRoot, namespace) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(namespace)) {
    throw new Error("HR_BRIDGE_LOCK_NAMESPACE_INVALID");
  }
  const root = runtimeRoot(projectRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, `${namespace}-locks`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeDirectory(directory, "HR_BRIDGE_LOCK_DIRECTORY_INVALID");
  const busyCode =
    namespace === "sync"
      ? "HR_BRIDGE_DEPLOY_SYNC_ALREADY_RUNNING"
      : "HR_BRIDGE_DEPLOY_ALREADY_RUNNING";
  const token = crypto.randomUUID();
  const file = path.join(directory, `${process.pid}-${token}.json`);
  let record = {
    version: 1,
    namespace,
    token,
    createdNs: process.hrtime.bigint().toString(),
    held: false,
    pids: [process.pid],
  };
  writeIntentRecord(file, record);
  fsyncIntentDirectory(directory);
  try {
    const candidates = liveIntentRecords(directory, namespace, file);
    if (!intentCandidateWins(candidates, file)) {
      throw new Error(busyCode);
    }
    record = { ...record, held: true };
    writeIntentRecord(file, record, true);
    fsyncIntentDirectory(directory);
    intentWait(20);
    const held = liveIntentRecords(directory, namespace, file)
      .filter((entry) => entry.record.held)
      .sort(compareIntent);
    if (held[0]?.file !== file) {
      throw new Error(busyCode);
    }
  } catch (error) {
    try {
      fs.unlinkSync(file);
      fsyncIntentDirectory(directory);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    // مسحٌ لم يستقرّ = شكٌّ في وجود منافس ⇒ **انشغال** (فشلٌ مغلق)، لا خطأٌ يُسقط النشر.
    if (error?.message === "HR_BRIDGE_LOCK_INTENT_UNSTABLE") {
      throw new Error(busyCode);
    }
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const existing = readIntentRecord(file, namespace);
      if (existing.token === token) {
        fs.unlinkSync(file);
        fsyncIntentDirectory(directory);
      }
    } catch {
      // Never remove an intent whose ownership can no longer be proved.
    }
  };
}

function acquireDeploymentLock(projectRoot) {
  return acquireRuntimeIntentLock(projectRoot, "deploy");
}

function pruneBridgeReleasesAfterCommit(projectRoot, options = {}) {
  const keepRecent = options.keepRecent ?? 2;
  if (!Number.isInteger(keepRecent) || keepRecent < 0 || keepRecent > 10) {
    throw new Error("HR_BRIDGE_RELEASE_RETENTION_INPUT_INVALID");
  }
  const state = readState(projectRoot);
  if (!state.current || state.pending) {
    return Object.freeze({ removed: 0, failed: 0, skipped: true });
  }
  const committedCandidateId = options.committedCandidateId ?? state.current.id;
  if (committedCandidateId !== state.current.id) {
    throw new Error("HR_BRIDGE_RELEASE_RETENTION_NOT_COMMITTED");
  }
  const root = releasesRoot(projectRoot);
  if (!fs.existsSync(root)) {
    return Object.freeze({ removed: 0, failed: 0, skipped: false });
  }
  assertSafeDirectory(root, "HR_BRIDGE_RELEASES_DIRECTORY_INVALID");
  const realRoot = fs.realpathSync(root);
  const protectedIds = new Set(
    [
      state.current?.id,
      state.previous?.id,
      state.pending?.candidate?.id,
      state.pending?.prior?.id,
      committedCandidateId,
      ...(options.protectedReleaseIds ?? []),
    ].filter(Boolean),
  );
  for (const id of protectedIds) {
    if (!RELEASE_ID.test(id)) {
      throw new Error("HR_BRIDGE_RELEASE_RETENTION_INPUT_INVALID");
    }
  }
  const releases = [];
  for (const name of fs.readdirSync(root)) {
    if (!RELEASE_ID.test(name)) {
      throw new Error("HR_BRIDGE_RELEASES_DIRECTORY_INVALID");
    }
    const directory = path.join(root, name);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("HR_BRIDGE_RELEASE_RETENTION_TARGET_INVALID");
    }
    const realDirectory = fs.realpathSync(directory);
    if (path.dirname(realDirectory) !== realRoot) {
      throw new Error("HR_BRIDGE_RELEASE_RETENTION_TARGET_INVALID");
    }
    const release = validateRelease(projectRoot, name);
    const createdAt = Date.parse(release.createdAt);
    if (!Number.isFinite(createdAt)) {
      throw new Error("HR_BRIDGE_RELEASE_MANIFEST_INVALID");
    }
    releases.push({ id: name, directory, createdAt });
  }
  const recent = new Set(
    releases
      .filter((release) => !protectedIds.has(release.id))
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.id.localeCompare(right.id),
      )
      .slice(0, keepRecent)
      .map((release) => release.id),
  );
  const removable = releases
    .filter(
      (release) =>
        !protectedIds.has(release.id) && !recent.has(release.id),
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  const removeRelease =
    options.removeRelease ??
    ((directory) => fs.rmSync(directory, { recursive: true, force: false }));
  let removed = 0;
  let failed = 0;
  for (const release of removable) {
    try {
      const before = fs.realpathSync(release.directory);
      if (path.dirname(before) !== realRoot) {
        throw new Error("HR_BRIDGE_RELEASE_RETENTION_TARGET_INVALID");
      }
      removeRelease(release.directory, release.id);
      if (fs.existsSync(release.directory)) {
        throw new Error("HR_BRIDGE_RELEASE_RETENTION_DELETE_INCOMPLETE");
      }
      fsyncDirectory(root);
      removed += 1;
    } catch {
      failed += 1;
      break;
    }
  }
  return Object.freeze({ removed, failed, skipped: false });
}

function loadReleasePolicy(projectRoot, id) {
  return require(validateRelease(projectRoot, id).policyPath);
}

function loadReleaseEnvironment(projectRoot, id) {
  const release = validateRelease(projectRoot, id);
  const policy = require(release.policyPath);
  return parseCanonicalEnvironment(release.environmentPath, policy);
}

module.exports = Object.freeze({
  RELEASE_FILES,
  acquireDeploymentLock,
  acquireRuntimeIntentLock,
  abortActivation,
  beginActivation,
  commitActivation,
  ensureStateDurable,
  establishBaseline,
  loadReleaseEnvironment,
  loadReleasePolicy,
  markActivationPhase,
  normalizeDescriptor,
  prepareRelease,
  pruneBridgeReleasesAfterCommit,
  readState,
  releaseDirectory,
  runtimeRoot,
  validateRelease,
});
