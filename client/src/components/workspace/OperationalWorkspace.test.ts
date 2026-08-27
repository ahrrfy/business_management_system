import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceBar, WorkspaceStatusBar } from "./OperationalWorkspace";

describe("OperationalWorkspace", () => {
  it("يثبت عقد شريط الأوامر ودلالته", () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkspaceBar,
        { variant: "command", label: "أوامر الفواتير" },
        "الفواتير",
      ),
    );
    expect(html).toContain('data-workspace-bar="command"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="أوامر الفواتير"');
    expect(html).toContain("workspace-command-bar");
  });

  it("يفصل شريط الحالة عن toolbar العلوي", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceStatusBar, null, "١–٥٠ من ١٢٣"),
    );
    expect(html).toContain('data-workspace-bar="status"');
    expect(html).not.toContain('role="toolbar"');
    expect(html).toContain('role="status"');
    expect(html).toContain("workspace-status-bar");
  });
});
