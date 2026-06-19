import type { CashDrawerConfig, PrinterConfig } from "../types.js";
import { printSpooler } from "./spooler.js";
import { printNetwork } from "./network.js";

// Default ESC/POS cash-drawer kick command: ESC p m t1 t2 = 1B 70 00 19 30
// Compatible with Epson, Star, BIXOLON, Citizen, Brother and most clones.
const DEFAULT_PULSE_HEX = "1B70001930";

function hexToBytes(hex: string): Buffer {
  const clean = hex.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`pulseHex قيمة غير صحيحة: ${hex}`);
  }
  return Buffer.from(clean, "hex");
}

/**
 * Open the cash drawer by sending a kick command through the configured receipt printer.
 * (The drawer is wired to the printer via RJ-11 — software just tells the printer to pulse the line.)
 */
export async function openCashDrawer(
  cashDrawer: CashDrawerConfig | undefined,
  receiptPrinter: PrinterConfig | undefined,
): Promise<{ method: string }> {
  if (!cashDrawer || cashDrawer.method === "none") {
    throw new Error("درج النقد غير مُكوَّن.");
  }
  if (cashDrawer.method === "manual") {
    return { method: "manual" }; // caller's UI handles physical opening
  }
  if (!receiptPrinter) {
    throw new Error("لا توجد طابعة إيصالات مُكوَّنة لإرسال إشارة فتح الدرج.");
  }
  const pulse = hexToBytes(cashDrawer.pulseHex || DEFAULT_PULSE_HEX);
  switch (receiptPrinter.mode) {
    case "spooler":
      await printSpooler(receiptPrinter.spoolerName, pulse, "AlroyaERP-OpenDrawer");
      return { method: "kickout-via-spooler" };
    case "network":
      await printNetwork(receiptPrinter.host, receiptPrinter.port, pulse);
      return { method: "kickout-via-network" };
    default:
      throw new Error("نمط طابعة غير معروف.");
  }
}
