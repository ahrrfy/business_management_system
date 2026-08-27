#!/usr/bin/env node

import process from "node:process";

const REQUIRED_WORKFLOWS = Object.freeze([
  Object.freeze({
    file: "ci.yml",
    label: "CI",
    allowedEvents: Object.freeze(["push"]),
    requiredJobs: Object.freeze(["check-test-build", "authz-guard"]),
  }),
  Object.freeze({
    file: "security.yml",
    label: "Security Audit",
    allowedEvents: Object.freeze(["push"]),
    requiredJobs: Object.freeze(["audit"]),
  }),
  Object.freeze({
    file: "android-native-ci.yml",
    label: "Native Android CI",
    allowedEvents: Object.freeze(["push", "workflow_dispatch"]),
    requiredJobs: Object.freeze([
      "native-android-check",
      "native-android-device-smoke",
    ]),
  }),
]);

/**
 * سباق نافذة الإطلاق (٢٧/٨/٢٦) — قبل هذا الحدّ كانت البوّابة تشترط أن يكون SHA المُرسَل
 * إلى `workflow_dispatch` هو نفسه رأس main **الحيّ** لحظة التقييم، وأن يكون CI على ذلك
 * الرأس تحديداً `success`. في مستودعٍ نشطٍ يدمج PRاً كلّ ~٥-١٠ دقائق، وCI يستغرق ٣٥+ دقيقة،
 * كانت نافذة النجاح تقلّ عن دقائق، فيسقط dispatch مراراً بعطلٍ يقول «pending/none» بلا
 * علاقةٍ للـAAB الذي يُبنى.
 *
 * الحلّ: قبولُ SHA يقع ضمن آخر [MAX_ANCESTOR_WINDOW] commits على main، **بشرط**:
 *   1) أنّه سلفٌ (ancestor) للرأس الحيّ ⇒ لا فرعٌ مقطوع.
 *   2) البوّابات الثلاث كلُّها `success` على ذلك السلف.
 *   3) وحدة `GITHUB_SHA` (المُدفَع بها dispatch) داخل هذه النافذة أيضاً (يمنع dispatch من
 *      SHA قديمٍ بعمدٍ لتلافي فحصٍ فاشلٍ حديث).
 *
 * سلامة الشحن: AAB يُبنى من `GITHUB_SHA` (رأس main لحظة dispatch)، لكنّ التحقّق يقع على
 * سلفٍ أخضر. الشيفرة الجديدة بين السلف وGITHUB_SHA لم تُحكَم عليها CI من هذه البوّابة —
 * غير أنّ `signed-native-artifacts` نفسه يُشغِّل build+lint+unit tests على GITHUB_SHA
 * (Native Android CI الكامل يمرّ داخل مسار البناء أيضاً)، فالخطر الفعليّ نقصُ تغطيةِ shard
 * الويب لبضعة commits — احتمالٌ صغيرٌ يقايض عمليّاً مقابل استمراريّة الإطلاق.
 */
const MAX_ANCESTOR_WINDOW = Number(
  process.env.RELEASE_GATE_ANCESTOR_WINDOW ?? 5,
);

class ReleaseWorkflowGateError extends Error {}

function reject(message) {
  throw new ReleaseWorkflowGateError(message);
}

function requireEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) reject(`${name} is required`);
  return value;
}

function verifyDispatchContext(environment) {
  const eventName = requireEnvironment(environment, "GITHUB_EVENT_NAME");
  const ref = requireEnvironment(environment, "GITHUB_REF");
  const refType = requireEnvironment(environment, "GITHUB_REF_TYPE");
  const refName = requireEnvironment(environment, "GITHUB_REF_NAME");
  const repository = requireEnvironment(environment, "GITHUB_REPOSITORY");
  const sha = requireEnvironment(environment, "GITHUB_SHA");

  if (eventName !== "workflow_dispatch") {
    reject(
      `release artifacts are restricted to workflow_dispatch (received ${eventName})`,
    );
  }
  if (refType !== "branch" || ref !== "refs/heads/main" || refName !== "main") {
    reject(
      `release artifacts are restricted to refs/heads/main (received ${ref})`,
    );
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    reject("GITHUB_REPOSITORY has an invalid value");
  }
  if (!/^[0-9a-f]{40}$/i.test(sha))
    reject("GITHUB_SHA must be a full commit SHA");

  return Object.freeze({ repository, sha, branch: "main" });
}

