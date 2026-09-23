// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  url: "/my-work",
  listeners: new Set<() => void>(),
  enabled: {} as Record<string, boolean | undefined>,
  refetched: [] as string[],
  queries: {} as Record<
    string,
    {
      data: unknown;
      isLoading: boolean;
      isError: boolean;
      isFetching: boolean;
      error: Error | null;
    }
  >,
}));

function parseHarnessUrl() {
  return new URL(harness.url, "http://erp.test");
}

function setHarnessUrl(url: string, notify = true) {
  harness.url = url;
  window.history.replaceState(null, "", url);
  if (notify) for (const listener of harness.listeners) listener();
}

vi.mock("wouter", async () => {
  const ReactModule = await import("react");

  function subscribe(listener: () => void) {
    harness.listeners.add(listener);
    return () => harness.listeners.delete(listener);
  }

  function useHarnessUrl() {
    return ReactModule.useSyncExternalStore(
      subscribe,
      () => harness.url,
      () => harness.url,
    );
  }

  function navigate(to: string) {
    harness.url = to;
    window.history.pushState(null, "", to);
    for (const listener of harness.listeners) listener();
  }

  return {
    useLocation: () => {
      useHarnessUrl();
      return [parseHarnessUrl().pathname, navigate] as const;
    },
    useSearch: () => {
      useHarnessUrl();
      return parseHarnessUrl().search.slice(1);
    },
    Link: ({
      href,
      children,
      onClick,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
      ReactModule.createElement(
        "a",
        {
          ...props,
          href,
          onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
            onClick?.(event);
            if (!event.defaultPrevented) {
              event.preventDefault();
              navigate(href);
            }
          },
        },
        children,
      ),
  };
});

vi.mock("@/components/PageHeader", async () => {
  const ReactModule = await import("react");
  return {
    PageHeader: ({
      title,
      description,
      actions,
    }: {
      title: React.ReactNode;
      description?: React.ReactNode;
      actions?: React.ReactNode;
    }) =>
      ReactModule.createElement(
        "header",
        null,
        ReactModule.createElement("h1", null, title),
        ReactModule.createElement("p", null, description),
        actions,
      ),
  };
});

vi.mock("@/components/ui/AppSelect", async () => {
  const ReactModule = await import("react");
  return {
    AppSelect: ({
      value,
      onValueChange,
      children,
      ...props
    }: React.SelectHTMLAttributes<HTMLSelectElement> & {
      onValueChange: (value: string) => void;
    }) =>
      ReactModule.createElement(
        "select",
        {
          ...props,
          value,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            onValueChange(event.target.value),
        },
        children,
      ),
  };
});

vi.mock("@/components/decision/DecisionRow", async () => {
  const ReactModule = await import("react");
  return {
    DecisionRow: ({ row }: { row: { id: number; title: string } }) =>
      ReactModule.createElement(
        "div",
        { "data-testid": "decision-row", "data-id": row.id },
        row.title,
      ),
  };
});

vi.mock("@/lib/trpc", () => {
  function query(name: string, options?: { enabled?: boolean }) {
    harness.enabled[name] = options?.enabled;
    return {
      ...harness.queries[name],
      refetch: async () => {
        harness.refetched.push(name);
        return { data: harness.queries[name]?.data };
      },
    };
  }

  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    trpc: {
      branches: {
        list: {
          useQuery: (_input: unknown, options?: { enabled?: boolean }) =>
            query("branches", options),
        },
      },
      decisions: {
        inbox: {
          useQuery: (_input: unknown, options?: { enabled?: boolean }) =>
            query("decisions", options),
        },
      },
      superApp: {
        notifications: {
          useQuery: (_input: unknown, options?: { enabled?: boolean }) =>
            query("notifications", options),
        },
        myWorkspace: {
          useQuery: (_input: unknown, options?: { enabled?: boolean }) =>
            query("workspace", options),
        },
        markNotificationRead: { useMutation: mutation },
      },
      announcements: {
        mine: {
          useQuery: (_input: unknown, options?: { enabled?: boolean }) =>
            query("announcements", options),
        },
        markRead: { useMutation: mutation },
        acknowledge: { useMutation: mutation },
      },
    },
  };
});

