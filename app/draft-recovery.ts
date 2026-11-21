"use client";

import type { Row } from "./ui";

export type ItemOverride = Partial<Record<"sku"|"size"|"color"|"supplier"|"tracking_no",string>>;

export type ExpectedProductLine = {
  id:string;
  sku_code:string;
  product_name:string;
  color_declared:string;
  size_label:string;
  quantity:number;
  supplier_alias:string;
  purchase_order_ref?:string;
  unit_price_note?:string;
  tracking_no?:string;
  carrier_code?:string;
  carton_no?:string;
  inspection_note?:string;
  evidence_ids?:string[];
  source_file_name?:string;
  edited_by_user?:boolean;
  source_kind?:"manual"|"paste"|"evidence_extract"|"matrix";
};

export type ExtractedCandidateLine = ExpectedProductLine & {
  evidence_id:string;
  ocr_candidate_id?:string;
  ocr_confidence_score?:number;
  bbox?:{page:number;rect:[number,number,number,number]}|null;
  status?:"unconfirmed"|"confirmed"|"discarded";
  source_evidence_id?:string;
  source_file_name?:string;
  edited_by_user?:boolean;
  confidence:"structured"|"needs_review";
  needs_confirmation:boolean;
  missing_fields:string[];
  selected:boolean;
  confirmed:boolean;
  raw_source?:string;
};

export type PurchaseEvidencePurpose = "purchase_evidence"|"reference_photo"|"size_chart";

export type PurchaseEvidenceItem = {
  id:string;
  media_id?:string;
  ocr_job_id?:string;
  ocr_provider?:string;
  ocr_confidence?:number;
  ocr_latency_ms?:number;
  ocr_raw_text?:string;
  ocr_warnings?:string[];
  preview_url?:string;
  file_name:string;
  mime_type:string;
  size_bytes:number;
  sha256:string;
  purpose?:PurchaseEvidencePurpose;
  supplier_alias:string;
  platform_source:string;
  purchase_order_ref:string;
  uploaded_at:string;
  extraction_status:"needs_confirmation"|"confirmed"|"manual_only"|"pending_reassociation"|"extracting"|"failed";
  extraction_note?:string;
  candidates:ExtractedCandidateLine[];
};

export type ParcelLineAllocation = {
  expected_line_id:string;
  quantity:number;
};

export type PlannedParcelEntry = {
  id:string;
  tracking_no:string;
  carrier_code:string;
  supplier_alias:string;
  carton_count:number;
  contains_all_items:boolean;
  contents_unknown?:boolean;
  allocations:ParcelLineAllocation[];
  note?:string;
};

export type ParcelMode = "single"|"multi"|"later";

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
  expectedLines?:ExpectedProductLine[];
  purchaseEvidences?:PurchaseEvidenceItem[];
  plannedParcels?:PlannedParcelEntry[];
  parcelMode?:ParcelMode;
  syncQuantityFromLines?:boolean;
  notes:string;
  attachmentId?:string;
  attachmentName?:string;
  attachmentPurpose?:"reference_photo"|"size_chart";
  attachmentSha256?:string;
  extraLines:Row[];
  addingServiceLine?:boolean;
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

export function normalizeTrackingCode(value:unknown):string {
  return String(value??"").replace(/\s+/g,"").toUpperCase();
}

export function sumExpectedLineQuantity(lines:ExpectedProductLine[]):number {
  return lines.reduce((sum,line)=>sum+Math.max(0,Math.floor(Number(line.quantity)||0)),0);
}

export function missingLineFields(line:{sku_code?:string;product_name?:string;color_declared?:string;size_label?:string;quantity?:number}):string[] {
  const missing:string[]=[];
  if(!line.product_name?.trim() && !line.sku_code?.trim()) missing.push("product_name");
  if(!line.color_declared?.trim()) missing.push("color");
  if(!line.size_label?.trim()) missing.push("size");
  if(!Number.isInteger(line.quantity) || Number(line.quantity)<=0) missing.push("quantity");
  return missing;
}

