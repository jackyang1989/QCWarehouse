import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { transaction } from "../packages/db";
import { actorForSession } from "../packages/core/auth";
import { isDemo } from "../packages/core/common";
import { localizePublicPath, type EnabledLocale } from "../packages/core/locale-contract";
import { catalog } from "../packages/core/orders";
import { PlatformIcon, PublicFooter, PublicHeader } from "./chrome";
import { LocaleProvider } from "./i18n-client";
import { homeJsonLd, metadataForPath } from "./public-seo";
import { SampleReportPreview } from "./report-guide";

export const metadata: Metadata = metadataForPath("/", true);

type LiveOffer = {
  offer_id: string;
  sku_code: string;
  service: string;
  title: { en: string };
  category: { en: string };
  content?: { subcategory?: string };
  rules: {
    minimum: number;
    maximum: number;
    unit_cents?: number;
    package_cents?: number;
    business_days: number;
    demo?: boolean;
  };
};

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function summarizeRate(pool: LiveOffer[], unitSuffix: string): string {
  const amounts = pool
    .map((o) => Number(o.rules.unit_cents ?? o.rules.package_cents ?? 0))
    .filter((n) => n > 0);
  if (!amounts.length) return "See live quote";
  const lo = Math.min(...amounts);
  const hi = Math.max(...amounts);
  return lo === hi ? `${formatUsd(lo)} ${unitSuffix}` : `${formatUsd(lo)}–${formatUsd(hi)} ${unitSuffix}`;
}

const TRUST_CAPABILITIES = [
  [
    "packages",
    "China Receiving Center",
    "Buy directly from Chinese suppliers and ship parcels to your dedicated receiving code.",
  ],
  [
    "scan",
    "Individual Sample & Small-Batch Inspection",
    "Inspect 1–3 prototype samples in detail or screen 10–100+ small-batch items piece by piece.",
  ],
  [
    "reports",
    "Measurements, Photos & Documented Findings",
    "Flat-lay measurements, seam details, and defect bounding boxes linked to item IDs.",
  ],
  [
    "dispatch",
    "Return, Store, or Forward",
    "Decide per item after reading the report—return defects to sellers or forward good stock.",
  ],
] as const;

type BuyerScenario = {
  tag: string;
  title: string;
  body: string;
  wide: boolean;
  image?: string;
  imageAlt?: string;
};

const BUYER_SCENARIOS: BuyerScenario[] = [
  {
    tag: "Supplier Selection",
    title: "Compare supplier samples before choosing a factory",
    body: "Receive one synchronized comparison report with side-by-side overhead photos, a landmark measurement delta table, and weight and workmanship notes across 2 or 3 candidate factories.",
    wide: false,
    image: "/marketing/home-supplier-comparison.webp",
    imageAlt:
      "Three supplier crewneck T-shirt samples in oatmeal, slate, and olive laid side by side on a white inspection bench with a digital gram scale and yellow measuring tape",
  },
  {
    tag: "Small-Batch QC",
    title: "Inspect small-batch orders item by item",
    body: "Every unit receives its own traceable sample ID, flat-lay metric tape photos, workmanship check, and coordinate-tagged defect record—so you can separate clean stock from returnable defects.",
    wide: false,
    image: "/marketing/home-small-batch-inspection.webp",
    imageAlt:
      "Overhead view of a small-batch garment inspection station with folded T-shirts, opened courier polybags, and a white-gloved inspector measuring a sample",
  },
  {
    tag: "Restock Consistency",
    title: "Match new items against approved reference samples",
    body: "Seal your approved Golden Sample in our China vault and receive paired Reference-vs-Incoming photos plus exact dimensional and shade variance records on every reorder.",
    wide: false,
    image: "/marketing/home-reference-comparison.webp",
    imageAlt:
      "Approved reference navy sweatshirt emerging from a protective polybag on the left compared against an incoming restock sweatshirt measured by a white-gloved inspector",
  },
];

