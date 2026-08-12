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

function newestEligibleRun(workflow, runs, context) {
  if (!Array.isArray(runs))
    reject(`${workflow.label}: GitHub returned an invalid runs payload`);
  const eligible = runs
    .filter(
      (run) =>
        run?.head_sha === context.sha &&
        run?.head_branch === context.branch &&
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
  if (!run)
    reject(`${workflow.label}: no eligible run exists for ${context.sha}`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    reject(
      `${workflow.label}: latest eligible run ${run.id ?? "unknown"} is ` +
        `${run.status ?? "unknown"}/${run.conclusion ?? "none"}`,
    );
  }
  return run;
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

async function verifyLiveGate(environment = process.env, api = githubApi) {
  const context = verifyDispatchContext(environment);
  const token = requireEnvironment(environment, "GH_TOKEN");
  const repository = await api(`/repos/${context.repository}`, token);
  if (repository?.default_branch !== context.branch) {
    reject(`repository default branch must be ${context.branch}`);
  }

  const mainRef = await api(
    `/repos/${context.repository}/git/ref/heads/${context.branch}`,
    token,
  );
  if (
    mainRef?.object?.type !== "commit" ||
    mainRef?.object?.sha !== context.sha
  ) {
    reject(
      `release SHA ${context.sha} is not the current ${context.branch} head`,
    );
  }

  for (const workflow of REQUIRED_WORKFLOWS) {
    const query = new URLSearchParams({
      branch: context.branch,
      head_sha: context.sha,
      per_page: "100",
      exclude_pull_requests: "true",
    });
    const payload = await api(
      `/repos/${context.repository}/actions/workflows/${encodeURIComponent(workflow.file)}/runs?${query}`,
      token,
    );
    const run = newestEligibleRun(workflow, payload?.workflow_runs, context);
    const jobsPayload = await api(
      `/repos/${context.repository}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`,
      token,
    );
    verifyRequiredJobs(workflow, jobsPayload?.jobs);
    console.log(
      `android release gate: ${workflow.label} run ${run.id} and required jobs passed for ${context.sha}`,
    );
  }

  console.log(
    `android release gate: all required workflows passed for current main ${context.sha}`,
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
  const context = verifyDispatchContext(validEnvironment);
  const successfulRun = {
    id: 11,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    created_at: "2026-08-10T00:00:00Z",
  };

  newestEligibleRun(REQUIRED_WORKFLOWS[0], [successfulRun], context);
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
  expectRejected("missing run", () =>
    newestEligibleRun(REQUIRED_WORKFLOWS[0], [], context),
  );
  expectRejected("running latest run", () =>
    newestEligibleRun(
      REQUIRED_WORKFLOWS[0],
      [
        successfulRun,
        {
          ...successfulRun,
          id: 12,
          status: "in_progress",
          conclusion: null,
          created_at: "2026-08-10T00:01:00Z",
        },
      ],
      context,
    ),
  );
  expectRejected("failed latest run", () =>
    newestEligibleRun(
      REQUIRED_WORKFLOWS[0],
      [{ ...successfulRun, conclusion: "failure" }],
      context,
    ),
  );
  expectRejected("wrong SHA", () =>
    newestEligibleRun(
      REQUIRED_WORKFLOWS[0],
      [{ ...successfulRun, head_sha: "b".repeat(40) }],
      context,
    ),
  );
  expectRejected("pull-request run cannot satisfy push gate", () =>
    newestEligibleRun(
      REQUIRED_WORKFLOWS[0],
      [{ ...successfulRun, event: "pull_request" }],
      context,
    ),
  );
  expectRejected("missing required job", () =>
    verifyRequiredJobs(REQUIRED_WORKFLOWS[0], []),
  );
  expectRejected("skipped required job", () =>
    verifyRequiredJobs(REQUIRED_WORKFLOWS[1], [
      { name: "audit", status: "completed", conclusion: "skipped" },
    ]),
  );
  newestEligibleRun(
    REQUIRED_WORKFLOWS[2],
    [{ ...successfulRun, event: "workflow_dispatch" }],
    context,
  );

  const liveEnvironment = { ...validEnvironment, GH_TOKEN: "self-test-token" };
  const runIds = new Map(
    REQUIRED_WORKFLOWS.map((workflow, index) => [workflow.file, 100 + index]),
  );
  const observedPaths = [];
  const mockedApi = async (path, token) => {
    if (token !== liveEnvironment.GH_TOKEN)
      reject("self-test received the wrong token");
    observedPaths.push(path);
    if (path === "/repos/owner/repository") return { default_branch: "main" };
    if (path === "/repos/owner/repository/git/ref/heads/main") {
      return { object: { type: "commit", sha } };
    }
    for (const workflow of REQUIRED_WORKFLOWS) {
      const workflowPrefix = `/repos/owner/repository/actions/workflows/${workflow.file}/runs?`;
      if (path.startsWith(workflowPrefix)) {
        return {
          workflow_runs: [
            {
              ...successfulRun,
              id: runIds.get(workflow.file),
              event: workflow.allowedEvents[0],
            },
          ],
        };
      }
      if (
        path ===
        `/repos/owner/repository/actions/runs/${runIds.get(workflow.file)}/jobs?per_page=100&filter=latest`
      ) {
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
  await verifyLiveGate(liveEnvironment, mockedApi);
  if (observedPaths.length !== 2 + REQUIRED_WORKFLOWS.length * 2) {
    throw new Error(
      "self-test did not exercise every release-gate API request",
    );
  }
  await expectRejectedAsync("stale main SHA", () =>
    verifyLiveGate(liveEnvironment, async (path, token) => {
      if (path === "/repos/owner/repository") return { default_branch: "main" };
      if (path === "/repos/owner/repository/git/ref/heads/main") {
        return { object: { type: "commit", sha: "b".repeat(40) } };
      }
      return mockedApi(path, token);
    }),
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
