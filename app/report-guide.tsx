"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { localizePublicPath } from "../packages/core/locale-contract";
import { useLocale } from "./i18n-client";

export function ApparelIllustration({ kind = "shirt" }: { kind?: "shirt" | "bag" | "shoe" }) {
  return (
    <svg
      viewBox="0 0 120 120"
      width="84"
      height="84"
      fill="none"
      stroke="#6c8dad"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "shirt" ? (
        <path d="M37 16 18 29 7 52l25 14 7-14v52h53V52l7 14 25-14-13-23-21-13c-12 17-28 17-43 0Z" />
      ) : kind === "bag" ? (
        <path d="M27 48h68l7 53H20l7-53Zm17 0V37a17 17 0 0 1 34 0v11" />
      ) : (
        <path d="M11 79c25-3 38-31 54-46 18 27 24 27 45 37v20H11Z" />
      )}
    </svg>
  );
}

export function PhotoCardPlaceholder({ title, label = "ILLUSTRATIVE" }: { title: string; label?: string }) {
  return (
    <div className="photo">
      <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
        <rect x="9" y="13" width="46" height="38" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="24" cy="26" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M13 44 29 31l8 8 7-6 8 11" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span className="demo-mark">{label}</span>
      <b>{title}</b>
    </div>
  );
}

export function EvidenceIllustration() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  return (
    <figure className="evidence-figure">
      <div className="evidence-head">
        <span>{isZh ? "质检执行 / 报告档案结构" : "INSPECTION / REPORT STRUCTURE"}</span>
        <span>{isZh ? "示意图" : "ILLUSTRATION"}</span>
      </div>
      <div className="evidence-body">
        <div className="evidence-diagram" aria-hidden="true">
          <svg viewBox="0 0 360 250" fill="none">
            <defs>
              <pattern id="measurement-grid" width="18" height="18" patternUnits="userSpaceOnUse">
                <path d="M18 0H0v18" stroke="#344764" strokeWidth="1" />
              </pattern>
            </defs>
            <path d="M0 0H360V250H0z" fill="url(#measurement-grid)" />
            <path d="M72 41h216v167H72z" stroke="#415779" strokeDasharray="4 5" />
            <path
              d="m153 56-42 17-27 43 41 23 13-20v71h84v-71l13 20 41-23-27-43-42-17c-5 14-13 19-27 19s-22-5-27-19Z"
              fill="#1e3658"
              stroke="#b9cdf2"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M137 119h86M180 83v103M128 113v12M232 113v12M132 119h-7m103 0h7" stroke="#81a8fc" strokeWidth="1.25" strokeDasharray="4 3" />
            <circle cx="180" cy="119" r="3.5" fill="#cbdcff" />
            <path d="M180 119h104l20-20h31" stroke="#a2bfff" />
            <rect x="300" y="76" width="37" height="22" rx="2" fill="#b6cbfa" />
            <text x="309" y="91" fill="#132642" fontSize="11" fontFamily="monospace">A01</text>
            <path d="M72 228h216M72 221v14M108 224v8M144 224v8M180 221v14M216 224v8M252 224v8M288 221v14" stroke="#8097ba" />
          </svg>
        </div>
        <dl className="evidence-fields">
          <div><dt>{isZh ? "检查点" : "CHECKPOINT"}</dt><dd>{isZh ? "平铺 1/2 胸围" : "Chest width (1/2)"}</dd></div>
          <div><dt>{isZh ? "量测规范" : "METHOD"}</dt><dd>{isZh ? "自然平铺 · 无拉伸" : "Laid flat, unstrained"}</dd></div>
          <div><dt>{isZh ? "交付依据" : "EVIDENCE"}</dt><dd>{isZh ? "带刻度尺实图 + 台账" : "Metric tape photo + log"}</dd></div>
        </dl>
      </div>
      <figcaption>
        {isZh
          ? <>服装模板示例 <span aria-hidden="true">/</span> 检查项随已批准品类版本自动匹配。</>
          : <>Apparel template example <span aria-hidden="true">/</span> Checkpoints follow the approved category version.</>}
      </figcaption>
    </figure>
  );
}