const PROCESS_STAGES = [
  {
    step: "01",
    owner: "You (Buyer)",
    title: "Create Inspection",
    body: "Select your apparel category, service type, quantity, and optional target tolerances in your online workspace.",
  },
  {
    step: "02",
    owner: "You + Chinese Seller",
    title: "Send Products to Our China Receiving Center",
    body: "Purchase directly from your chosen suppliers, ship to our China address with your permanent receiving code, and log the seller’s tracking number.",
  },
  {
    step: "03",
    owner: "QC Warehouse Intake",
    title: "Receive & Identify Each Item",
    body: "We verify physical parcel arrival independently of carrier scans, check carton condition, and tag every garment with a unique sample ID.",
  },
  {
    step: "04",
    owner: "QC Warehouse Studio & QA",
    title: "Inspect, Compare & Review",
    body: "Inspectors follow the approved category checklist, record flat tape measurements and defect photos, and publish an independently reviewed English report.",
  },
  {
    step: "05",
    owner: "Your Instruction → QC Warehouse",
    title: "Return, Store or Forward",
    body: "Review the report online or by PDF, then issue item-by-item instructions to return to the seller, retain as a Golden Sample, or dispatch to your forwarder.",
  },
] as const;

export async function PublicHomePage({ locale = "en-US" }: { locale?: EnabledLocale } = {}) {
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const actor = await actorForSession((await cookies()).get("session")?.value);
  const accountHref = actor?.kind === "customer" ? "/account" : undefined;
  const offers = (await transaction(catalog).catch(() => [])) as LiveOffer[];

  const inspOffers = offers.filter((o) => o.service === "inspection");
  const compOffers = offers.filter((o) => o.service === "compare");
  const refOffers = offers.filter((o) => o.service === "reference_match");
  const hasDemoRates = offers.some((o) => o.rules?.demo === true);

  const primaryInspOffer = inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0];
  const primaryCompOffer = compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0];
  const primaryRefOffer = refOffers[0];

  const inspRate = summarizeRate(inspOffers, isZh ? "/ 件" : "/ item");
  const compRate = summarizeRate(compOffers, isZh ? "/ 组" : "/ group");
  const refRate = summarizeRate(refOffers, isZh ? "/ 次比对" : "/ match");

  const coreServices = [
    {
      icon: "inspection",
      title: isZh ? "单件与中小批量实物检验" : "Product Inspection",
      rate: inspRate,
      href: hrefFor("/services/inspection"),
      orderHref: primaryInspOffer ? `/orders/new?offer=${primaryInspOffer.offer_id}` : "/orders/new",
      positioning: isZh
        ? "在中国工作台对研发样衣（1–3 件）及中小批量备货（10–100+ 件）逐件拆包查验。"
        : "Piece-by-piece verification for prototype samples (1–3 pcs) and small-batch inventory (10–100+ pcs) at our China studio.",
      highlights: isZh
        ? [
            "每件赋予唯一条码 ID 与必拍全视角高清实拍图",
            "0.1 cm 平铺带尺测量与双人交叉复测校验",
            "瑕疵坐标标注原图与规范化独立复核报告",
          ]
        : [
            "Unique barcode ID & mandatory angle photos per garment",
            "0.1 cm flat-lay tape measurements with two-pass re-checks",
            "Coordinate-boxed defect notes & English PDF report",
          ],
    },
    {
      icon: "compare",
      title: isZh ? "2–3 家供应商样品横向对比" : "Sample Comparison",
      rate: compRate,
      href: hrefFor("/services/compare"),
      orderHref: primaryCompOffer ? `/orders/new?offer=${primaryCompOffer.offer_id}` : "/orders/new",
      positioning: isZh
        ? "在统一灯光与测量基准下，将 2–3 家候选工厂同款样品同框对照评测。"
        : "Side-by-side evaluation of 2 or 3 comparable candidate samples from different suppliers under identical lighting.",
      highlights: isZh
        ? [
            "同框俯拍全景图与关键局部对齐细节对比照",
            "统一关键部位尺寸差值横向对比表",
            "大货下单定金前看清克重、走线与辅料差距",
          ]
        : [
            "Single-frame group photo & aligned detail shots",
            "Unified measurement delta table across identical landmarks",
            "Fabric weight, stitching & trim comparison before deposit",
          ],
    },
    {
      icon: "packages",
      title: isZh ? "确认样封存与补货比对" : "Golden Sample Matching",
      rate: refRate,
      href: hrefFor("/services/reference"),
      orderHref: primaryRefOffer ? `/orders/new?offer=${primaryRefOffer.offer_id}` : "/orders/new",
      positioning: isZh
        ? "将已批准的标杆确认样封存在中国样品库，后续新打样或复购大货来料逐项对比查验。"
        : "Physical benchmark verification of a new pre-production or restock piece against your sealed Golden Sample.",
      highlights: isZh
        ? [
            "标准参照样与来料样同台左右对照影棚实拍",
            "逐部位尺寸、克重与色差偏移量化记录",
            "防拆封签管理，保障确认样长期基准安全",
          ]
        : [
            "Paired Reference-vs-Incoming side-by-side studio photos",
            "Point-by-point dimensional, weight & shade drift log",
            "Tamper-evident resealing in our reference sample vault",
          ],
    },
  ] as const;

  const trustItems = isZh
    ? [
        ["packages", "中国独立收货中心", "从国内供应商采购后直接寄往您的专属收货码仓位。"],
        ["scan", "单件打样与中小批量逐件查验", "兼顾 1–3 件深度打样验货与 10–100+ 件逐件筛选。"],
        ["reports", "实测尺码、实拍与瑕疵存证", "平铺量尺照片、走线特写与可追溯件号的坐标瑕疵框。"],
        ["dispatch", "检后退货、留存或发集运仓", "审阅报告后逐件下达退回卖家、封存留样或转寄货代指令。"],
      ]
    : TRUST_CAPABILITIES;

  const scenarioItems = isZh
    ? [
        {
          tag: "选厂比样",
          title: "大货敲定前，横向比较多家供应商样品",
          body: "一次获得同框俯拍实景对比图、统一基准尺寸差异表，以及 2–3 家候选工厂样品克重与工艺实录。",
          wide: false,
          image: BUYER_SCENARIOS[0].image,
          imageAlt: BUYER_SCENARIOS[0].imageAlt,
        },
        {
          tag: "中小批量全检",
          title: "按件建档逐件查验中小批量采购订单",
          body: "每件货品均有专属样衣编号、带米尺实拍照片、工艺核查与坐标瑕疵标记，精准剔除可退换次品。",
          wide: false,
          image: BUYER_SCENARIOS[1].image,
          imageAlt: BUYER_SCENARIOS[1].imageAlt,
        },
        {
          tag: "补货一致性",
          title: "新来货直接对照已封存标杆确认样检验",
          body: "将审核通过的确认样长期封存于中国仓内，每次补货来料均附标准对比照片与尺寸色差漂移台账。",
          wide: false,
          image: BUYER_SCENARIOS[2].image,
          imageAlt: BUYER_SCENARIOS[2].imageAlt,
        },
      ]
    : BUYER_SCENARIOS;

  const stageItems = isZh
    ? [
        { step: "01", owner: "买家线上下单", title: "创建质检委托单", body: "在工作台选择服装细分品类、服务类型、数量及可选公差范围。" },
        { step: "02", owner: "买家 + 国内卖家", title: "寄往中国专属收货地址", body: "直接向供应商采购，填写专属收件码发往中国仓并登记国内快递单号。" },
        { step: "03", owner: "仓库收货核验", title: "实物签到与逐件赋码", body: "独立核实物理开箱实收状态（不盲信物流签收），为每件商品粘贴唯一追踪条码。" },
        { step: "04", owner: "质检工作室 & QA", title: "实拍实测与独立审核", body: "严格按版本化模板量尺、拍照并记录瑕疵，由独立 QA 复核后发布双语结构化报告。" },
        { step: "05", owner: "客户指令 -> 出库", title: "逐件退货、留样或转寄", body: "查看报告后按件发出退回卖家、封存确认样或发往指定集运仓指令。" },
      ]
    : PROCESS_STAGES;

  return (
    <LocaleProvider initialLocale={locale} authenticated={Boolean(actor)}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(homeJsonLd()) }}
      />
      <PublicHeader
        accountHref={accountHref}
        staff={actor?.kind === "staff"}
        actor={actor}
        demo={isDemo()}
        path={isZh ? "/zh" : "/"}
        locale={locale}
      />

      <main className="marketing" id="main-content" lang={locale}>
        {/* A. HERO */}
        <section className="pub-hero" aria-labelledby="home-title">
          <div className="pub-hero-bg" aria-hidden="true">
            <img
              src="/marketing/home-inspection-studio.webp"
              alt=""
              width={1920}
              height={1080}
              fetchPriority="high"
              loading="eager"
            />
          </div>
          <div className="pub-hero-inner">
            <p className="pub-hero-kicker">
              {isZh ? "中国独立第三方商品到仓质检中心" : "Independent Product Inspection in China"}
            </p>
            <h1 id="home-title">
              {isZh
                ? "货物发往海外前，在中国仓内先看清实品再决定。"
                : "Inspect Before You Ship from China."}
            </h1>
            <p className="pub-hero-sub">
              {isZh
                ? "在承担高额国际运费之前，掌握实际到仓货品、实测尺寸与瑕疵证据。我们在中国本地仓为您拆包查验供应商样品、逐件全检中小批量货品并附高精度尺寸实拍，助您清晰决策退回卖家、留样封存或转寄发运。"
                : "Know what arrived, what was checked, and what to do next — before paying for international shipping. We inspect supplier samples, check small-batch orders item by item, and document quality issues with measurements and photos so you can decide which items to return, store, or forward."}
            </p>
            <div className="pub-hero-actions">
              <Link className="button primary" href="/orders/new">
                {isZh ? "立即创建质检单 →" : "Start an Inspection →"}
              </Link>
              <Link className="button pub-btn-ghost" href={hrefFor("/report-guide")}>
                {isZh ? "查看样板报告" : "View Sample Report"}
              </Link>
            </div>
            <ul className="pub-hero-facts">
              <li><span aria-hidden="true">✓</span>{isZh ? "单件打样及中小批量逐件查验" : "Individual sample & small-batch inspection"}</li>
              <li><span aria-hidden="true">✓</span>{isZh ? "2–3 家供应商样品同台横向对比" : "2–3 supplier sample comparison"}</li>
              <li><span aria-hidden="true">✓</span>{isZh ? "带比例尺测量、高清细节与坐标瑕疵存证" : "Measurements, photos & documented findings"}</li>
              <li><span aria-hidden="true">✓</span>{isZh ? "检后逐件退回卖家、留样封存或发集运仓" : "Per-item return, storage, or forwarding"}</li>
            </ul>
          </div>
        </section>

        {/* TRUST STRIP */}
        <div className="pub-trust-bar">
          <ul className="pub-trust-grid">
            {trustItems.map(([icon, title, desc]) => (
              <li className="pub-trust-item" key={title}>
                <span className="pub-trust-icon">
                  <PlatformIcon name={icon} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <small>{desc}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* B. WHAT WE HELP YOU DO */}
        <section className="pub-section" aria-labelledby="home-scenarios">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">{isZh ? "专为跨境电商品牌与中小批量买家打造" : "BUILT FOR OVERSEAS E-COMMERCE & SMALL-BATCH BUYERS"}</p>
                <h2 id="home-scenarios">{isZh ? "货品离开中国前，我们为您把关关键实证" : "What We Help You Do Before Goods Leave China"}</h2>
                <p className="pub-lead">
                  {isZh
                    ? "QC Warehouse 完全独立于供应商，不从事代采或贸易销售，也非传统第三方囤货仓或整厂验厂机构。寄送您向中国商家采购的商品，即可收获逐件可追溯的清晰实物证据。"
                    : "QC Warehouse is independent from your suppliers—we don't source or sell products, and we are not a 3PL warehouse or factory-floor AQL firm. Send the items you buy from Chinese sellers and get actionable evidence on every piece."}
                </p>
              </div>
              <Link className="button" href={hrefFor("/how-it-works")}>
                {isZh ? "了解仓内收货与作业流程 →" : "See how receiving works →"}
              </Link>
            </div>

            <div className="pub-scenarios">
              {scenarioItems.map((item) => (
                <article
                  key={item.title}
                  className={`pub-scenario-card${item.wide ? " wide" : ""}`}
                >
                  {item.image && (
                    <div className="pub-scenario-media">
                      <img
                        src={item.image}
                        alt={item.imageAlt ?? item.title}
                        width={1350}
                        height={900}
                        loading="eager"
                      />
                    </div>
                  )}
                  <span className="pub-scenario-tag">{item.tag}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* C. CORE INSPECTION SERVICES */}
        <section className="pub-section alt-white" aria-labelledby="home-services">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">{isZh ? "三大核心检验服务" : "CORE INSPECTION SERVICES"}</p>
                <h2 id="home-services">{isZh ? "三种结构化方式核实到仓实物品质" : "Three Structured Ways to Verify Physical Merchandise"}</h2>
                <p className="pub-lead">
                  {isZh
                    ? "每笔委托均按版本化品类规范清单作业，标明测量部位方法与清晰服务边界——让您清楚知悉查验内容与非破坏性外观检的适用范畴。"
                    : "Every commission follows a versioned category checklist with documented measurement methods and clear scope boundaries—so you know both what was checked and what lies outside non-destructive visual inspection."}
                </p>
              </div>
              <Link className="button" href={hrefFor("/catalog")}>
                {isZh ? "对比全部服务与套餐 →" : "Compare all services & packages →"}
              </Link>
            </div>

            <div className="pub-service-pillars">
              {coreServices.map((svc) => (
                <article className="pub-pillar" key={svc.href}>
                  <div className="pub-pillar-body">
                    <div className="pub-pillar-top">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="pub-trust-icon">
                          <PlatformIcon name={svc.icon} />
                        </span>
                        <h3>{svc.title}</h3>
                      </div>
                      <span className="pub-price-chip">{svc.rate}</span>
                    </div>

                    <p className="pub-pillar-positioning">{svc.positioning}</p>

                    <ul className="pub-pillar-highlights">
                      {svc.highlights.map((pt) => (
                        <li key={pt}>{pt}</li>
                      ))}
                    </ul>

                    <div className="pub-pillar-foot">
                      <Link className="button sm" href={svc.href}>
                        {isZh ? "服务详情 →" : "Service details →"}
                      </Link>
                      <Link className="button primary sm" href={svc.orderHref}>
                        {isZh ? "下单检验" : "Start Order"}
                      </Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* D. REAL INSPECTION EVIDENCE */}
        <section className="pub-section" aria-labelledby="home-evidence">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">{isZh ? "实证优先的交付标准" : "EVIDENCE-FIRST DELIVERABLES"}</p>
                <h2 id="home-evidence">{isZh ? "一目了然、可追溯核验的实物查验实证" : "Inspection Evidence You Can Verify at a Glance"}</h2>
                <p className="pub-lead">
                  {isZh
                    ? "拒绝笼统的合格或不合格主观结论。QC Warehouse 将每一条查验观察严格关联至单件条码、带米制比例尺实拍图、坐标框瑕疵标注及不可篡改的报告版本。"
                    : "Instead of vague pass/fail opinions, QC Warehouse links every observation to item barcodes, metric tape-in-frame photos, coordinate-marked defects, and published report versions."}
                </p>
              </div>
              <Link className="button primary" href={hrefFor("/report-guide")}>
                {isZh ? "查看完整样板报告 →" : "Open Full Sample Report →"}
              </Link>
            </div>

            <div className="pub-evidence-layout">
              <div className="pub-evidence-mosaic stacked">
                <figure className="pub-evidence-card span-2">
                  <div className="pub-evidence-frame ratio-4-3">
                    <img
                      src="/marketing/home-seam-defect.webp"
                      alt="Macro close-up of a loose overlock seam stitch loop on a dark navy sweatshirt side seam"
                      width={1200}
                      height={900}
                      loading="eager"
                    />
                    <svg className="pub-bbox-svg" viewBox="0 0 1200 900" aria-hidden="true">
                      <rect
                        x="520"
                        y="275"
                        width="335"
                        height="255"
                        rx="8"
                        fill="rgba(220, 38, 38, 0.10)"
                        stroke="#dc2626"
                        strokeWidth="4"
                      />
                    </svg>
                  </div>
                  <figcaption>
                    <div>
                      <strong>{isZh ? "坐标标注瑕疵实录（原图零修图）" : "Annotated Workmanship Documentation"}</strong>
                      <span>{isZh ? "通过叠加坐标框高亮局部车缝、面料或表面瑕疵，绝不修改或涂抹原始相机证据。" : "Coordinate boxes highlight localized seam, fabric, or surface flaws without ever editing original camera evidence."}</span>
                    </div>
                  </figcaption>
                </figure>

                <figure className="pub-evidence-card span-2">
                  <div className="pub-evidence-frame">
                    <img
                      src="/marketing/home-sorting-dispatch.webp"
                      alt="Outbound sorting and dispatch bench with folded garments, export shipping carton, and digital parcel scale"
                      width={1350}
                      height={760}
                      loading="eager"
                    />
                  </div>
                  <figcaption>
                    <div>
                      <strong>{isZh ? "检后严格分拣与发运追踪" : "Traceable Post-Inspection Sorting & Packing"}</strong>
                      <span>{isZh ? "合格品与待退卖家货品按单件样衣条码独立分区放置，直至您的发运指令正式执行。" : "Approved stock and seller-return pieces stay separated by individual sample barcode until your dispatch instructions are executed."}</span>
                    </div>
                  </figcaption>
                </figure>
              </div>

              <div style={{ display: "grid", gap: 16 }}>
                <SampleReportPreview />
                <div className="pub-surface-box" style={{ padding: 20 }}>
                  <strong style={{ fontSize: 14, color: "#10223a" }}>{isZh ? "每份已发布报告均包含：" : "What every published report documents:"}</strong>
                  <ul className="pub-check-list" style={{ marginTop: 4 }}>
                    <li><b className="mark-ok">✓</b><span>{isZh ? "成衣正反面实拍、领标水洗标特写与包裹拆封记录" : "Garment front/back views, collar/care-label details, and parcel intake records"}</span></li>
                    <li><b className="mark-ok">✓</b><span>{isZh ? "平铺尺度测量、测量位置基准与双人复测数值记录" : "Flat dimensional measurements with unit, method, and re-measurement readings"}</span></li>
                    <li><b className="mark-ok">✓</b><span>{isZh ? "走线、缝口与表面瑕疵高清特写及坐标标注" : "Stitching, seam, and surface defect close-ups with coordinate callouts"}</span></li>
                    <li><b className="mark-ok">✓</b><span>{isZh ? "多件对比矩阵表（适用于 2–3 件对比与确认样比对订单）" : "Side-by-side comparison tables (for 2–3 sample comparison & Golden Sample orders)"}</span></li>
                    <li><b className="mark-ok">✓</b><span>{isZh ? "明确列明未检项目与非实验室/非整厂验厂范围声明" : "Explicit statement of uninspected items (no lab, chemical, wash, or factory-wide AQL claims)"}</span></li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* E. HOW IT WORKS */}
        <section className="pub-section alt-navy" aria-labelledby="home-process">
          <div className="pub-container">
            <div className="pub-section-head">
              <div>
                <p className="pub-eyebrow">{isZh ? "五阶段实物监管链路" : "5-STAGE PHYSICAL CHAIN OF CUSTODY"}</p>
                <h2 id="home-process">{isZh ? "从国内包裹到仓到逐件处置发运" : "How It Works—From Supplier Parcel to Item Routing"}</h2>
                <p className="pub-lead">
                  {isZh
                    ? "每一环节责任边界清晰。您的货物从入仓至出库全程保留您的所有权。"
                    : "Clear operational ownership at every step. Your merchandise remains your property from arrival through outbound dispatch."}
                </p>
              </div>
              <Link className="button pub-btn-ghost" href={hrefFor("/how-it-works")}>
                {isZh ? "查看完整流程与规则 →" : "Full process & rules →"}
              </Link>
            </div>

            <ol className="pub-steps-5">
              {stageItems.map((st) => (
                <li className="pub-step-card" key={st.step}>
                  <div className="pub-step-top">
                    <span className="pub-step-num">{st.step}</span>
                    <span className="pub-step-owner">{st.owner}</span>
                  </div>
                  <h3>{st.title}</h3>
                  <p>{st.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* F. CATEGORY COVERAGE & LIVE PRICING PREVIEW */}
        <section className="pub-section alt-white" aria-labelledby="home-pricing-preview">
          <div className="pub-container">
            <div className="pub-split-2">
              {/* Category Focus */}
              <div className="pub-surface-box">
                <div>
                  <p className="pub-eyebrow">{isZh ? "当前支持类目" : "CATEGORY COVERAGE"}</p>
                  <h2 className="pub-h2">{isZh ? "服装类目现已正式开放 — 依托细分子类模板执行" : "Apparel Is Live Today—Built Around Subcategory Checklists"}</h2>
                  <p className="pub-lead" style={{ fontSize: 14 }}>
                    {isZh
                      ? "每个商品类目须经量尺规范、棚拍布光与检验模板校验后方可上架开放。目前可下单检验服装全系列子类："
                      : "We open categories only after measurement methods, studio lighting, and inspection templates are validated. Today we inspect apparel across dedicated templates:"}
                  </p>
                </div>

                <div className="pub-rate-rows">
                  <div className="pub-rate-row">
                    <div>
                      <strong>{isZh ? "上衣、T 恤、卫衣与针织衫" : "Tops, T-Shirts, Hoodies & Knitwear"}</strong>
                      <small>{isZh ? "后中长/HPS衣长、胸围、肩宽、袖长、下摆、领口罗纹与缝线" : "HPS length, chest width, shoulder, sleeve, hem, collar rib & seams"}</small>
                    </div>
                    <span className="tag green">{isZh ? "已开放" : "Active"}</span>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>{isZh ? "打底裤、长裤、短裤与下装" : "Leggings, Pants, Shorts & Bottoms"}</strong>
                      <small>{isZh ? "腰宽、臀围、前后浪、大腿围、内长、外长与三角裆工艺" : "Waistband, hip, front/back rise, thigh, inseam, outseam & gusset"}</small>
                    </div>
                    <span className="tag green">{isZh ? "已开放" : "Active"}</span>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>{isZh ? "运动内衣与贴身健身服饰" : "Sports Bras & Intimate Activewear"}</strong>
                      <small>{isZh ? "下围松紧、胸围宽、肩带对称性、罩杯里衬与回弹目视检查" : "Underband, bust width, strap symmetry, cup lining & elastic recovery visual check"}</small>
                    </div>
                    <span className="tag green">{isZh ? "已开放" : "Active"}</span>
                  </div>
                </div>

                <p className="small muted" style={{ margin: 0 }}>
                  {isZh
                    ? "规划与限制类目：鞋靴、箱包配饰与家居用品处于规划接入阶段，暂不开放下单；电子产品与受管制儿童用品属禁限寄范畴。"
                    : "Planned & restricted categories: Footwear, Bags & Accessories, and Home Goods are planned for future rollout and cannot be ordered yet. Electronics and regulated children’s products are restricted."}
                </p>

                <div className="row flexwrap" style={{ gap: 10, marginTop: "auto" }}>
                  <Link className="button" href={hrefFor("/categories")}>
                    {isZh ? "查看全部支持品类 →" : "Explore Supported Products →"}
                  </Link>
                  <Link className="button" href={hrefFor("/contact?topic=category")}>
                    {isZh ? "咨询其他品类支持" : "Ask About Another Category"}
                  </Link>
                </div>
              </div>

              {/* Pricing Preview */}
              <div className="pub-surface-box" id="home-pricing-preview">
                <div>
                  <p className="pub-eyebrow">{isZh ? "透明服务收费标准" : "TRANSPARENT SERVICE PRICING"}</p>
                  <h2 className="pub-h2">{isZh ? "质检费与后续发运运费完全分开计价" : "Clear Inspection Fees—Separate from Shipping"}</h2>
                  <p className="pub-lead" style={{ fontSize: 14 }}>
                    {isZh
                      ? "按实时服务价目表针对委托件数或对比组数计收；国内退货或转寄集运仓运费仅在您审阅完报告并选定处置件后再精准核价。"
                      : "Pay per commissioned item or comparison set based on our active server catalog. Domestic return or forwarding postage is quoted only after you review your report and select items."}
                  </p>
                </div>

                {hasDemoRates && (
                  <div className="line-note warning" style={{ margin: 0, fontSize: 12 }}>
                    <strong>{isZh ? "价格状态提示：" : "Catalog status note:"}</strong>{" "}
                    {isZh
                      ? "当前展示价格对应演练/预览环境价目表，实际扣款均以您下单确认报价快照为准。"
                      : "Displayed rates reflect the active pre-launch / demo server schedule. Exact price snapshots are confirmed on your order quote before payment."}
                  </div>
                )}

                <div className="pub-rate-rows">
                  <div className="pub-rate-row">
                    <div>
                      <strong>{isZh ? "逐件实物检验" : "Piece-by-Piece Product Inspection"}</strong>
                      <small>{isZh ? "1–100 件线上自助下单 · 含通用与细分服装检验模板" : "1–100 items online · General & subcategory apparel templates"}</small>
                    </div>
                    <div className="pub-rate-val">
                      <b>{inspRate}</b>
                      <span>{isZh ? "101+ 件可申请人工报价" : "101+ items: manual quote"}</span>
                    </div>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>{isZh ? "多供应商样品横向对比" : "Side-by-Side Sample Comparison"}</strong>
                      <small>{isZh ? "2 件或 3 件同类商品同组同框对比评估" : "2 or 3 comparable items evaluated together as one group"}</small>
                    </div>
                    <div className="pub-rate-val">
                      <b>{compRate}</b>
                      <span>{isZh ? "支持 2 件组与 3 件组" : "2-item & 3-item sets"}</span>
                    </div>
                  </div>
                  <div className="pub-rate-row">
                    <div>
                      <strong>{isZh ? "标杆确认样对照检验" : "Golden Sample Reference Matching"}</strong>
                      <small>{isZh ? "新来料样对照您在仓封存的基准样逐项比对" : "Incoming sample compared against your retained reference"}</small>
                    </div>
                    <div className="pub-rate-val">
                      <b>{refRate}</b>
                      <span>{isZh ? "按每件来料样计" : "per incoming sample"}</span>
                    </div>
                  </div>
                </div>

                <div className="row flexwrap" style={{ gap: 10, marginTop: "auto" }}>
                  <Link className="button primary" href={hrefFor("/pricing")}>
                    {isZh ? "打开费用计算器与明细表 →" : "Open Fee Calculator & Rate Table →"}
                  </Link>
                  <Link className="button" href={hrefFor("/catalog#packages")}>
                    {isZh ? "查看全部套餐方案" : "View All Packages"}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* G. FINAL CTA */}
        <section className="pub-section">
          <div className="pub-container">
            <div className="pub-cta-banner">
              <div>
                <p className="pub-eyebrow" style={{ color: "#93b8ff" }}>{isZh ? "准备好核验您的下一批货品了吗？" : "READY TO VERIFY YOUR NEXT SHIPMENT?"}</p>
                <h2>{isZh ? "支付国际运费前，先在中国仓内查清每一件实品。" : "Know What Arrived in China Before Paying International Freight."}</h2>
                <p>
                  {isZh
                    ? "免费注册 QC Warehouse 账号即可立即领取专属中国收货仓址与永久收件码，在线配置首笔样品对比或中小批量全检订单。"
                    : "Create your free QC Warehouse account to get your dedicated China receiving address and permanent parcel code, configure your first sample comparison or small-batch inspection, and see documented measurements and photos before committing inventory overseas."}
                </p>
              </div>
              <div className="pub-cta-actions">
                <Link className="button primary" href="/orders/new">
                  {isZh ? "立即开始下单质检 →" : "Start an Inspection →"}
                </Link>
                <Link className="button pub-btn-ghost" href={hrefFor("/contact")}>
                  {isZh ? "咨询定制检验范围" : "Ask About Custom Scope"}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter locale={locale} />
    </LocaleProvider>
  );
}

export default async function Home() {
  return <PublicHomePage locale="en-US" />;
}
