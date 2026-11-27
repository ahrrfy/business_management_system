// Local-only browser harness. Actual ZXing decoding, synthetic camera pixels; no API calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CameraScanner } from "@/components/scan/CameraScanner";
import { code128Svg, eanSvg } from "@/lib/printing/barcode";
import { QRCodeWriter, BarcodeFormat } from "@zxing/library";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { observable } from "@trpc/server/observable";
import { trpc } from "@/lib/trpc";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const client = trpc.createClient({ links: [() => () => observable(observer => {
  observer.next({ result: { data: { id: 1, role: "photographer" } } });
  observer.complete();
})] });

const cases = [
  ["CODE128", "ALR00001234"], ["CODE128", "000012345678"],
  ["CODE128", "1  0095"], ["EAN13", "5901234123457"],
  ["EAN8", "96385074"], ["QR", "ALR00009876"],
] as const;
const streams: MediaStream[] = [];
let fixture = cases[0] as readonly [string, string];
let rejectNative = false;
let delayedNative = false;
let delayedStream = false;
let closePending: (() => void) | undefined;
Object.defineProperty(window, "BarcodeDetector", { configurable: true, get: () => rejectNative ? class {
  async detect() { throw new Error("native runtime failure"); }
} : delayedNative ? class {
  async detect() {
    closePending?.();
    await new Promise(resolve => setTimeout(resolve, 200));
    return [{ rawValue: "STALE-READ" }];
  }
} : undefined });
Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1280, 720);
  if (fixture[0] === "QR") {
    const matrix = new QRCodeWriter().encode(fixture[1], BarcodeFormat.QR_CODE, 400, 400, new Map());
    ctx.fillStyle = "black";
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) if (matrix.get(x, y)) ctx.fillRect(x + 440, y + 160, 1, 1);
  } else {
    const rendered = (fixture[0].startsWith("EAN") ? eanSvg : code128Svg)(fixture[1], { moduleWidth: 3, height: 200, showText: false });
    const img = new Image();
    img.src = `data:image/svg+xml,${encodeURIComponent(rendered.svg)}`;
    await img.decode();
    ctx.drawImage(img, (1280 - rendered.widthPx) / 2, 260);
  }
  const stream = canvas.captureStream(15);
  streams.push(stream);
  const timer = setInterval(() => ctx.drawImage(canvas, 0, 0), 60);
  setTimeout(() => clearInterval(timer), 5000);
  if (delayedStream) {
    closePending?.();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return stream;
} });

function Harness() {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const start = (index: number, failingNative = false) => {
    fixture = cases[index]; rejectNative = failingNative;
    delayedNative = false; delayedStream = false;
    setCurrent(index); setOpen(true);
  };
  return <main>
    <h1>Camera decoder browser verification</h1>
    {cases.map(([format, value], index) => <button key={index} onClick={() => start(index)}>{format}: {value}</button>)}
    <button onClick={() => start(0, true)}>Native failure fallback</button>
    {["native", "stream"].map(mode => <button key={mode} onClick={() => {
      fixture = cases[0]; rejectNative = false;
      delayedNative = mode === "native"; delayedStream = mode === "stream";
      closePending = () => {
        setOpen(false);
        setTimeout(() => setResults(previous => [...previous,
          `${streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")) ? "PASS" : "FAIL"}: cancelled ${mode}`]), 400);
      };
      setOpen(true);
    }}>Cancel pending {mode}</button>)}
    <button onClick={() => setOpen(false)}>Close scanner</button>
    <CameraScanner open={open} onClose={() => setOpen(false)} onDetect={(code) => {
      setOpen(false);
      const ended = streams.every(stream => stream.getTracks().every(track => track.readyState === "ended"));
      setResults(previous => [...previous, `${code === cases[current][1] && ended ? "PASS" : "FAIL"}: ${JSON.stringify(code)} tracksEnded=${ended}`]);
    }} />
    <pre id="results">{results.join("\n")}</pre>
  </main>;
}
createRoot(document.getElementById("root")!).render(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><Harness /></QueryClientProvider></trpc.Provider>);