import MyWork, {
  buildMyWorkTabHref,
  resolveMyWorkTab,
  sourcePanelState,
} from "../MyWork";

const decisionRow = {
  kind: "purchase.order.control",
  id: 17,
  title: "اعتماد أمر شراء",
  sla: null,
};

function ready(data: unknown) {
  return {
    data,
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
  };
}

function resetQueries() {
  harness.queries = {
    branches: ready([]),
    decisions: ready({
      rows: [decisionRow],
      total: 1,
      failedSources: [],
      kinds: [decisionRow.kind],
    }),
    workspace: ready({
      employee: {
        name: "سارة علي",
        position: "مبيعات",
        department: "المعرض",
      },
      tasks: [
        {
          id: 41,
          taskNumber: "TSK-41",
          title: "متابعة تجهيز الطلب",
          status: "IN_PROGRESS",
          priority: "HIGH",
          dueAt: null,
        },
      ],
    }),
    notifications: ready({
      rows: [
        {
          id: 71,
          title: "تحديث الإشعار",
          body: "اكتمل الإجراء",
          createdAt: "2026-09-17T08:00:00.000Z",
          route: "/tasks/41",
          requiresAction: false,
          readAt: null,
        },
      ],
      unreadCount: 1,
    }),
    announcements: ready({
      rows: [
        {
          id: 81,
          title: "توجيه اليوم",
          body: "يرجى مراجعة المهام",
          createdAt: "2026-09-17T07:00:00.000Z",
          expiresAt: null,
          readAt: null,
          requiresAck: false,
          acknowledgedAt: null,
        },
      ],
      unreadCount: 1,
    }),
  };
  harness.enabled = {};
  harness.refetched = [];
}

let container: HTMLDivElement;
let root: Root | undefined;

async function renderPage(url: string) {
  setHarnessUrl(url, false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(MyWork));
  });
}

