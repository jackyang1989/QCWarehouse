"use client";

import type { Row } from "./ui";

type ItemOverride = Partial<Record<"sku"|"size"|"color"|"supplier"|"tracking_no",string>>;
export type DraftEditor = {
  step:number;
  categoryKey:string;
  serviceKind:"inspection"|"compare"|"reference_match";
  selectedOfferId:string;
  templateVariant:string;
  qty:number;
  manualQuoteMode:boolean;
  manualBatchQty:number;
  manualQuoteReason:string;
  itemName:string;
  supplierRef:string;
  baseSku:string;
  baseColor:string;
  baseSize:string;
  baseTrackingNo:string;
  productLink:string;
  toleranceMode:"record_only"|"custom";
  pointTolerances:Record<string,{target:string;plusMinus:string}>;
  referenceId:string;
  sizeMismatchConfirmed:boolean;
  itemRows:ItemOverride[];
  notes:string;
  attachmentId?:string;
  attachmentName?:string;
  extraLines:Row[];
};

type DraftWrite = {fingerprint:string;key:string};
export type DraftRecovery = {
  revision:number|null;
  editor:DraftEditor;
  write:DraftWrite|null;
};

const prefix="qcw.inspection-draft.";

export function draftRecoveryKey(customerId:string,reference:string) {
  return prefix+customerId+"."+reference;
}

export function readDraftRecovery(key:string):DraftRecovery|null {
  try {
    const snapshot=JSON.parse(sessionStorage.getItem(key)??"null") as DraftRecovery|null;
    return snapshot?.editor&&Array.isArray(snapshot.editor.itemRows)&&Array.isArray(snapshot.editor.extraLines)?snapshot:null;
  } catch {
    return null;
  }
}

export function writeDraftRecovery(key:string,value:DraftRecovery) {
  try {sessionStorage.setItem(key,JSON.stringify(value));} catch { /* Server saving remains available. */ }
}

export function removeDraftRecovery(key:string) {
  try {sessionStorage.removeItem(key);} catch { /* Browser storage may be disabled. */ }
}

export function clearCustomerDraftRecovery(customerId:string) {
  try {
    const ownPrefix=prefix+customerId+".";
    for(let index=sessionStorage.length-1;index>=0;index--) {
      const key=sessionStorage.key(index);
      if(key?.startsWith(ownPrefix)) sessionStorage.removeItem(key);
    }
  } catch { /* Browser storage may be disabled. */ }
}