export async function sha256FileHex(file:File):Promise<string> {
  const buf=await file.arrayBuffer();
  if(typeof crypto!=="undefined" && crypto.subtle) {
    const digest=await crypto.subtle.digest("SHA-256",buf);
    return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
  }
  // Lightweight deterministic fallback fingerprint if WebCrypto subtle is unavailable
  const view=new Uint8Array(buf);
  let h1=0x811c9dc5,h2=0x9e3779b1;
  for(let i=0;i<view.length;i++) {
    h1^=view[i];
    h1=Math.imul(h1,0x01000193)>>>0;
    h2^=view[i]+(i&255);
    h2=Math.imul(h2,0x85ebca6b)>>>0;
  }
  return `${file.size.toString(16).padStart(8,"0")}-${h1.toString(16).padStart(8,"0")}-${h2.toString(16).padStart(8,"0")}`;
}

export function expandExpectedLinesToDraftItems(params:{
  expectedLines:ExpectedProductLine[];
  plannedParcels:PlannedParcelEntry[];
  parcelMode:ParcelMode;
  itemRows:ItemOverride[];
  effectiveQty:number;
  defaults:{
    itemName:string;
    supplierRef:string;
    baseSku:string;
    baseColor:string;
    baseSize:string;
    baseTrackingNo:string;
    garmentType?:string;
    attachmentIds:string[];
  };
}):Record<string,unknown>[] {
  const {expectedLines,plannedParcels,parcelMode,itemRows,effectiveQty,defaults}=params;
  const activeLines=expectedLines.filter(l=>Math.max(0,Math.floor(Number(l.quantity)||0))>0);

  if(activeLines.length===0) {
    return Array.from({length:effectiveQty},(_,idx)=>{
      const custom=itemRows[idx];
      const rowSku=custom?.sku?.trim()||`${defaults.baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
      const rowSize=(custom?.size??defaults.baseSize).trim();
      const rowColor=(custom?.color??defaults.baseColor).trim();
      const rowSupplier=(custom?.supplier??defaults.supplierRef).trim();
      const singleParcelTrack=parcelMode==="single"?normalizeTrackingCode(plannedParcels[0]?.tracking_no):"";
      const rowTracking=parcelMode==="later"
        ?normalizeTrackingCode(custom?.tracking_no??"")
        :normalizeTrackingCode(custom?.tracking_no??(singleParcelTrack||defaults.baseTrackingNo));
      const rowCarrier=parcelMode==="single"?(plannedParcels[0]?.carrier_code??"").trim():"";
      return {
        position:idx+1,
        sample_code:rowSku.slice(0,40),
        ...(defaults.itemName.trim()?{name:defaults.itemName.trim().slice(0,120)}:{}),
        ...(rowSize||custom?.size!==undefined?{size_label:rowSize}:{}),
        ...(rowColor||custom?.color!==undefined?{color_declared:rowColor}:{}),
        ...(rowSupplier||custom?.supplier!==undefined?{supplier_alias:rowSupplier}:{}),
        ...(rowTracking||custom?.tracking_no!==undefined?{tracking_no:rowTracking,declared_tracking_no:rowTracking}:{}),
        ...(rowCarrier?{carrier_code:rowCarrier}:{}),
        ...(defaults.garmentType?{garment_type:defaults.garmentType}:{}),
        ...(defaults.attachmentIds.length?{attachment_ids:defaults.attachmentIds}:{}),
      };
    });
  }

  // Build per-line parcel assignment sequence
  const parcelAssignments=new Map<string,Array<{tracking_no:string;carrier_code:string;carton_no?:string}>>();
  const singleParcelTrack=parcelMode==="single"?normalizeTrackingCode(plannedParcels[0]?.tracking_no):"";
  const singleParcelCarrier=parcelMode==="single"?String(plannedParcels[0]?.carrier_code??"").trim():"";

  if(parcelMode==="multi") {
    for(const line of activeLines) {
      const seq:Array<{tracking_no:string;carrier_code:string;carton_no?:string}>=[];
      for(const parcel of plannedParcels) {
        const tn=normalizeTrackingCode(parcel.tracking_no);
        if(!tn||parcel.contents_unknown) continue;
        if(parcel.contains_all_items) {
          for(let k=0;k<line.quantity;k++) seq.push({tracking_no:tn,carrier_code:parcel.carrier_code,carton_no:parcel.note});
          break;
        }
        const alloc=parcel.allocations.find(a=>a.expected_line_id===line.id);
        const allocQty=Math.max(0,Math.floor(Number(alloc?.quantity??0)||0));
        for(let k=0;k<allocQty && seq.length<line.quantity;k++) {
          seq.push({tracking_no:tn,carrier_code:parcel.carrier_code,carton_no:parcel.note});
        }
      }
      parcelAssignments.set(line.id,seq);
    }
  }

  const expanded:Record<string,unknown>[]=[];
  let pos=0;
  for(const line of activeLines) {
    const count=Math.max(1,Math.floor(Number(line.quantity)||0));
    const seq=parcelAssignments.get(line.id)??[];
    for(let i=0;i<count && expanded.length<effectiveQty;i++) {
      const idx=pos++;
      const custom=itemRows[idx];
      const prefixCode=(line.sku_code||defaults.baseSku||"ITEM").trim();
      const defaultSampleCode=count===1 && line.sku_code?.trim()?prefixCode:`${prefixCode}-${String(i+1).padStart(2,"0")}`;
      const rowSku=(custom?.sku?.trim()||defaultSampleCode).slice(0,40);
      const rowName=(line.product_name||defaults.itemName).trim();
      const rowSize=(custom?.size??line.size_label??defaults.baseSize).trim();
      const rowColor=(custom?.color??line.color_declared??defaults.baseColor).trim();
      const rowSupplier=(custom?.supplier??line.supplier_alias??defaults.supplierRef).trim();
      const assigned=seq[i];
      const rowTracking=parcelMode==="later"
        ?normalizeTrackingCode(custom?.tracking_no??"")
        :normalizeTrackingCode(
          custom?.tracking_no ??
          assigned?.tracking_no ??
          (singleParcelTrack || line.tracking_no || defaults.baseTrackingNo)
        );
      const rowCarrier=(assigned?.carrier_code||singleParcelCarrier||line.carrier_code||"").trim();
      const mergedAttachments=[...new Set([...(line.evidence_ids??[]),...defaults.attachmentIds])];
      expanded.push({
        position:idx+1,
        expected_line_id:line.id,
        sample_code:rowSku,
        ...(line.sku_code?.trim()?{sku_code:line.sku_code.trim()}:{}),
        ...(rowName?{name:rowName.slice(0,120)}:{}),
        ...(rowSize?{size_label:rowSize}:{}),
        ...(rowColor?{color_declared:rowColor}:{}),
        ...(rowSupplier?{supplier_alias:rowSupplier}:{}),
        ...(line.purchase_order_ref?.trim()?{purchase_order_ref:line.purchase_order_ref.trim()}:{}),
        ...(rowTracking?{tracking_no:rowTracking,declared_tracking_no:rowTracking}:{}),
        ...(rowCarrier?{carrier_code:rowCarrier}:{}),
        ...(line.carton_no?.trim()||assigned?.carton_no?{carton_no:line.carton_no?.trim()||assigned?.carton_no}:{}),
        ...(line.inspection_note?.trim()?{notes:line.inspection_note.trim().slice(0,300)}:{}),
        ...(defaults.garmentType?{garment_type:defaults.garmentType}:{}),
        ...(mergedAttachments.length?{attachment_ids:mergedAttachments}:{}),
      });
    }
  }

  // If effectiveQty > sum(expectedLines), pad remaining items with defaults
  while(expanded.length<effectiveQty) {
    const idx=expanded.length;
    const custom=itemRows[idx];
    const rowSku=custom?.sku?.trim()||`${defaults.baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
    const rowSize=(custom?.size??defaults.baseSize).trim();
    const rowColor=(custom?.color??defaults.baseColor).trim();
    const rowSupplier=(custom?.supplier??defaults.supplierRef).trim();
    const rowTracking=parcelMode==="later"
      ?normalizeTrackingCode(custom?.tracking_no??"")
      :normalizeTrackingCode(custom?.tracking_no??(singleParcelTrack||defaults.baseTrackingNo));
    expanded.push({
      position:idx+1,
      sample_code:rowSku.slice(0,40),
      ...(defaults.itemName.trim()?{name:defaults.itemName.trim().slice(0,120)}:{}),
      ...(rowSize?{size_label:rowSize}:{}),
      ...(rowColor?{color_declared:rowColor}:{}),
      ...(rowSupplier?{supplier_alias:rowSupplier}:{}),
      ...(rowTracking?{tracking_no:rowTracking,declared_tracking_no:rowTracking}:{}),
      ...(defaults.garmentType?{garment_type:defaults.garmentType}:{}),
      ...(defaults.attachmentIds.length?{attachment_ids:defaults.attachmentIds}:{}),
    });
  }
  return expanded;
}

export function deriveExpectedLinesFromServerLine(line:Row):ExpectedProductLine[] {
  const attrs=(line.attributes??{}) as Record<string,unknown>;
  if(Array.isArray(attrs.expected_lines) && attrs.expected_lines.length>0) {
    return (attrs.expected_lines as Record<string,unknown>[]).map((el,idx)=>({
      id:String(el.id??`EL-${idx+1}`),
      sku_code:String(el.sku_code??""),
      product_name:String(el.product_name??attrs.name??""),
      color_declared:String(el.color_declared??""),
      size_label:String(el.size_label??""),
      quantity:Math.max(1,Number(el.quantity??1)||1),
      supplier_alias:String(el.supplier_alias??attrs.supplier_alias??attrs.supplier_ref??""),
      purchase_order_ref:String(el.purchase_order_ref??""),
      unit_price_note:String(el.unit_price_note??""),
      tracking_no:normalizeTrackingCode(el.tracking_no??attrs.tracking_no),
      carrier_code:String(el.carrier_code??""),
      carton_no:String(el.carton_no??""),
      inspection_note:String(el.inspection_note??""),
      evidence_ids:Array.isArray(el.evidence_ids)?el.evidence_ids.map(String):[],
      source_kind:(el.source_kind as ExpectedProductLine["source_kind"])??"manual",
    }));
  }
  const items:Row[]=Array.isArray(line.items)?line.items:Array.isArray(line.draft_items)?line.draft_items:[];
  if(!items.length) return [];
  const buckets=new Map<string,ExpectedProductLine>();
  items.forEach((item,idx)=>{
    const sku=String(item.sku_code??item.sample_code??attrs.sample_code_prefix??"").trim();
    const name=String(item.name??attrs.name??"").trim();
    const color=String(item.color_declared??attrs.color_declared??"").trim();
    const size=String(item.size_label??attrs.size_label??"").trim();
    const supplier=String(item.supplier_alias??attrs.supplier_alias??attrs.supplier_ref??"").trim();
    const tracking=normalizeTrackingCode(item.declared_tracking_no??item.tracking_no??attrs.tracking_no);
    const key=[item.expected_line_id??"",name,color,size,supplier,tracking,items.length<=3?sku:""].join("|");
    const existing=buckets.get(key);
    if(existing) {
      existing.quantity+=1;
    } else {
      buckets.set(key,{
        id:String(item.expected_line_id??`EL-${idx+1}`),
        sku_code:sku,
        product_name:name,
        color_declared:color,
        size_label:size,
        quantity:1,
        supplier_alias:supplier,
        tracking_no:tracking,
        carrier_code:String(item.carrier_code??""),
        source_kind:"manual",
      });
    }
  });
  return [...buckets.values()];
}

const KNOWN_SIZES=new Set(["XXS","XS","S","M","L","XL","XXL","2XL","3XL","4XL","5XL","均码","ONE SIZE","FREE"]);

export function parseStructuredPurchaseText(
  rawText:string,
  options:{
    evidenceId:string;
    sourceFileName?:string;
    defaultProductName?:string;
    defaultSupplier?:string;
    defaultPoRef?:string;
    defaultTracking?:string;
  }
):ExtractedCandidateLine[] {
  const lines=rawText
    .split(/\r?\n/)
    .map(l=>l.trim())
    .filter(l=>l.length>0 && !/^[-=_]{3,}$/.test(l));
  if(!lines.length) return [];

  const splitRow=(line:string):string[]=>{
    if(line.includes("\t")) return line.split("\t").map(c=>c.trim());
    if(line.includes("|")) return line.split("|").map(c=>c.trim());
    if(line.includes(";")) return line.split(";").map(c=>c.trim());
    // CSV with quotes awareness (simple split when comma present and no trailing Chinese comma list)
    if(line.includes(",")) return line.split(",").map(c=>c.replace(/^["']|["']$/g,"").trim());
    return line.split(/\s{2,}/).map(c=>c.trim());
  };

  // Detect optional header row
  type ColKey="sku"|"name"|"color"|"size"|"qty"|"supplier"|"tracking"|"po"|"price";
  const headerAliases:Array<[RegExp,ColKey]>=[
    [/^(sku|style|sku\s*\/?\s*style|item[\s_-]*code|style[\s_-]*code|款号|货号|编码)$/i,"sku"],
    [/^(name|product|product[\s_-]*name|item[\s_-]*name|goods[\s_-]*name|title|商品|商品名称|品名|名称)$/i,"name"],
    [/^(color|colour|variant|颜色|色号)$/i,"color"],
    [/^(size|spec|size\s*\/?\s*spec|尺码|规格|码数)$/i,"size"],
    [/^(qty|quantity|count|pcs|件数|数量)$/i,"qty"],
    [/^(supplier|supplier[\s_-]*(name|alias)?|vendor|seller|shop|店铺|供应商|卖家)$/i,"supplier"],
    [/^(tracking|tracking[\s_-]*(no|number|#)?|waybill|express|logistics|运单号|快递单号|单号|物流单号)$/i,"tracking"],
    [/^(po|po[\s_-]*(ref|no|number)?|order|order[\s_-]*no|采购单号|订单号)$/i,"po"],
    [/^(price|unit[\s_-]*price|单价|价格|采购价)$/i,"price"],
  ];
  let columnMap:Partial<Record<ColKey,number>>|null=null;
  const firstCells=splitRow(lines[0]);
  if(firstCells.length>=2) {
    const candidateMap:Partial<Record<ColKey,number>>={};
    let hits=0;
    firstCells.forEach((cell,idx)=>{
      const clean=cell.replace(/[*:()（）]/g,"").trim();
      for(const [re,key] of headerAliases) {
        if(re.test(clean)) {
          candidateMap[key]=idx;
          hits++;
          break;
        }
      }
    });
    if(hits>=2) columnMap=candidateMap;
  }

  const startIndex=columnMap?1:0;
  const candidates:ExtractedCandidateLine[]=[];
  for(let i=startIndex;i<lines.length;i++) {
    const raw=lines[i];
    const cells=splitRow(raw);
    let sku="";
    let productName=options.defaultProductName??"";
    let color="";
    let size="";
    let qty=0;
    let supplier=options.defaultSupplier??"";
    let tracking=options.defaultTracking??"";
    let poRef=options.defaultPoRef??"";
    let priceNote="";

    if(columnMap) {
      const get=(k:ColKey)=>columnMap![k]!==undefined?(cells[columnMap![k]!]??"").trim():"";
      sku=get("sku");
      productName=get("name")||productName;
      color=get("color");
      size=get("size");
      const rawQty=get("qty").replace(/[^\d]/g,"");
      qty=rawQty?Number(rawQty):0;
      supplier=get("supplier")||supplier;
      tracking=normalizeTrackingCode(get("tracking")||tracking);
      poRef=get("po")||poRef;
      priceNote=get("price");
    } else if(cells.length>=4) {
      // Positional guess: if first cell looks like SKU code (e.g. HD-BLK-S), check 4..7 columns
      // Pattern A: SKU | Name | Color | Size | Qty | Supplier | Tracking
      // Pattern B: SKU | Color | Size | Qty | Supplier | Tracking
      // Pattern C: Color | Size | Qty
      const qtyIdx=cells.findIndex(c=>/^\d+$/.test(c.replace(/\s*(pcs|件|条|套)?$/i,"")) && Number(c.replace(/[^\d]/g,""))>0 && Number(c.replace(/[^\d]/g,""))<10000);
      if(qtyIdx>=2) {
        const before=cells.slice(0,qtyIdx);
        const after=cells.slice(qtyIdx+1);
        qty=Number(cells[qtyIdx].replace(/[^\d]/g,""));
        if(before.length===2) {
          color=before[0];
          size=before[1];
        } else if(before.length===3) {
          sku=before[0];
          color=before[1];
          size=before[2];
        } else if(before.length>=4) {
          sku=before[0];
          productName=before[1]||productName;
          color=before[2];
          size=before[3];
        }
        if(after[0] && !/^[A-Z0-9-]{8,}$/i.test(after[0])) supplier=after[0]||supplier;
        else if(after[0]) tracking=normalizeTrackingCode(after[0]);
        if(after[1]) tracking=normalizeTrackingCode(after[1]);
      } else {
        sku=cells[0]??"";
        productName=cells[1]??productName;
        color=cells[2]??"";
        size=cells[3]??"";
        const q=Number((cells[4]??"").replace(/[^\d]/g,""));
        qty=Number.isFinite(q)&&q>0?q:0;
        supplier=cells[5]||supplier;
        tracking=normalizeTrackingCode(cells[6]||tracking);
      }
    } else {
      // Free-form single line e.g. "HD-BLK-S Black M x12 SF1234567890"
      const tokens=raw.split(/[|/,\t\s]+/).filter(Boolean);
      for(const tok of tokens) {
        const qtyMatch=tok.match(/^[x×*]?(\d{1,4})(?:pcs|件|条|套)?$/i);
        if(qtyMatch && !qty && Number(qtyMatch[1])>0 && Number(qtyMatch[1])<=500) {
          qty=Number(qtyMatch[1]);
        } else if(!size && KNOWN_SIZES.has(tok.toUpperCase())) {
          size=tok.toUpperCase();
        } else if(!tracking && /^[A-Z]{2,4}[0-9]{8,20}$/i.test(tok)) {
          tracking=normalizeTrackingCode(tok);
        } else if(!sku && /^[A-Z0-9_-]{3,24}$/i.test(tok) && /[-_0-9]/.test(tok)) {
          sku=tok;
        } else if(!color) {
          color=tok;
        } else if(!productName) {
          productName=tok;
        }
      }
    }

    const row:ExtractedCandidateLine={
      id:`EXT-${Date.now().toString(36)}-${i}`,
      evidence_id:options.evidenceId,
      source_evidence_id:options.evidenceId,
      ...(options.sourceFileName?{source_file_name:options.sourceFileName}:{}),
      status:"unconfirmed",
      edited_by_user:false,
      sku_code:sku,
      product_name:productName,
      color_declared:color,
      size_label:size,
      quantity:qty,
      supplier_alias:supplier,
      purchase_order_ref:poRef,
      unit_price_note:priceNote,
      tracking_no:tracking,
      source_kind:"paste",
      confidence:missingLineFields({sku_code:sku,product_name:productName,color_declared:color,size_label:size,quantity:qty}).length===0?"structured":"needs_review",
      missing_fields:missingLineFields({sku_code:sku,product_name:productName,color_declared:color,size_label:size,quantity:qty}),
      needs_confirmation:true,
      selected:true,
      confirmed:false,
      raw_source:raw,
    };
    candidates.push(row);
  }
  return candidates;
}