function newestEligibleRun(workflow, runs, sha, branch) {
  if (!Array.isArray(runs))
    reject(`${workflow.label}: GitHub returned an invalid runs payload`);
  const eligible = runs
    .filter(
      (run) =>
        run?.head_sha === sha &&
        run?.head_branch === branch &&
        workflow.allowedEvents.includes(run?.event),
    )
    .sort((left, right) => {
      const timeDelta =
        Date.parse(right?.created_at ?? "") -
        Date.parse(left?.created_at ?? "");
      if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
      return Number(right?.id ?? 0) - Number(left?.id ?? 0);
    });

  const run = eligible[0];
  if (!run) return { missing: true };
  if (run.status !== "completed" || run.conclusion !== "success") {
    return {
      pending: true,
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
    };
  }
  return { run };
}

function verifyRequiredJobs(workflow, jobs) {
  if (!Array.isArray(jobs))
    reject(`${workflow.label}: GitHub returned an invalid jobs payload`);
  const jobsByName = new Map(jobs.map((job) => [job?.name, job]));
  for (const jobName of workflow.requiredJobs) {
    const job = jobsByName.get(jobName);
    if (!job) reject(`${workflow.label}: required job ${jobName} is missing`);
    if (job.status !== "completed" || job.conclusion !== "success") {
      reject(
        `${workflow.label}: required job ${jobName} is ` +
          `${job.status ?? "unknown"}/${job.conclusion ?? "none"}`,
      );
    }
  }
}

async function githubApi(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "super-alarabiya-android-release-gate",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!response.ok)
    reject(`GitHub API ${path} failed with HTTP ${response.status}`);
  return response.json();
}

/**
 * يعود قائمةً بآخر `count` SHA على branch (من الأحدث إلى الأقدم).
 * تعمل عبر endpoint العام لسجلّ الالتزامات على الفرع.
 */
async function listRecentShas(api, repository, branch, count, token) {
  const query = new URLSearchParams({
    sha: branch,
    per_page: String(Math.max(1, Math.min(count, 100))),
  });
  const commits = await api(
    `/repos/${repository}/commits?${query}`,
    token,
  );
  if (!Array.isArray(commits) || commits.length === 0) {
    reject(`no commits found on ${branch}`);
  }
  const shas = commits
    .map((commit) => commit?.sha)
    .filter((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha));
  if (shas.length === 0) {
    reject(`no valid SHAs returned for ${branch}`);
  }
  return shas;
}

/**
 * يجرِّب البوّابات الثلاث لـ`candidateSha`. يُعيد `null` إن كانت خضراء كاملةً؛ يرفع
 * ReleaseWorkflowGateError عند فشلٍ نهائيّ (job مفقود/فاشل). يُعيد سبباً بشرياً إن كان
 * الفشل «pending/missing» فيرثيه المتصل ليجرّب سلفاً آخر.
 */
async function evaluateSha({ api, repository, branch, candidateSha, token }) {
  const perWorkflow = [];
  for (const workflow of REQUIRED_WORKFLOWS) {
    const query = new URLSearchParams({
      branch,
      head_sha: candidateSha,
      per_page: "100",
      exclude_pull_requests: "true",
    });
    const payload = await api(
      `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow.file)}/runs?${query}`,
      token,
    );
    const result = newestEligibleRun(workflow, payload?.workflow_runs, candidateSha, branch);
    if (result.missing) {
      return { pending: true, reason: `${workflow.label}: no eligible run yet` };
    }
    if (result.pending) {
      return {
        pending: true,
        reason: `${workflow.label}: run ${result.id ?? "unknown"} is ${result.status ?? "unknown"}/${result.conclusion ?? "none"}`,
      };
    }
    const jobsPayload = await api(
      `/repos/${repository}/actions/runs/${result.run.id}/jobs?per_page=100&filter=latest`,
      token,
    );
    // Non-pending failures (missing/skipped required job) throw a hard rejection —
    // ancestor walk should not silently bypass a real regression. Only pending/missing
    // (transient race) results ask the caller to try another SHA.
    verifyRequiredJobs(workflow, jobsPayload?.jobs);
    perWorkflow.push({ workflow: workflow.label, runId: result.run.id });
  }
  return { pass: true, perWorkflow };
}

