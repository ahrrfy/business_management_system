import { Children, createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MobileDataCard } from "./MobileDataCard";

describe("MobileDataCard accessibility", () => {
  it("exposes the card-wide action as a native, named button", () => {
    const html = renderToStaticMarkup(createElement(MobileDataCard, {
      title: "INV-42",
      onClick: vi.fn(),
    }));

    expect(html).toContain('<button type="button" aria-label="فتح تفاصيل INV-42"');
  });

  it("accepts an explicit accessible name for non-text titles", () => {
    const html = renderToStaticMarkup(createElement(MobileDataCard, {
      title: createElement("span", null, "أمر خاص"),
      ariaLabel: "فتح أمر الشغل 77",
      onClick: vi.fn(),
    }));

    expect(html).toContain('aria-label="فتح أمر الشغل 77"');
  });

  it("keeps the card-wide action separate from nested quick actions", () => {
    const html = renderToStaticMarkup(createElement(MobileDataCard, {
      title: "INV-42",
      onClick: vi.fn(),
      primaryAction: {
        label: "طباعة",
        onClick: vi.fn(),
      },
    }));

    expect(html.match(/<button\b/g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="فتح تفاصيل INV-42"[^>]*><\/button>/);
  });

  it("stops the native card action from bubbling into the compatibility click handler", () => {
    const onClick = vi.fn();
    const stopPropagation = vi.fn();
    const card = MobileDataCard({ title: "INV-42", onClick }) as ReactElement<{ children: ReactNode }>;
    const cardAction = Children.toArray(card.props.children)[0] as ReactElement<{
      onClick: (event: { stopPropagation: () => void }) => void;
    }>;

    cardAction.props.onClick({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not add an interactive control when onClick is absent", () => {
    const html = renderToStaticMarkup(createElement(MobileDataCard, {
      title: "INV-42",
    }));

    expect(html).not.toContain("<button");
  });
});