export function SampleReportPreview() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  return (
    <figure className="report-artifact">
      <div className="report-ribbon">
        <strong>▤ &nbsp; {isZh ? "QC Warehouse · 样板报告节选" : "QC Warehouse · Sample Excerpt"}</strong>
        <span>{isZh ? "演示示例数据" : "DEMONSTRATION DATA"}</span>
      </div>
      <dl className="proof-data">
        <div>
          <dt>{isZh ? "委单 / 报告编号" : "Order / Report"}</dt>
          <dd>QW261121835 · RP261121835<br />{isZh ? "版本 02 · QA 已审核" : "Version 02 · Reviewed"}</dd>
        </div>
        <div>
          <dt>{isZh ? "委托服务项目" : "Commissioned Service"}</dt>
          <dd>{isZh ? <>供应商样品横向对比<br />3 件全棉圆领卫衣（L 码）</> : <>Sample Comparison<br />3 Cotton Crewneck Tops (L)</>}</dd>
        </div>
        <div>
          <dt>{isZh ? "仓内作业条件" : "Bench Conditions"}</dt>
          <dd>{isZh ? <>自然平铺 · 无拉伸<br />校准米尺 · 0.1 cm 精度</> : <>Laid flat · Unstrained<br />Metric tape · 0.1 cm</>}</dd>
        </div>
      </dl>
      <div
        className="table-wrap"
        tabIndex={0}
        role="region"
        aria-label={isZh ? "演示量测数据与瑕疵节选表" : "Demonstration measurement and defect excerpt"}
      >
        <table style={{ minWidth: 0 }}>
          <thead>
            <tr>
              <th scope="col">{isZh ? "检查项目" : "Checkpoint"}</th>
              <th scope="col">{isZh ? "目标值 (±公差)" : "Target (±Tol)"}</th>
              <th scope="col">{isZh ? "样品 A" : "Sample A"}</th>
              <th scope="col">{isZh ? "样品 B" : "Sample B"}</th>
              <th scope="col">{isZh ? "样品 C" : "Sample C"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{isZh ? "平铺 1/2 胸围" : "Chest width (1/2)"}</th>
              <td>55.0 (±1.0 cm)</td>
              <td>55.1 cm</td>
              <td><strong>56.6 cm ▲</strong></td>
              <td>54.9 cm</td>
            </tr>
            <tr>
              <th scope="row">{isZh ? "前衣长 (HPS)" : "Front length (HPS)"}</th>
              <td>72.0 (±1.0 cm)</td>
              <td>72.0 cm</td>
              <td>71.4 cm</td>
              <td>72.2 cm</td>
            </tr>
            <tr>
              <th scope="row">{isZh ? "单件克重" : "Garment mass"}</th>
              <td>{isZh ? "参考 ~235 g" : "Ref ~235 g"}</td>
              <td>238 g</td>
              <td>214 g</td>
              <td>241 g</td>
            </tr>
            <tr>
              <th scope="row">{isZh ? "工艺与做工" : "Workmanship"}</th>
              <td>{isZh ? "无可见瑕疵" : "No visible defect"}</td>
              <td>{isZh ? "合格无异常" : "Clean"}</td>
              <td><strong>{isZh ? "2 处瑕疵标注 (B-DEF-01/02)" : "2 notes (B-DEF-01/02)"}</strong></td>
              <td>{isZh ? "合格无异常" : "Clean"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <figcaption style={{ marginTop: 12 }}>
        {isZh ? (
          <>
            <strong>仅作报告结构演示示例：</strong> 样衣编码、示例读数（如胸围 55.1 cm）及供应商列仅用于展示报告结构与颗粒度，并非真实客户验货结论；不含化学实验室成分化验、水洗缩率及驻厂 AQL 抽检认证。
          </>
        ) : (
          <>
            <strong>Demonstration / Illustrative example only:</strong> Item codes, measurements (such as the 55.1 cm chest example), and supplier rows illustrate report structure only—never audited physical inspection results. Excludes chemical lab testing, shrinkage, and bulk AQL claims.
          </>
        )}
      </figcaption>
    </figure>
  );
}

type LightboxItem = {
  code: string;
  title: string;
  caption: string;
  span2?: boolean;
  src: string;
  alt: string;
};

const DEMO_SAMPLES = [
  {
    code: "S39201",
    alias: "Supplier A (Guangzhou)",
    aliasZh: "供应商 A（广州）",
    parcel: "P86421 · Bin INSP-A02-01",
    size: "Labeled L",
    sizeZh: "吊牌 L 码",
    weight: "238 g",
    outcome: "Within target spec · Retained as Golden Sample",
    outcomeZh: "各项尺寸符合公差 · 已指派封存为标杆确认样",
    tone: "green",
  },
  {
    code: "S39202",
    alias: "Supplier B (Dongguan)",
    aliasZh: "供应商 B（东莞）",
    parcel: "P86422 · Bin INSP-A02-02",
    size: "Labeled L",
    sizeZh: "吊牌 L 码",
    weight: "214 g",
    outcome: "Out-of-tolerance chest (+1.6 cm) · 2 annotated defect notes",
    outcomeZh: "胸围超差 (+1.6 cm) · 含 2 处红框瑕疵标注",
    tone: "red",
  },
  {
    code: "S39203",
    alias: "Supplier C (Ningbo)",
    aliasZh: "供应商 C（宁波）",
    parcel: "P86423 · Bin INSP-A02-03",
    size: "Labeled L",
    sizeZh: "吊牌 L 码",
    weight: "241 g",
    outcome: "Within target spec · Routed to designated forwarder",
    outcomeZh: "各项尺寸符合公差 · 安排发往指定国内集运仓",
    tone: "blue",
  },
] as const;

const MEASUREMENT_ROWS = [
  {
    point: "Chest Width (1/2, Pit-to-Pit)",
    pointZh: "半胸围（1/2，腋下平铺）",
    method: "Laid flat unstrained, 2.5 cm below armhole seam",
    methodZh: "无拉伸平铺，夹下袖窿缝线以下 2.5 cm 处横量",
    target: "55.0 cm",
    targetZh: "55.0 cm",
    tol: "±1.0 cm",
    tolZh: "±1.0 cm",
    a: "55.1 cm",
    b: "56.6 cm",
    bFlag: true,
    c: "54.9 cm",
    recheck: "Illustrative 2-pass log example: Read 1 = 56.7 cm, Read 2 = 56.5 cm → Final 56.6 cm",
    recheckZh: "超差双次复测留痕示例：初测 56.7 cm，复测 56.5 cm → 采信值 56.6 cm",
  },
  {
    point: "Front Body Length (HPS to Hem)",
    pointZh: "前衣长（HPS 高肩点至下摆）",
    method: "High Point Shoulder vertically to bottom hem edge",
    methodZh: "自领肩交界最高点（HPS）垂直拉尺至下摆底边",
    target: "72.0 cm",
    targetZh: "72.0 cm",
    tol: "±1.0 cm",
    tolZh: "±1.0 cm",
    a: "72.0 cm",
    b: "71.4 cm",
    bFlag: false,
    c: "72.2 cm",
    recheck: "Example Read 1 & Read 2 within 0.2 cm variance limit",
    recheckZh: "双次核对读数差在 0.2 cm 允许误差以内",
  },
  {
    point: "Across Shoulder (Seam to Seam)",
    pointZh: "总肩宽（左右肩缝点连线）",
    method: "Straight line between left and right shoulder points",
    methodZh: "左侧肩袖骨接缝至右侧肩袖骨接缝水平直量",
    target: "48.0 cm",
    targetZh: "48.0 cm",
    tol: "±0.8 cm",
    tolZh: "±0.8 cm",
    a: "48.0 cm",
    b: "48.9 cm",
    bFlag: true,
    c: "48.1 cm",
    recheck: "Illustrative 2-pass log example: Read 1 = 48.9 cm, Read 2 = 48.9 cm → Final 48.9 cm",
    recheckZh: "超差双次复测留痕示例：初测 48.9 cm，复测 48.9 cm → 采信值 48.9 cm",
  },
  {
    point: "Sleeve Length (Shoulder Seam to Cuff)",
    pointZh: "外袖长（肩点至袖口底边）",
    method: "Outer fold from shoulder crown to sleeve opening",
    methodZh: "沿衣袖外折线从肩顶缝点直量至袖口边",
    target: "22.0 cm",
    targetZh: "22.0 cm",
    tol: "±0.8 cm",
    tolZh: "±0.8 cm",
    a: "22.1 cm",
    b: "21.8 cm",
    bFlag: false,
    c: "22.0 cm",
    recheck: "Single-pass format example recorded to 0.1 cm precision",
    recheckZh: "常规 0.1 cm 精度工位实测单次入档格式示例",
  },
  {
    point: "Bottom Hem Opening (1/2 Flat)",
    pointZh: "平铺下摆半宽（1/2）",
    method: "Horizontal edge-to-edge along bottom sweep",
    methodZh: "沿成衣下摆边缘自然平放端对端横量",
    target: "55.0 cm",
    targetZh: "55.0 cm",
    tol: "±1.0 cm",
    tolZh: "±1.0 cm",
    a: "55.0 cm",
    b: "56.2 cm",
    bFlag: true,
    c: "54.8 cm",
    recheck: "Illustrative 2-pass log example: Read 1 = 56.2 cm, Read 2 = 56.2 cm → Final 56.2 cm",
    recheckZh: "超差双次复测留痕示例：初测 56.2 cm，复测 56.2 cm → 采信值 56.2 cm",
  },
  {
    point: "Unit Garment Mass",
    pointZh: "拆袋单件净克重",
    method: "Calibrated bench digital scale (1 g resolution, unpackaged)",
    methodZh: "工位已校准精密电子秤（1 g 精度，脱除包装袋测量）",
    target: "Ref ~235 g",
    targetZh: "参考 ~235 g",
    tol: "Observation",
    tolZh: "客观记录",
    a: "238 g",
    b: "214 g",
    bFlag: false,
    c: "241 g",
    recheck: "Unpackaged scale check format · 22 °C indoor studio",
    recheckZh: "22 °C 室内工位脱袋实称克重格式示例",
  },
] as const;

type DualLightboxItem = LightboxItem & {
  codeZh: string;
  titleZh: string;
  captionZh: string;
  altZh: string;
};

const ORIGINAL_PHOTO_EVIDENCE: DualLightboxItem[] = [
  {
    code: "FRM-01 · FRONT OVERVIEW",
    codeZh: "FRM-01 · 正面全景",
    title: "S39201 · Front Overview (Heather-Gray Crewneck, Size L)",
    titleZh: "S39201 · 正面平铺全貌图（麻灰圆领 T 恤 · L 码）",
    src: "/marketing/report-sample-a-front.webp",
    alt: "Overhead flat-lay front overview of Sample A heather-gray cotton crewneck T-shirt on the QC Warehouse inspection bench",
    altZh: "QC Warehouse 验货工位上样品 A 麻灰纯棉圆领 T 恤正面垂直俯拍全景图",
    caption: "Mandatory flat front frame linking Sample A to collar rib, cuffs, hem finish, and intake records.",
    captionZh: "必拍正面平铺定妆照，将样衣 S39201 与领口罗纹、袖口、下摆及入仓档案精确绑定。",
  },
  {
    code: "FRM-02 · BACK OVERVIEW",
    codeZh: "FRM-02 · 背面全景",
    title: "S39201 · Back Overview & Half-Moon Yoke",
    titleZh: "S39201 · 背面平铺全貌及后领贴布工艺",
    src: "/marketing/report-sample-a-back.webp",
    alt: "Overhead flat-lay back overview of Sample A heather-gray cotton crewneck T-shirt on the QC Warehouse inspection bench",
    altZh: "QC Warehouse 验货工位上样品 A 麻灰纯棉圆领 T 恤背面垂直俯拍全景图",
    caption: "Rear flat view captured on the identical garment, camera plane, and bench setup to confirm back jersey construction and hem finish.",
    captionZh: "同一相机高度与标准光源下拍摄的背面全景原图，核验后片面料纹理与走线工艺。",
  },
  {
    code: "FRM-03 · CHEST TAPE PROOF",
    codeZh: "FRM-03 · 胸围实测带尺图",
    title: "S39201 · Chest Width Tape Measurement (55.1 cm)",
    titleZh: "S39201 · 半胸围带刻度米尺实测原图（55.1 cm）",
    src: "/marketing/report-sample-a-chest-measure.webp",
    alt: "Overhead studio photo showing a yellow metric tape measuring horizontal chest width (55.1 cm) across Sample A heather-gray cotton crewneck T-shirt",
    altZh: "俯拍示图：黄色米尺清晰贴合量取样品 A 麻灰 T 恤平铺胸围（55.1 cm）",
    caption: "Studio frame showing unstrained seam-to-seam chest measurement (55.1 cm) with readable metric endpoints across the gray tee.",
    captionZh: "工位俯拍原片清楚展示无拉伸平铺胸围两端起始点及 55.1 cm 米尺清晰读数。",
  },
  {
    code: "FRM-04 · HPS LENGTH PROOF",
    codeZh: "FRM-04 · 衣长实测带尺图",
    title: "S39201 · Front Body Length HPS-to-Hem (72.0 cm)",
    titleZh: "S39201 · 前衣长 HPS 高肩点至下摆实测图（72.0 cm）",
    src: "/marketing/report-sample-a-body-length.webp",
    alt: "Overhead studio photo showing a yellow metric tape measuring front body length vertically (72.0 cm) from high point shoulder to bottom hem on Sample A heather-gray cotton crewneck T-shirt",
    altZh: "俯拍示图：黄色米尺自高肩点（HPS）垂直拉尺至下摆实测样品 A 前衣长（72.0 cm）",
    caption: "Vertical tape proof (72.0 cm) from High Point Shoulder (HPS) to bottom hem edge captured under the identical gray tee setup.",
    captionZh: "同机位拍摄的纵向拉尺原图（72.0 cm），直观核对高肩点至下摆底边真实读数。",
  },
];

const COMPARISON_GROUP_FRAME: DualLightboxItem = {
  code: "FRM-05 · GROUP OVERHEAD (A / B / C)",
  codeZh: "FRM-05 · 三样同台俯拍对比组图",
  title: "Side-by-Side Comparison Frame (Samples A, B & C)",
  titleZh: "A / B / C 三家候选样品同台并排对比实图",
  src: "/marketing/report-three-samples-comparison.webp",
  alt: "Synchronized overhead studio comparison of three heather-gray crewneck T-shirt samples (Samples A, B, and C) laid side by side on a calibrated table",
  altZh: "三件来自不同供应商的麻灰圆领 T 恤（样品 A、B、C）于标准工位同台俯拍横向对比图",
  caption: "Synchronized single-frame overhead comparison grouping all three candidate samples on one bench for direct visual comparison.",
  captionZh: "将三家工厂候选样衣置于同一台面及中性色温光源下同步俯拍，直接呈现版型、色差与领口差异。",
  span2: true,
};

export function ReportGuide() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? "样板质检报告演示" : "Sample Inspection Report"}</strong>
      </div>

      {/* Page Masthead */}
      <section className="pub-page-hero">
        <div className="pub-page-hero-split">
          <div>
            <p className="pub-eyebrow">
              {isZh ? "交付产物预览 · 结构与双语报告示例" : "DELIVERABLE PREVIEW · REPORT STRUCTURE"}
            </p>
            <h1>{isZh ? "服装质检与供应商样品横向对比样板报告" : "Sample Inspection & Comparison Report"}</h1>
            <p style={{ marginBottom: 18 }}>
              {isZh
                ? "提前审阅真实质检报告的结构组成：唯一追踪编号、带刻度尺实测照、无损瑕疵坐标框选及免责边界，助您在海外转运前做出退货、封存确认样或集运决策。"
                : "Inspect the exact structure, measurement traceability, non-destructive defect annotations, and scope boundaries you receive before deciding whether to return, store, or ship your items from China."}
            </p>
            <div className="row flexwrap no-print" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                {isZh ? "创建我的质检委托 →" : "Start Your Own Inspection →"}
              </Link>
              <button
                type="button"
                className="button"
                onClick={() => window.print()}
              >
                {isZh ? "打印 / 保存演示 PDF" : "Print / Save Sample PDF Preview"}
              </button>
              <Link className="button" href={hrefFor("/catalog")}>
                {isZh ? "对比核心服务" : "Compare Services"}
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>{isZh ? "样衣款号" : "Garment Identity"}</span>
              <strong>{isZh ? "麻灰重磅圆领卫衣 · L 码" : "Heather-Gray Crewneck · Size L"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "报告快照号" : "Report Snapshot"}</span>
              <strong>RP261121835 · Reviewed v2</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "比对样衣" : "Samples Compared"}</span>
              <strong>{isZh ? "3 件同组对比 (S39201/02/03)" : "3 Units (S39201 / S39202 / S39203)"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "证据规模" : "Evidence Scope"}</span>
              <strong>{isZh ? "8 张高清实拍 · 5 项标准检验" : "8 Studio Frames · 5 Checkpoints"}</strong>
            </div>
          </div>
        </div>
      </section>

      {/* Honest Demonstration Disclosure */}
      <div className="line-note warning" style={{ marginBottom: 22 }} role="note">
        {isZh ? (
          <>
            <strong>结构演示样板声明 — 本页为测试示例数据与示意摄影，非任何真实客户验货结论。</strong> 页内样衣编号、包裹单号、例示读数（如胸围 55.1 cm）及供应商 A/B/C 仅用于展示 QC Warehouse 的报告版式；正式客户报告均来自物理实测与不可变 QA 审核快照。
          </>
        ) : (
          <>
            <strong>Demonstration report — illustrative images and synthetic inspection data. Not an actual customer inspection.</strong> Sample IDs, parcel references, example readings (such as 55.1 cm chest width), supplier rows (Suppliers A/B/C), and illustrative photos demonstrate QC Warehouse’s report structure only; real client orders contain unaltered physical garment photographs and verified audit records.
          </>
        )}
      </div>

      {/* Full Printable Sample Report Sheet */}
      <article className="pub-report-sheet" aria-label={isZh ? "样板质检报告正文单" : "Sample Inspection Report Sheet"}>
        {/* 1. Report Summary Header */}
        <header className="pub-report-banner">
          <div>
            <div className="pub-eyebrow" style={{ color: "#93b8ff", marginBottom: 4 }}>
              {isZh ? "QC WAREHOUSE · 中国独立实物商品质检中心" : "QC WAREHOUSE · INDEPENDENT PRODUCT INSPECTION IN CHINA"}
            </div>
            <h2>{isZh ? "服装供应商样品对比与做工核验报告" : <>Apparel Sample Comparison &amp; Workmanship Report</>}</h2>
            <p>
              {isZh ? (
                <>
                  报告编号 <span className="code">RP261121835</span> · 审定版本 <span className="code">v2</span> · 订单号 <span className="code">QW261121835</span> · 品类：<strong>服装 / 上衣与针织衫</strong>
                </>
              ) : (
                <>
                  Report <span className="code">RP261121835</span> · Reviewed Version <span className="code">v2</span> · Order <span className="code">QW261121835</span> · Category: <strong>Apparel / Tops &amp; Knitwear</strong>
                </>
              )}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="tag yellow">{isZh ? "演示样板" : "DEMONSTRATION"}</span>
            <span className="tag blue">{isZh ? "3 件样衣对比" : "3 SAMPLES COMPARED"}</span>
          </div>
        </header>

        {/* Executive Summary */}
        <section className="pub-report-section" id="report-summary">
          <p className="pub-eyebrow">{isZh ? "01 · 报告执行摘要" : "01 · REPORT SUMMARY"}</p>
          <h3>{isZh ? "买家采纳与处置决策摘要" : "Executive Summary for Buyer Decision"}</h3>
          <p className="small muted" style={{ maxWidth: "82ch", marginBottom: 14 }}>
            {isZh
              ? "三件来自不同国内供应商包裹的无品牌重磅纯棉圆领 T 恤（标码 L），均在相同光源与平铺量尺规范下对照买家目标公差逐项核验。"
              : "Three unbranded heavyweight cotton crewneck T-shirt samples (labeled Size L) received from three separate domestic Chinese parcels were checked under identical bench lighting and flat-lay measurement rules against buyer-supplied reference specifications."}
          </p>
          <div className="grid cols4">
            <div className="def">
              <dt>{isZh ? "委托服务类型" : "Commissioned Service"}</dt>
              <dd>{isZh ? "上衣 3 件样品横向对比" : "Tops 3-Item Comparison"}</dd>
            </div>
            <div className="def">
              <dt>{isZh ? "实测工作台环境" : "Bench Environment"}</dt>
              <dd>Indoor 22 °C · 5600K LED</dd>
            </div>
            <div className="def">
              <dt>{isZh ? "计量量尺精度" : "Measurement Tool"}</dt>
              <dd>{isZh ? "校准米尺 (0.1 cm)" : "Calibrated Metric Tape (0.1 cm)"}</dd>
            </div>
            <div className="def">
              <dt>{isZh ? "已锁定图片证据" : "Recorded Evidence"}</dt>
              <dd>{isZh ? "5 组标准角度 + 2 处瑕疵框" : "5 Core Frames + 2 Defect Boxes"}</dd>
            </div>
          </div>
        </section>

        {/* 2. Scope of Inspection */}
        <section className="pub-report-section" id="report-scope">
          <p className="pub-eyebrow">{isZh ? "02 · 本次实检项目与除外边界" : "02 · SCOPE OF INSPECTION"}</p>
          <h3>{isZh ? "已执行模板检查项 vs 未检测除外说明" : "Commissioned Checkpoints vs. Uninspected Scope"}</h3>
          <div className="pub-boundary-grid" style={{ marginTop: 12 }}>
            <div className="pub-boundary-box included">
              <strong style={{ color: "#0b816b" }}>{isZh ? "按模板 v2（服装—上衣）实际执行" : "Executed under Template v2 (Apparel — Tops)"}</strong>
              <ul className="pub-check-list">
                <li><b className="mark-ok">✓</b><span>{isZh ? <>逐件点收与挂牌赋码（<span className="code">S39201..S39203</span>）。</> : <>Per-parcel arrival check-in and individual sample barcode hangtag assignment (<span className="code">S39201..S39203</span>).</>}</span></li>
                <li><b className="mark-ok">✓</b><span>{isZh ? "5 项核心平铺尺寸测量，超差项自动触发双人/双次复测留痕。" : "5 flat-lay dimensional measurements with automatic two-pass re-measurement when variance exceeds threshold."}</span></li>
                <li><b className="mark-ok">✓</b><span>{isZh ? "脱袋单件克重数字电子秤称重（1 g 精度）。" : "Unpackaged single-garment digital scale weight (1 g resolution)."}</span></li>
                <li><b className="mark-ok">✓</b><span>{isZh ? "领口、前胸、肩条、侧缝、袖口、下摆及洗唛外观检查。" : "Visual workmanship check across collar, chest, shoulder tape, side seams, cuffs, hem, and care label."}</span></li>
              </ul>
            </div>
            <div className="pub-boundary-box excluded">
              <strong style={{ color: "#b24046" }}>{isZh ? "明确不在本次无损检验范围内" : "Explicitly Outside Commissioned Scope"}</strong>
              <ul className="pub-check-list">
                <li><b className="mark-no">—</b><span><strong>{isZh ? "不含实验室理化检测：" : "No laboratory or chemical testing:"}</strong> {isZh ? "不裁剪取样测棉氨成分比例、偶氮染料或克重破坏实验。" : "Fiber composition %, azo/formaldehyde tests, and cut-swatch GSM tests are not performed."}</span></li>
                <li><b className="mark-no">—</b><span><strong>{isZh ? "不含水洗缩率及耐用测试：" : "No wash or durability testing:"}</strong> {isZh ? "缩水率、起球及色牢度需送专业实验室。" : "Shrinkage after laundering, pilling, and colorfastness are outside non-destructive check scope."}</span></li>
                <li><b className="mark-no">—</b><span><strong>{isZh ? "不代表未到仓大货：" : "No bulk factory AQL representation:"}</strong> {isZh ? "结论仅对实际到仓的 3 件物理样品负责。" : "Findings apply strictly to the 3 physical items received at our facility."}</span></li>
                <li><b className="mark-no">—</b><span><strong>{isZh ? "不含品牌真伪鉴定或出口合规认证。" : "No brand authenticity or regulatory safety certification."}</strong></span></li>
              </ul>
            </div>
          </div>
        </section>

        {/* 3. Sample Identification */}
        <section className="pub-report-section" id="sample-identification">
          <p className="pub-eyebrow">{isZh ? "03 · 到仓样衣逐件建档" : "03 · SAMPLE IDENTIFICATION"}</p>
          <h3>{isZh ? "在库实物编号与物流收货链路" : "Registered Physical Items & Chain of Custody"}</h3>
          <div className="pub-sample-id-grid">
            {DEMO_SAMPLES.map((s) => (
              <div className="pub-sample-id-card" key={s.code}>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <strong className="code" style={{ fontSize: 14 }}>{s.code}</strong>
                  <span className={`tag ${s.tone}`}>{isZh ? s.sizeZh : s.size}</span>
                </div>
                <p style={{ fontSize: 13, fontWeight: 700, color: "#152842", marginBottom: 4 }}>{isZh ? s.aliasZh : s.alias}</p>
                <p className="small muted" style={{ marginBottom: 8 }}>
                  {isZh ? "入仓单号" : "Inbound Waybill"}: <span className="code">{s.parcel}</span> · {isZh ? "实称克重" : "Mass"}: <strong>{s.weight}</strong>
                </p>
                <div className="small" style={{ color: s.tone === "red" ? "#9e2a30" : "#1d3b5c", fontWeight: 650 }}>
                  {isZh ? s.outcomeZh : s.outcome}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 4. Original Photo Evidence */}
        <section className="pub-report-section" id="photo-evidence">
          <div className="row between flexwrap">
            <div>
              <p className="pub-eyebrow">{isZh ? "04 · 原始无修饰摄影证据" : "04 · ORIGINAL PHOTO EVIDENCE"}</p>
              <h3>{isZh ? "标准角度与带刻度尺实测影像" : "Mandatory Angle & Tape-in-Frame Documentation"}</h3>
            </div>
            <span className="small muted no-print">{isZh ? "点击任意图片放大查看高分原图" : "Click any frame to inspect full-resolution details"}</span>
          </div>
          <div className="pub-evidence-gallery">
            {ORIGINAL_PHOTO_EVIDENCE.map((item) => {
              const viewItem: LightboxItem = isZh
                ? {
                    code: item.codeZh,
                    title: item.titleZh,
                    caption: item.captionZh,
                    src: item.src,
                    alt: item.altZh,
                    span2: item.span2,
                  }
                : item;
              return (
                <figure className={`pub-evidence-card${item.span2 ? " span-2" : ""}`} key={item.code}>
                  <button
                    type="button"
                    className="pub-zoom-trigger"
                    onClick={() => setLightbox(viewItem)}
                    aria-label={isZh ? `放大查看 ${viewItem.title}` : `Inspect ${viewItem.title}`}
                  >
                    <div className="pub-evidence-frame">
                      <img src={viewItem.src} alt={viewItem.alt} width={1200} height={900} loading="eager" />
                    </div>
                  </button>
                  <figcaption>
                    <div>
                      <span className="code" style={{ fontSize: 11, color: "#1f56c8", fontWeight: 700 }}>{viewItem.code}</span>
                      <strong>{viewItem.title}</strong>
                      <span>{viewItem.caption}</span>
                    </div>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>

        {/* 5. Measurement Comparison & Re-measurement Traceability */}
        <section className="pub-report-section" id="measurement-comparison">
          <p className="pub-eyebrow">{isZh ? "05 · 尺寸对比与复测可追溯台账" : "05 · MEASUREMENT COMPARISON & RE-MEASUREMENT LOG"}</p>
          <h3>{isZh ? "平铺实测尺寸表与双次独立复测" : "Side-by-Side Flat Measurements & Two-Pass Verification"}</h3>
          <p className="small muted" style={{ marginBottom: 12 }}>
            {isZh
              ? "当读数超出买家目标公差或两次读数相差超过 0.3 cm 时，工作台强制执行第二次独立量尺并将两轮原始数据一同固化进报告快照。"
              : "When an observed measurement deviates beyond the buyer’s supplied tolerance or shows inter-pass variance above 0.3 cm, QC Warehouse’s workbench requires a second independent tape reading and logs both raw readings in the published snapshot."}
          </p>
          <div className="tablewrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isZh ? "测量部位与方法" : "Measurement Point & Method"}</th>
                  <th>{isZh ? "买家目标公差" : "Buyer Target"}</th>
                  <th>{isZh ? "样品 A" : "Sample A"}</th>
                  <th>{isZh ? "样品 B" : "Sample B"}</th>
                  <th>{isZh ? "样品 C" : "Sample C"}</th>
                  <th>{isZh ? "复测追踪留痕" : "Traceability & Re-Check Log"}</th>
                </tr>
              </thead>
              <tbody>
                {MEASUREMENT_ROWS.map((r) => (
                  <tr key={r.point}>
                    <td>
                      <strong>{isZh ? r.pointZh : r.point}</strong>
                      <div className="small muted">{isZh ? r.methodZh : r.method}</div>
                    </td>
                    <td className="mono">{isZh ? r.targetZh : r.target}<br /><small>{isZh ? r.tolZh : r.tol}</small></td>
                    <td className="mono">{r.a}</td>
                    <td className="mono" style={r.bFlag ? { color: "#b24046", fontWeight: 800, background: "#fff5f5" } : undefined}>
                      {r.b} {r.bFlag ? "▲" : ""}
                    </td>
                    <td className="mono">{r.c}</td>
                    <td className="small">{isZh ? r.recheckZh : r.recheck}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 6. Side-by-Side Comparison & Golden Sample Matching */}
        <section className="pub-report-section" id="side-by-side-comparison">
          <p className="pub-eyebrow">{isZh ? "06 · 同台横向对比与确认样基准机制" : "06 · SIDE-BY-SIDE & GOLDEN SAMPLE COMPARISON"}</p>
          <h3>{isZh ? "同组俯拍对比与标杆确认样封存比对" : "Synchronized Multi-Sample Overhead & Golden Sample Benchmark"}</h3>
          {(() => {
            const groupView: LightboxItem = isZh
              ? {
                  code: COMPARISON_GROUP_FRAME.codeZh,
                  title: COMPARISON_GROUP_FRAME.titleZh,
                  caption: COMPARISON_GROUP_FRAME.captionZh,
                  src: COMPARISON_GROUP_FRAME.src,
                  alt: COMPARISON_GROUP_FRAME.altZh,
                  span2: true,
                }
              : COMPARISON_GROUP_FRAME;
            return (
              <div className="pub-evidence-gallery" style={{ marginTop: 12, marginBottom: 18 }}>
                <figure className="pub-evidence-card span-2">
                  <button
                    type="button"
                    className="pub-zoom-trigger"
                    onClick={() => setLightbox(groupView)}
                    aria-label={isZh ? `放大查看 ${groupView.title}` : `Inspect ${groupView.title}`}
                  >
                    <div className="pub-evidence-frame">
                      <img
                        src={groupView.src}
                        alt={groupView.alt}
                        width={1200}
                        height={900}
                        loading="eager"
                      />
                    </div>
                  </button>
                  <figcaption>
                    <div>
                      <span className="code" style={{ fontSize: 11, color: "#1f56c8", fontWeight: 700 }}>{groupView.code}</span>
                      <strong>{groupView.title}</strong>
                      <span>{groupView.caption}</span>
                    </div>
                  </figcaption>
                </figure>
              </div>
            );
          })()}

          <div className="pub-service-detail" id="golden-sample-comparison" style={{ margin: 0, padding: 20, background: "#f8fafd" }}>
            <div>
              <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{isZh ? "后续大货复购比对链路" : "FOLLOW-ON BENCHMARK WORKFLOW"}</p>
              <h4 style={{ fontSize: "1.06rem", color: "#0f213a", margin: "0 0 8px" }}>
                {isZh ? "如何将合格样品转为长期封存标杆样（Golden Sample）" : "How Approved Samples Become Your Retained Reference Benchmark"}
              </h4>
              <p style={{ color: "#22364f", fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
                {isZh ? (
                  <>
                    审阅报告后，您可在工作台指派合格单品（如 <span className="code">S39201</span>）封存入专用确认样保护仓。后续供应商寄来产前样或大货补货时，下单<strong>标杆确认样对照</strong>，验货员将直接取出封存实物与新来料（如 <span className="code">S39208</span>）同台对照核验尺度与色差。
                  </>
                ) : (
                  <>
                    After reviewing a comparison or inspection report, you can instruct QC Warehouse to seal an approved item (for example, <span className="code">S39201</span>) inside secure reference sample storage. When your supplier ships a restock or pre-production piece weeks later, you order <strong>Golden Sample Matching</strong> so our inspector lays the sealed reference next to the incoming garment (<span className="code">S39208</span>) and records any dimensional or shade drift.
                  </>
                )}
              </p>
              <div className="row flexwrap no-print" style={{ gap: 8, marginTop: 12 }}>
                <Link className="button sm" href={hrefFor("/services/reference")}>
                  {isZh ? "了解标杆确认样对照服务 →" : "Explore Golden Sample Matching →"}
                </Link>
              </div>
            </div>
            <figure className="pub-photo-box">
              <img
                src="/marketing/report-reference-followup.webp"
                alt="Approved heather-gray Golden Sample T-shirt in a sealed protective bag beside an incoming restock T-shirt"
                width={1200}
                height={900}
                loading="eager"
              />
            </figure>
          </div>
        </section>

        {/* 7. Defect Annotations */}
        <section className="pub-report-section" id="defect-annotations">
          <div className="row between flexwrap">
            <div>
              <p className="pub-eyebrow">{isZh ? "07 · 无损瑕疵标框叠加层" : "07 · DEFECT CALLOUT OVERLAYS"}</p>
              <h3>{isZh ? "做工走线与面料表面瑕疵标注" : "Workmanship & Fabric Surface Defect Callouts"}</h3>
              <p className="small muted" style={{ margin: 0 }}>
                {isZh
                  ? "仓内原始摄影文件永久保持无涂抹状态；独立 QA 复核的红框坐标与双语说明仅在前端叠加展示，可随时切换显示。"
                  : "Original studio photos remain untouched in storage; reviewer-verified red callout boxes and English defect notes can be toggled on or off in your report view."}
              </p>
            </div>
            <button
              type="button"
              className="button sm no-print"
              onClick={() => setShowAnnotations((v) => !v)}
              aria-pressed={showAnnotations}
            >
              {showAnnotations ? (isZh ? "隐藏红框标注" : "Hide Red Callout Boxes") : (isZh ? "显示红框标注" : "Show Red Callout Boxes")}
            </button>
          </div>

          <div className="pub-defect-grid">
            <figure className="pub-evidence-card">
              <div className={`pub-callout-bar${showAnnotations ? "" : " is-muted"}`}>
                <span>
                  {showAnnotations
                    ? (isZh ? "红框瑕疵标注已开启" : "RED-BOX CALLOUT ACTIVE")
                    : (isZh ? "原始底片 · 标注已隐藏" : "ORIGINAL PHOTO · CALLOUT HIDDEN")}
                </span>
                <span className="code">B-DEF-01</span>
              </div>
              <button
                type="button"
                className="pub-zoom-trigger"
                onClick={() =>
                  setLightbox(
                    isZh
                      ? {
                          code: "B-DEF-01 · 侧缝车线工艺",
                          title: "S39202 · 左侧缝散脱锁边线环（约 14 mm）",
                          src: "/marketing/report-sample-b-seam-defect.webp",
                          alt: "样品 B 麻灰纯棉 T 恤左侧缝散脱锁边线环微距特写原图",
                          caption: "仓库原始微距原片永久保持无修改；红色标注框在前端突出标记约 14 mm 散脱线环位置。",
                        }
                      : {
                          code: "B-DEF-01 · SIDE SEAM WORKMANSHIP",
                          title: "S39202 · Unsecured Overlock Stitch Loop on Left Side Seam",
                          src: "/marketing/report-sample-b-seam-defect.webp",
                          alt: "Macro close-up of an unsecured overlock stitch loop along the left side seam of Sample B heather-gray cotton T-shirt",
                          caption: "Original macro photograph stays untouched in storage; red callout box highlights the ~14 mm unsecured thread loop.",
                        },
                  )
                }
                aria-label={isZh ? "放大查看 B-DEF-01 侧缝微距原图" : "Inspect B-DEF-01 macro seam photo"}
              >
                <div className="pub-evidence-frame ratio-4-3">
                  <img
                    src="/marketing/report-sample-b-seam-defect.webp"
                    alt={isZh ? "样品 B 麻灰纯棉 T 恤左侧缝散脱锁边线环微距特写原图" : "Macro close-up of an unsecured overlock stitch loop along the left side seam of Sample B heather-gray cotton T-shirt"}
                    width={1200}
                    height={900}
                    loading="eager"
                  />
                  {showAnnotations && (
                    <svg className="pub-bbox-svg" viewBox="0 0 1200 900" aria-hidden="true">
                      <rect
                        x="280"
                        y="365"
                        width="390"
                        height="275"
                        rx="8"
                        fill="rgba(220, 38, 38, 0.12)"
                        stroke="#dc2626"
                        strokeWidth="4"
                      />
                    </svg>
                  )}
                </div>
              </button>
              <div className="pub-defect-schema-card">
                <div className="pub-defect-coords">
                  <div><span>{isZh ? "成衣部位" : "Garment Zone"}</span><strong>{isZh ? "左侧缝" : "Left Side Seam"}</strong></div>
                  <div><span>{isZh ? "标注位置" : "Callout Position"}</span><strong className="mono">{isZh ? "左下方侧缝" : "Lower-Left Seam"}</strong></div>
                  <div><span>{isZh ? "观测尺寸" : "Observed Size"}</span><strong>{isZh ? "约 14 mm 散脱线环" : "~14 mm thread loop"}</strong></div>
                </div>
              </div>
              <figcaption>
                <div>
                  <span className="code" style={{ color: "#b24046", fontWeight: 800, fontSize: 11 }}>
                    {isZh ? "瑕疵记录 · 侧缝车线做工" : "DEFECT RECORD · SIDE SEAM WORKMANSHIP"}
                  </span>
                  <strong>
                    {isZh
                      ? "样品 B (S39202)：左侧缝存在约 14 mm 散脱锁边线环"
                      : "Sample B (S39202): Unsecured ~14 mm overlock loop along left side seam"}
                  </strong>
                  <span>
                    {isZh
                      ? "经 QA 审校员复核的精确部位与形态说明，方便买家直接向国内供应商交涉退换或返修。"
                      : "QA-reviewed English note describing the exact location and extent of the workmanship issue for supplier return claims."}
                  </span>
                </div>
              </figcaption>
            </figure>

            <figure className="pub-evidence-card">
              <div className={`pub-callout-bar${showAnnotations ? "" : " is-muted"}`}>
                <span>
                  {showAnnotations
                    ? (isZh ? "红框瑕疵标注已开启" : "RED-BOX CALLOUT ACTIVE")
                    : (isZh ? "原始底片 · 标注已隐藏" : "ORIGINAL PHOTO · CALLOUT HIDDEN")}
                </span>
                <span className="code">B-DEF-02</span>
              </div>
              <button
                type="button"
                className="pub-zoom-trigger"
                onClick={() =>
                  setLightbox(
                    isZh
                      ? {
                          code: "B-DEF-02 · 面料表面外观",
                          title: "S39202 · 前片下摆局部表面污点（约 8 mm）",
                          src: "/marketing/report-sample-b-fabric-stain.webp",
                          alt: "样品 B 麻灰纯棉针织汗布前幅下摆局部褐黄色表面污点微距特写图",
                          caption: "仓库原始微距原片永久保持无修改；红色标注框突出标记约 8 mm 表面污渍区域。",
                        }
                      : {
                          code: "B-DEF-02 · FABRIC SURFACE",
                          title: "S39202 · Localized Surface Spot on Lower Front Panel",
                          src: "/marketing/report-sample-b-fabric-stain.webp",
                          alt: "Macro close-up of a localized brownish surface stain on the heather-gray cotton jersey knit of Sample B",
                          caption: "Original macro photograph stays untouched in storage; red callout box highlights the ~8 mm surface spot.",
                        },
                  )
                }
                aria-label={isZh ? "放大查看 B-DEF-02 面料污点微距原图" : "Inspect B-DEF-02 macro fabric stain photo"}
              >
                <div className="pub-evidence-frame ratio-4-3">
                  <img
                    src="/marketing/report-sample-b-fabric-stain.webp"
                    alt={isZh ? "样品 B 麻灰纯棉针织汗布前幅下摆局部褐黄色表面污点微距特写图" : "Macro close-up of a localized brownish surface stain on the heather-gray cotton jersey knit of Sample B"}
                    width={1200}
                    height={900}
                    loading="eager"
                  />
                  {showAnnotations && (
                    <svg className="pub-bbox-svg" viewBox="0 0 1200 900" aria-hidden="true">
                      <rect
                        x="220"
                        y="295"
                        width="375"
                        height="295"
                        rx="8"
                        fill="rgba(220, 38, 38, 0.12)"
                        stroke="#dc2626"
                        strokeWidth="4"
                      />
                    </svg>
                  )}
                </div>
              </button>
              <div className="pub-defect-schema-card">
                <div className="pub-defect-coords">
                  <div><span>{isZh ? "成衣部位" : "Garment Zone"}</span><strong>{isZh ? "前片下摆区" : "Lower Front Panel"}</strong></div>
                  <div><span>{isZh ? "标注位置" : "Callout Position"}</span><strong className="mono">{isZh ? "前幅汗布面" : "Front Jersey Panel"}</strong></div>
                  <div><span>{isZh ? "观测尺寸" : "Observed Size"}</span><strong>{isZh ? "约 8 mm 表面污点" : "~8 mm surface spot"}</strong></div>
                </div>
              </div>
              <figcaption>
                <div>
                  <span className="code" style={{ color: "#b24046", fontWeight: 800, fontSize: 11 }}>
                    {isZh ? "瑕疵记录 · 面料表面污渍" : "DEFECT RECORD · FABRIC SURFACE"}
                  </span>
                  <strong>
                    {isZh
                      ? "样品 B (S39202)：前片下摆区域发现约 8 mm 局部褐黄色污点"
                      : "Sample B (S39202): Localized ~8 mm brownish spot on lower front panel"}
                  </strong>
                  <span>
                    {isZh
                      ? "附带经复核的规范文字描述及对应微距原片，方便您向供应商清晰举证沟通。"
                      : "Reviewed English observation paired with the original studio macro frame so you can share clear visual proof with your supplier."}
                  </span>
                </div>
              </figcaption>
            </figure>
          </div>
        </section>

        {/* 8. Findings, Buyer Routing & Limitations */}
        <section className="pub-report-section" id="findings-limitations">
          <p className="pub-eyebrow">{isZh ? "08 · 实检结论、买家逐件处置与声明边界" : "08 · FINDINGS, ITEM ROUTING & LIMITATIONS"}</p>
          <h3>{isZh ? "客户检后逐件处置指令示例（展示用途）" : "Recorded Buyer Post-Inspection Instructions (Illustrative Example)"}</h3>
          <div className="tablewrap" style={{ marginTop: 12 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isZh ? "样衣编号" : "Sample ID"}</th>
                  <th>{isZh ? "演示观测记录" : "Illustrative Observation Entry"}</th>
                  <th>{isZh ? "检后买家处置指令示例" : "Example Post-Report Buyer Instruction"}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono"><strong>S39201</strong></td>
                  <td>{isZh ? "各部位尺寸符合公差范围；单件实称 238 g；车缝整洁无异常。" : "Measurements within target tolerance; 238 g garment mass; clean seams."}</td>
                  <td>
                    <span className="tag green">{isZh ? "转为封存标杆样" : "Convert to Golden Sample"}</span>{" "}
                    {isZh ? <>· 装入防篡改密封袋并归档至确认样档案库（<span className="code">REF-A03-14</span>）。</> : <>· Sealed into secure reference sample storage (<span className="code">REF-A03-14</span>).</>}
                  </td>
                </tr>
                <tr>
                  <td className="mono"><strong>S39202</strong></td>
                  <td>
                    {isZh ? (
                      <>胸围超出目标值 +1.6 cm；实称克重 214 g；含 2 处瑕疵标注（<span className="code">B-DEF-01/02</span>）。</>
                    ) : (
                      <>Chest +1.6 cm over spec; 214 g garment weight; annotated issues (<span className="code">B-DEF-01/02</span>).</>
                    )}
                  </td>
                  <td>
                    <span className="tag red">{isZh ? "国内退回卖家" : "Return to Seller"}</span>{" "}
                    {isZh ? "· 由买家协商卖家提供国内退回地址并确认快递运费报价。" : "· Buyer arranges seller RMA & domestic courier return quote."}
                  </td>
                </tr>
                <tr>
                  <td className="mono"><strong>S39203</strong></td>
                  <td>{isZh ? "尺寸符合目标公差；单件实称 241 g；做工车缝合格。" : "Dimensions within target tolerance; 241 g garment weight; clean seams."}</td>
                  <td>
                    <span className="tag blue">{isZh ? "发往国内集运仓" : "Forward to Freight Forwarder"}</span>{" "}
                    {isZh ? "· 打包并国内寄达买家指定的国际货代集运仓库。" : "· Consolidated to buyer’s China forwarder address."}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>{isZh ? "报告边界声明：" : "Report limitation notice:"}</strong>{" "}
            {isZh
              ? "QC Warehouse 仅客观呈现到仓样本实测事实，不替买家对供应商评分排名，也不为未检验的大货或卖家货款退赔做出商业保证。"
              : "QC Warehouse does not rank suppliers or make commercial pass/fail guarantees on unobserved bulk production. Merchandise refund eligibility for returned items remains subject to your purchase agreement with the seller."}
          </p>
        </section>

        {/* 9. Report Version & PDF Export */}
        <section className="pub-report-section" id="version-history">
          <p className="pub-eyebrow">{isZh ? "09 · 版本锁定与 PDF 导出演示" : "09 · REPORT VERSION, IMMUTABILITY & PDF EXPORT"}</p>
          <h3>{isZh ? "已发布报告不可变修订留痕与 PDF 打印" : "Published Revision Audit Trail & Printable PDF"}</h3>
          <div className="grid cols3" style={{ marginTop: 12 }}>
            <div className="def">
              <dt>{isZh ? "已发布快照版本" : "Published Snapshot"}</dt>
              <dd>{isZh ? "版本 2 · 已复核锁定" : <>Version 2 · Reviewed &amp; Locked</>}</dd>
            </div>
            <div className="def">
              <dt>{isZh ? "工位与 QA 签核链路" : <>Bench &amp; QA Sign-Off</>}</dt>
              <dd>{isZh ? "质检员 INS-04 → 审校员 REV-02" : "Inspector INS-04 → Reviewer REV-02"}</dd>
            </div>
            <div className="def">
              <dt>{isZh ? "修订原因（v1 → v2）" : "Revision Reason (v1 → v2)"}</dt>
              <dd>{isZh ? "补充样品 B 侧缝微距英文说明" : "Added Sample B seam macro translation"}</dd>
            </div>
          </div>
          <div className="line-note success" style={{ marginTop: 12, marginBottom: 16 }}>
            {isZh
              ? "QC Warehouse 每份经审校定版的报告快照一经发布即永久锁定：网页浏览与下载的 PDF 始终严格呈现同一份经过核验的尺寸读数、瑕疵坐标与修订历史，绝不静默篡改。"
              : "Every reviewed inspection report version in QC Warehouse is locked as a permanent snapshot—online views and downloaded PDFs always render the exact same verified measurements, defect coordinates, and revision history without silent edits."}
          </div>

          <div className="row between flexwrap no-print" id="pdf-download" style={{ gap: 16, padding: 18, background: "#f8fafd", borderRadius: 12, border: "1px solid #e2ebf5" }}>
            <div>
              <strong style={{ display: "block", fontSize: 15, color: "#102038", marginBottom: 4 }}>
                {isZh ? "保存演示打印版 PDF 或创建您的真实质检订单" : "Save a Print/PDF Copy or Commission Your Own Inspection"}
              </strong>
              <p className="small muted" style={{ margin: 0 }}>
                {isZh
                  ? "正式客户订单支持服务端一键导出同步排版 PDF，并可生成可随时撤销的只读共享链接供工厂查看。"
                  : "Real customer orders include one-click server-generated PDF downloads and optional revocable read-only share links for suppliers."}
              </p>
            </div>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <button type="button" className="button" onClick={() => window.print()}>
                {isZh ? "打印 / 保存样本 PDF" : "Print / Save Sample PDF"}
              </button>
              <Link className="button" href={hrefFor("/pricing")}>
                {isZh ? "试算检验费用" : "Estimate Inspection Fee"}
              </Link>
              <Link className="button primary" href="/orders/new">
                {isZh ? "立即创建委托 →" : "Start an Inspection →"}
              </Link>
            </div>
          </div>
        </section>
      </article>

      {/* Lightbox Modal for Evidence Inspection */}
      {lightbox && (
        <div
          className="lightbox-backdrop no-print"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.title}
          onClick={() => setLightbox(null)}
        >
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <div>
              <span className="code" style={{ color: "#93b8ff", fontSize: 12 }}>{lightbox.code}</span>
              <strong style={{ display: "block", fontSize: 15 }}>{lightbox.title}</strong>
            </div>
            <button type="button" className="button sm" onClick={() => setLightbox(null)}>
              {isZh ? "关闭大图预览 ✕" : "Close Preview ✕"}
            </button>
          </div>
          <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
            <img className="lightbox-img" src={lightbox.src} alt={lightbox.alt} />
          </div>
          <div style={{ textAlign: "center", fontSize: 12.5, color: "#cbd8ea" }} onClick={(e) => e.stopPropagation()}>
            {lightbox.caption}
          </div>
        </div>
      )}
    </>
  );
}
