// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginInteractionScope,
  hasRecoverableInteractionDraft,
  hasUnsavedInteraction,
  restoreInteractionDraft,
  saveInteractionDraft,
} from "./interactionDraft";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Values = {
  customer: string;
  notes: string;
  consent: boolean;
  method: string;
  region: string;
};
const EMPTY: Values = {
  customer: "",
  notes: "",
  consent: false,
  method: "cash",
  region: "Baghdad",
};
const SAVED: Values = {
  customer: "مسودة اختبار",
  notes: "ملاحظات قبل تحديث التطبيق",
  consent: true,
  method: "transfer",
  region: "Basra",
};

function ControlledForm({ initial }: { initial: Values }) {
  const [values, setValues] = useState(initial);
  const [revision, setRevision] = useState(0);
  const update = (key: keyof Values, value: string | boolean) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  return React.createElement(
    "form",
    { "data-revision": revision },
    React.createElement("input", {
      name: "customer",
      value: values.customer,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        update("customer", event.target.value),
    }),
    React.createElement("textarea", {
      name: "notes",
      value: values.notes,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        update("notes", event.target.value),
    }),
    React.createElement("input", {
      name: "consent",
      type: "checkbox",
      checked: values.consent,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        update("consent", event.target.checked),
    }),
    ...["cash", "transfer"].map((method) =>
      React.createElement("input", {
        key: method,
        name: "method",
        type: "radio",
        value: method,
        checked: values.method === method,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          update("method", event.target.value),
      }),
    ),
    React.createElement(
      "select",
      {
        name: "region",
        value: values.region,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          update("region", event.target.value),
      },
      ...["Baghdad", "Basra"].map((region) =>
        React.createElement("option", { key: region, value: region }, region),
      ),
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () => setRevision((previous) => previous + 1),
      },
      "rerender",
    ),
    React.createElement(
      "output",
      { "data-testid": "values" },
      JSON.stringify(values),
    ),
  );
}

describe("interaction draft recovery", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/draft-recovery-test");
    beginInteractionScope("/another-test");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });
  const render = (initial: Values) =>
    act(() => root.render(React.createElement(ControlledForm, { initial })));
  const values = (): Values =>
    JSON.parse(host.querySelector("output")!.textContent!);
  const remount = (initial: Values) => {
    act(() => root.unmount());
    root = createRoot(host);
    render(initial);
  };
  const recover = () => {
    let recovered = false;
    act(() => {
      recovered = restoreInteractionDraft();
    });
    expect(recovered).toBe(true);
  };

  it.each(["customer", "notes", "consent", "method", "region"] as const)(
    "restores controlled %s state and retains it after React rerender",
    (key) => {
      render(SAVED);
      expect(saveInteractionDraft()).toBe(true);
      remount(EMPTY);
      recover();
      expect(values()[key]).toBe(SAVED[key]);
      act(() => host.querySelector("button")!.click());
      expect(values()[key]).toBe(SAVED[key]);
      if (key === "consent") {
        expect(
          host.querySelector<HTMLInputElement>("[name=consent]")!.checked,
        ).toBe(true);
      } else if (key === "method") {
        expect(
          host.querySelector<HTMLInputElement>("[value=transfer]")!.checked,
        ).toBe(true);
      } else {
        expect(
          host.querySelector<
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          >(`[name=${key}]`)!.value,
        ).toBe(SAVED[key]);
      }
    },
  );

  it("restores unchecked checkbox and the first radio option", () => {
    render(EMPTY);
    expect(saveInteractionDraft()).toBe(true);
    remount(SAVED);
    recover();
    expect(values()).toEqual(EMPTY);
    act(() => host.querySelector("button")!.click());
    expect(
      host.querySelector<HTMLInputElement>("[name=consent]")!.checked,
    ).toBe(false);
    expect(host.querySelector<HTMLInputElement>("[value=cash]")!.checked).toBe(
      true,
    );
  });

  it("keeps stored draft available across recovery and another page mount", () => {
    render(SAVED);
    expect(saveInteractionDraft()).toBe(true);
    const stored = sessionStorage.getItem(
      "alroya.interaction-draft.v1:/draft-recovery-test",
    );
    remount(EMPTY);
    recover();
    expect(hasUnsavedInteraction()).toBe(true);
    expect(
      sessionStorage.getItem(
        "alroya.interaction-draft.v1:/draft-recovery-test",
      ),
    ).toBe(stored);
    remount(EMPTY);
    expect(hasRecoverableInteractionDraft()).toBe(true);
    recover();
    expect(values()).toEqual(SAVED);
    expect(
      sessionStorage.getItem(
        "alroya.interaction-draft.v1:/draft-recovery-test",
      ),
    ).toBe(stored);
  });

  it("never stores password, verification code, files or explicitly excluded fields", () => {
    host.innerHTML =
      '<input name="safe" value="keep"><input name="password" type="password" value="private"><input name="otp" autocomplete="one-time-code" value="private"><input name="file" type="file"><div data-no-draft><textarea name="excluded">private</textarea></div>';
    expect(saveInteractionDraft()).toBe(true);
    const stored = JSON.parse(
      sessionStorage.getItem(
        "alroya.interaction-draft.v1:/draft-recovery-test",
      )!,
    );
    expect(stored.fields).toHaveLength(1);
    expect(stored.fields[0]).toMatchObject({ key: "id:safe", value: "keep" });
    expect(JSON.stringify(stored)).not.toContain("private");
  });

  it("reports failed persistence without removing an existing draft", () => {
    render(SAVED);
    expect(saveInteractionDraft()).toBe(true);
    const stored = sessionStorage.getItem(
      "alroya.interaction-draft.v1:/draft-recovery-test",
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });
    expect(saveInteractionDraft()).toBe(false);
    expect(
      sessionStorage.getItem(
        "alroya.interaction-draft.v1:/draft-recovery-test",
      ),
    ).toBe(stored);
  });
});
