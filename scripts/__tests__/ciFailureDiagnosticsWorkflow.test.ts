import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  process.cwd(),
  ".github/workflows/ci-failure-diagnostics.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

describe("CI failure diagnostics workflow policy", () => {
  it("يعالج التشغيل المكتمل للفرع الافتراضي فقط مع إدخال يدوي محكوم", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("types: [completed]");
    expect(workflow).toContain(
      "github.event.workflow_run.head_branch == github.event.repository.default_branch",
    );
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain('run.event !== "push"');
    expect(workflow).toContain(
      "run.head_repository?.full_name !== repositoryFullName",
    );
    expect(workflow).toContain(
      '"success","failure","timed_out","action_required"',
    );
    expect(workflow).not.toContain("workflow_run.conclusion != 'success'");
    expect(workflow).toContain("run_id:");
  });

  it("يستخدم هوية مستقرة لكل workflow وفرع ويغلق القضية عند عودة CI إلى الأخضر", () => {
    expect(workflow).toContain("ci-failure-diagnostic:key:");
    expect(workflow).toContain("ci-failure-diagnostic:order:");
    expect(workflow).toContain('.toString("base64url")');
    expect(workflow).toContain("github.rest.actions.listWorkflowRuns");
    expect(workflow).toContain("run.run_number");
    expect(workflow).toContain("github.paginate");
    expect(workflow).toContain('state: "all"');
    expect(workflow).toContain("github.rest.issues.update");
    expect(workflow).toContain('state: "open"');
    expect(workflow).toContain('state: "closed"');
    expect(workflow).toContain('state_reason: "completed"');
    expect(workflow).toContain("github.rest.issues.create");
    expect(workflow).not.toContain("ci-failure-diagnostic:run-${run.id}");
  });

  it("يحصر الصلاحيات في قراءة Actions وإنشاء Issue تشخيصي", () => {
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("issues: write");
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/pull-requests:\s*write/);
    expect(workflow).not.toMatch(/deployments:\s*write/);
  });

  it("لا يحتوي آليات تعديل المستودع أو دمج أو نشر أو migrations", () => {
    expect(workflow).toContain("github.rest.issues.create");
    expect(workflow).toContain("getWorkflowRun");
    expect(workflow).toContain("listJobsForWorkflowRun");
    expect(workflow).not.toMatch(/git\s+(push|commit|merge|checkout|apply)/i);
    expect(workflow).not.toMatch(
      /createPullRequest|pulls\.create|mergePullRequest/i,
    );
    expect(workflow).not.toMatch(
      /prod:deploy|db:migrate|migration reserve|eas build/i,
    );
  });
});