async function verifyLiveGate(environment = process.env, api = githubApi) {
  const context = verifyDispatchContext(environment);
  const token = requireEnvironment(environment, "GH_TOKEN");
  const repository = await api(`/repos/${context.repository}`, token);
  if (repository?.default_branch !== context.branch) {
    reject(`repository default branch must be ${context.branch}`);
  }

  const recentShas = await listRecentShas(
    api,
    context.repository,
    context.branch,
    MAX_ANCESTOR_WINDOW,
    token,
  );

  // The dispatched SHA (GITHUB_SHA) must itself sit within the recent window — this
  // rejects an intentional dispatch from a stale main tip to dodge current-SHA breakage.
  const dispatchIndex = recentShas.indexOf(context.sha);
  if (dispatchIndex < 0) {
    reject(
      `dispatched SHA ${context.sha} is not within the newest ${MAX_ANCESTOR_WINDOW} commits on ${context.branch}`,
    );
  }

  // Try dispatched SHA first, then walk back to older ancestors within window. The
  // dispatched SHA is favoured because it exactly matches what the build produces —
  // ancestors are a relaxation for the race, not the preferred outcome.
  const skipped = [];
  for (let index = dispatchIndex; index < recentShas.length; index += 1) {
    const candidate = recentShas[index];
    const evaluation = await evaluateSha({
      api,
      repository: context.repository,
      branch: context.branch,
      candidateSha: candidate,
      token,
    });
    if (evaluation.pass) {
      const distance = index - dispatchIndex;
      const suffix =
        distance === 0
          ? `for current dispatch SHA ${candidate}`
          : `for ancestor ${candidate} (${distance} commit${distance === 1 ? "" : "s"} behind dispatch SHA ${context.sha})`;
      for (const item of evaluation.perWorkflow) {
        console.log(
          `android release gate: ${item.workflow} run ${item.runId} and required jobs passed ${suffix}`,
        );
      }
      console.log(
        `android release gate: all required workflows passed ${suffix} — window=${MAX_ANCESTOR_WINDOW}`,
      );
      return;
    }
    skipped.push(`${candidate}: ${evaluation.reason}`);
  }

  reject(
    `no SHA within the newest ${MAX_ANCESTOR_WINDOW} commits on ${context.branch} has all workflows green (` +
      skipped.map((entry) => `  · ${entry}`).join("; ") +
      `)`,
  );
}

function expectRejected(label, action) {
  try {
    action();
  } catch (error) {
    if (error instanceof ReleaseWorkflowGateError) return;
    throw error;
  }
  throw new Error(`self-test expected rejection: ${label}`);
}

async function expectRejectedAsync(label, action) {
  try {
    await action();
  } catch (error) {
    if (error instanceof ReleaseWorkflowGateError) return;
    throw error;
  }
  throw new Error(`self-test expected rejection: ${label}`);
}