async function clickTab(label: string) {
  const tab = Array.from(
    container.querySelectorAll<HTMLElement>('[role="tab"]'),
  ).find((element) => element.textContent?.includes(label));
  expect(tab).toBeTruthy();
  await act(async () => {
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  resetQueries();
  harness.listeners.clear();
  root = undefined;
  document.body.innerHTML = "";
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  vi.clearAllMocks();
});

describe("MyWork tab URL contract", () => {
  it("defaults to decisions and accepts the three explicit tabs", () => {
    expect(resolveMyWorkTab("", "")).toEqual({
      tab: "decisions",
      invalidTab: null,
      focusAnnouncements: false,
    });
    expect(resolveMyWorkTab("tab=decisions", "").tab).toBe("decisions");
    expect(resolveMyWorkTab("tab=tasks", "").tab).toBe("tasks");
    expect(resolveMyWorkTab("tab=updates", "").tab).toBe("updates");
  });

  it("keeps the legacy announcements deep link on updates with an explicit focus target", () => {
    expect(resolveMyWorkTab("", "#announcements")).toEqual({
      tab: "updates",
      invalidTab: null,
      focusAnnouncements: true,
    });
    expect(
      resolveMyWorkTab("tab=updates", "announcements").focusAnnouncements,
    ).toBe(true);
  });

  it("lets a valid explicit tab win over a stale legacy hash", () => {
    expect(resolveMyWorkTab("tab=tasks", "#announcements")).toEqual({
      tab: "tasks",
      invalidTab: null,
      focusAnnouncements: false,
    });
  });

  it("falls back visibly and safely when tab is invalid", () => {
    expect(resolveMyWorkTab("tab=forbidden", "")).toEqual({
      tab: "decisions",
      invalidTab: "forbidden",
      focusAnnouncements: false,
    });
  });

  it("writes a shareable tab URL while preserving unrelated query parameters", () => {
    expect(
      buildMyWorkTabHref("/my-work", "source=bell&tab=updates", "tasks"),
    ).toBe("/my-work?source=bell&tab=tasks");
  });
});

describe("MyWork component wiring", () => {
  it("keeps decisions intact, navigates by URL, and enables only the active source", async () => {
    await renderPage("/my-work");

    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toContain("قرارات");
    expect(
      container.querySelector('[data-testid="decision-row"]')?.textContent,
    ).toBe("اعتماد أمر شراء");
    expect(container.textContent).toContain("كل الأعمار");
    expect(harness.enabled).toMatchObject({
      decisions: true,
      branches: true,
      workspace: false,
      notifications: false,
      announcements: false,
    });

    await clickTab("مهامي");
    expect(harness.url).toBe("/my-work?tab=tasks");
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toContain("مهامي");
    expect(harness.enabled).toMatchObject({
      decisions: false,
      branches: false,
      workspace: true,
      notifications: false,
      announcements: false,
    });
    expect(
      container.querySelector('a[href="/tasks/41"]')?.textContent,
    ).toContain("متابعة تجهيز الطلب");
    expect(container.querySelector('a[href="/tasks?tab=mine"]')).not.toBeNull();

    await act(async () => setHarnessUrl("/my-work?tab=decisions"));
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toContain("قرارات");
    expect(
      container.querySelector('[data-testid="decision-row"]'),
    ).not.toBeNull();
  });

  it("restores an explicit tab on refresh", async () => {
    await renderPage("/my-work?tab=tasks");
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toContain("مهامي");
    expect(harness.enabled.workspace).toBe(true);
    expect(harness.enabled.decisions).toBe(false);
  });

  it("opens and focuses updates for the legacy announcements hash", async () => {
    await renderPage("/my-work#announcements");
    const announcements =
      container.querySelector<HTMLElement>("#announcements");

    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toContain("تحديثات");
    expect(announcements).not.toBeNull();
    expect(document.activeElement).toBe(announcements);
    expect(harness.enabled.notifications).toBe(true);
    expect(harness.enabled.announcements).toBe(true);
    expect(harness.enabled.decisions).toBe(false);
  });

  it("shows one update-source failure without hiding the other source", async () => {
    harness.queries.announcements = {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      error: new Error("تعذر مصدر الإعلانات"),
    };
    await renderPage("/my-work?tab=updates");

    expect(container.textContent).toContain("تعذّر تحميل الإعلانات");
    expect(container.textContent).toContain("تحديث الإشعار");
    expect(container.textContent).not.toContain("لا توجد إعلانات موجهة إليك");
  });
});

describe("MyWork independent update-source states", () => {
  it("does not turn an error into an empty state", () => {
    expect(
      sourcePanelState({ isLoading: false, isError: true, count: 0 }),
    ).toBe("error");
    expect(sourcePanelState({ isLoading: true, isError: true, count: 0 })).toBe(
      "error",
    );
  });

  it("keeps one failed source independent from another ready source", () => {
    const notifications = sourcePanelState({
      isLoading: false,
      isError: true,
      count: 0,
    });
    const announcements = sourcePanelState({
      isLoading: false,
      isError: false,
      count: 2,
    });

    expect({ notifications, announcements }).toEqual({
      notifications: "error",
      announcements: "ready",
    });
  });

  it("distinguishes loading, empty, and ready", () => {
    expect(
      sourcePanelState({ isLoading: true, isError: false, count: 0 }),
    ).toBe("loading");
    expect(
      sourcePanelState({ isLoading: false, isError: false, count: 0 }),
    ).toBe("empty");
    expect(
      sourcePanelState({ isLoading: false, isError: false, count: 1 }),
    ).toBe("ready");
  });
});
