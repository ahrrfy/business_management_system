// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageUploader, type ImageItem } from "../ImageUploader";

(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let readers: any[];
let changed: ReturnType<typeof vi.fn>;
const initial: ImageItem[] = [
  { id: "a", dataUrl: "data:image/png;base64,AAAA", name: "الأولى", isPrimary: true },
  { id: "b", dataUrl: "data:image/png;base64,AAAA", name: "الثانية", isPrimary: false },
];
function Harness() {
  const [images, setImages] = useState(initial);
  return <ImageUploader value={images} onChange={(next) => { changed(next); setImages(next); }} maxItems={3} />;
}
const card = (name: string) => document.querySelector<HTMLImageElement>(`img[alt="${name}"]`)!.parentElement!.parentElement!;
const button = (container: ParentNode, label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label))!;
async function pick(camera = false, files = [new File(["x"], "جديدة.png", { type: "image/png" })]) {
  const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[camera ? 1 : 0];
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
async function finish(index = 0, fail = false) {
  await act(async () => {
    const reader = readers[index];
    reader.result = "data:image/png;base64,AAAA";
    if (fail) reader.onerror(); else reader.onload();
  });
}
beforeEach(async () => {
  readers = []; changed = vi.fn();
  vi.stubGlobal("FileReader", class { result = ""; error = new Error("read failed"); onload = () => {}; onerror = () => {}; onabort = () => {}; readAsDataURL() { readers.push(this); } });
  // Exercise the documented compression fallback without a canvas in jsdom.
  vi.stubGlobal("Image", class { onerror = () => {}; set src(_: string) { queueMicrotask(() => this.onerror()); } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("does not resurrect a removed image after asynchronous decoding", async () => {
  await pick();
  act(() => button(card("الأولى"), "إزالة").click());
  await finish();
  expect(changed.mock.lastCall![0].map((image: ImageItem) => image.id)).not.toContain("a");
});
it("preserves primary changes made while decoding", async () => {
  await pick(); act(() => button(card("الثانية"), "اجعلها رئيسية").click()); await finish();
  expect(changed.mock.lastCall![0].find((image: ImageItem) => image.isPrimary).id).toBe("b");
});
it("keeps a recaptured primary image in its original slot", async () => {
  act(() => button(card("الأولى"), "إعادة الالتقاط").click()); await pick(true); await finish();
  const images: ImageItem[] = changed.mock.lastCall![0];
  expect(images[0].name).toBe("جديدة.png"); expect(images[0].isPrimary).toBe(true); expect(images[1].id).toBe("b");
});
it("enforces accept for dropped files as well as the file picker", async () => {
  await pick(false, [new File(["gif"], "غيرمدعومة.gif", { type: "image/gif" })]);
  expect(readers).toHaveLength(0); expect(document.body.textContent).toContain("صيغ غير مدعومة");
});
it("serializes intake until decoding completes", async () => {
  await pick(); await pick(); expect(readers).toHaveLength(1); await finish();
});
it("does not publish an upload after unmount", async () => {
  await pick(); act(() => root.render(<div />)); await finish(); expect(changed).not.toHaveBeenCalled();
});
it("reports reader failure and unlocks the picker for retry", async () => {
  await pick(); await finish(0, true);
  expect(changed).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("فشل القراءة");
  expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(false);
  await pick(); expect(readers).toHaveLength(2); await finish(1);
  expect(changed).toHaveBeenCalledOnce();
});
it("does not restore a recapture target removed during decoding", async () => {
  act(() => button(card("الأولى"), "إعادة الالتقاط").click()); await pick(true);
  act(() => button(card("الأولى"), "إزالة").click()); await finish();
  expect(changed).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain("حُذفت الصورة المستهدفة");
});
it("does not mutate the caller's images when choosing a fallback primary", () => {
  act(() => button(card("الأولى"), "إزالة").click());
  expect(initial[1].isPrimary).toBe(false);
  expect(changed.mock.lastCall![0][0].isPrimary).toBe(true);
});