async function runSelfTest() {
  const sha = "a".repeat(40);
  const validEnvironment = {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REF_NAME: "main",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_SHA: sha,
  };
  verifyDispatchContext(validEnvironment);
  const successfulRun = {
    id: 11,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    created_at: "2026-08-10T00:00:00Z",
  };

  // Direct-SHA path still works: newestEligibleRun returns .run for a green run.
  const direct = newestEligibleRun(REQUIRED_WORKFLOWS[0], [successfulRun], sha, "main");
  if (!direct.run) throw new Error("self-test: expected successful direct run");

  verifyRequiredJobs(
    REQUIRED_WORKFLOWS[0],
    REQUIRED_WORKFLOWS[0].requiredJobs.map((name, index) => ({
      id: index + 1,
      name,
      status: "completed",
      conclusion: "success",
    })),
  );

  expectRejected("non-dispatch event", () =>
    verifyDispatchContext({ ...validEnvironment, GITHUB_EVENT_NAME: "push" }),
  );
  expectRejected("non-main branch", () =>
    verifyDispatchContext({
      ...validEnvironment,
      GITHUB_REF: "refs/heads/release",
      GITHUB_REF_NAME: "release",
    }),
  );

  // Missing/pending now returns a soft failure so the ancestor walk can try again.
  const missing = newestEligibleRun(REQUIRED_WORKFLOWS[0], [], sha, "main");
  if (!missing.missing) throw new Error("self-test: missing run should return .missing");
  const pending = newestEligibleRun(
    REQUIRED_WORKFLOWS[0],
    [{ ...successfulRun, status: "in_progress", conclusion: null, id: 12 }],
    sha,
    "main",
  );
  if (!pending.pending) throw new Error("self-test: pending run should return .pending");

  // But non-pending failures (skipped/missing job) still throw a hard rejection —
  // otherwise the ancestor walk would silently bypass a real regression.
  expectRejected("skipped required job stays hard-failure", () =>
    verifyRequiredJobs(REQUIRED_WORKFLOWS[1], [
      { name: "audit", status: "completed", conclusion: "skipped" },
    ]),
  );
  expectRejected("missing required job stays hard-failure", () =>
    verifyRequiredJobs(REQUIRED_WORKFLOWS[0], []),
  );
  // pull-request runs still cannot satisfy a push-scoped gate.
  const wrongEvent = newestEligibleRun(
    REQUIRED_WORKFLOWS[0],
    [{ ...successfulRun, event: "pull_request" }],
    sha,
    "main",
  );
  if (!wrongEvent.missing) {
    throw new Error("self-test: pull_request run must not satisfy push-only gate");
  }

  // Live gate: happy path — dispatched SHA is at index 0 with all green.
  const liveEnvironment = { ...validEnvironment, GH_TOKEN: "self-test-token" };
  const recent = [sha, "b".repeat(40), "c".repeat(40)];
  const runIds = new Map(
    REQUIRED_WORKFLOWS.map((workflow, index) => [workflow.file, 100 + index]),
  );
  const makeApi = (options = {}) => {
    const commits = options.commits ?? recent;
    return async (path, token) => {
      if (token !== liveEnvironment.GH_TOKEN)
        reject("self-test received the wrong token");
      if (path === "/repos/owner/repository") return { default_branch: "main" };
      if (path.startsWith("/repos/owner/repository/commits?")) {
        return commits.map((commitSha) => ({ sha: commitSha }));
      }
      for (const workflow of REQUIRED_WORKFLOWS) {
        const workflowPrefix = `/repos/owner/repository/actions/workflows/${workflow.file}/runs?`;
        if (path.startsWith(workflowPrefix)) {
          const query = new URLSearchParams(path.split("?")[1] ?? "");
          const forSha = query.get("head_sha");
          const runResolver = options.runsFor ?? (() => ({
            id: runIds.get(workflow.file),
            head_sha: forSha,
            head_branch: "main",
            event: workflow.allowedEvents[0],
            status: "completed",
            conclusion: "success",
            created_at: "2026-08-10T00:00:00Z",
          }));
          const built = runResolver(workflow, forSha);
          return {
            workflow_runs: built ? [built] : [],
          };
        }
        const jobPath = `/repos/owner/repository/actions/runs/${runIds.get(workflow.file)}/jobs?per_page=100&filter=latest`;
        if (path === jobPath) {
          return {
            jobs: workflow.requiredJobs.map((name, index) => ({
              id: index + 1,
              name,
              status: "completed",
              conclusion: "success",
            })),
          };
        }
      }
      reject(`self-test received an unexpected API path: ${path}`);
    };
  };

  // Happy path: dispatched SHA green.
  await verifyLiveGate(liveEnvironment, makeApi());

  // Ancestor path: dispatched SHA pending, ancestor green ⇒ pass.
  await verifyLiveGate(
    liveEnvironment,
    makeApi({
      commits: recent,
      runsFor: (workflow, forSha) => {
        if (forSha === sha) {
          return {
            id: runIds.get(workflow.file),
            head_sha: forSha,
            head_branch: "main",
            event: workflow.allowedEvents[0],
            status: "in_progress",
            conclusion: null,
            created_at: "2026-08-10T00:00:00Z",
          };
        }
        return {
          id: runIds.get(workflow.file),
          head_sha: forSha,
          head_branch: "main",
          event: workflow.allowedEvents[0],
          status: "completed",
          conclusion: "success",
          created_at: "2026-08-10T00:00:00Z",
        };
      },
    }),
  );

  // Stale dispatch: dispatched SHA not among recent → reject.
  await expectRejectedAsync("stale dispatched SHA rejected", () =>
    verifyLiveGate(
      { ...liveEnvironment, GITHUB_SHA: "d".repeat(40) },
      makeApi(),
    ),
  );

  // All ancestors pending ⇒ reject with reasons.
  await expectRejectedAsync("all-window pending rejected", () =>
    verifyLiveGate(
      liveEnvironment,
      makeApi({
        runsFor: (workflow, forSha) => ({
          id: runIds.get(workflow.file),
          head_sha: forSha,
          head_branch: "main",
          event: workflow.allowedEvents[0],
          status: "in_progress",
          conclusion: null,
          created_at: "2026-08-10T00:00:00Z",
        }),
      }),
    ),
  );

  console.log("android release workflow gate: self-test passed");
}

const gatePromise = process.argv.includes("--selftest")
  ? runSelfTest()
  : verifyLiveGate();
gatePromise.catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`android release gate: ${message}`);
  process.exitCode = 1;
});
