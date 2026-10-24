import React from "react";
import AftercareWorkspace from "./AftercareWorkspace";

export type AftercareStationProps = {
  scannedBarcode?: string | null;
  onBarcodeConsumed?: () => void;
  branchId?: number;
  caseId?: number;
  executionId?: number;
};

/** The normal barcode station embeds the complete case; no secondary tabs or navigation. */
export function AftercareStation(props: AftercareStationProps) {
  return <AftercareWorkspace {...props} />;
}
