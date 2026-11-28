"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { localizePublicPath, type EnabledLocale } from "../packages/core/locale-contract";
import { useLocale } from "./i18n-client";

type FaqEntry = {
  id: string;
  question: string;
  questionZh: string;
  answer: string;
  answerZh: string;
};

type FaqCategory = {
  key: string;
  title: string;
  titleZh: string;
  items: FaqEntry[];
};

const FAQ_CATEGORIES: FaqCategory[] = [
  {
    key: "suppliers-receiving",
    title: "Suppliers & Receiving",
    titleZh: "供应商发货与入仓签收",
    items: [
      {
        id: "multi-supplier",
        question: "Can I send items from multiple Chinese suppliers?",
        questionZh: "可以将多家中国供应商的货物分别寄到仓内检验吗？",
        answer:
          "Yes. You purchase directly from any combination of 1688, Alibaba, Taobao, or direct factories in China and have each seller ship domestically to your QC Warehouse receiving address with your personal receiving code. Register each seller’s carrier tracking number in your workspace so our intake team can match split parcels accurately.",
        answerZh:
          "可以。您直接向 1688、淘宝、阿里巴巴或国内工厂下单后，让每位卖家按国内快递分别寄往您的专属收货仓址及永久收件码，并在工作台提前登记卖家运单号，便于仓库精准分拣归户。",
      },
      {
        id: "sourcing",
        question: "Are you a sourcing or purchasing agent?",
        questionZh: "你们从事商品代采、拼单或贸易代理吗？",
        answer:
          "No. You purchase merchandise directly from your suppliers. We don't source or sell products, pay sellers, or negotiate merchandise prices—staying independent from your suppliers ensures our inspection reports remain objective.",
        answerZh:
          "不从事任何代采与销售。商品均由买家自行采购付款，QC Warehouse 保持绝对独立第三方立场，不经手货款或议价，确保每份质检结论客观真实。",
      },
      {
        id: "receiving-address",
        question: "How do I send items to the QC Warehouse China receiving center?",
        questionZh: "如何获取中国收货仓库地址并寄送样品？",
        answer:
          "Create a free account to receive our China warehouse address and your permanent personal receiving code. Paste both into your supplier’s shipping details, then add the domestic courier tracking number to your order in QC Warehouse.",
        answerZh:
          "免费注册账号即可获配中国收货默认公共仓址及永久个人收件码（QCW-XXXXX）。请将二者填给中国卖家寄件信息，并在委托单登记对应国内物流单号。",
      },
      {
        id: "missing-receiving-code",
        question: "What happens if a seller forgets to write my receiving code on the label?",
        questionZh: "如果卖家忘记在面单上写我的专属收件码怎么办？",
        answer:
          "Add the seller’s original carrier tracking number in your workspace as soon as the parcel ships. Uncoded or mismatched parcels are held securely in quarantine until ownership is verified—never opened to other accounts.",
        answerZh:
          "请尽快在订单中补录卖家原始运单号。未标明收件码或归属存疑的包裹将暂存于待核验/隔离区，严格通过运单号及开箱核验确认归属后才会对客户开放。",
      },
      {
        id: "arrival-damage",
        question: "What happens if a parcel arrives damaged?",
        questionZh: "包裹到仓外箱破损怎么处理？",
        answer:
          "Our intake desk photographs visible outer-carton crushing, tearing, or moisture at arrival and logs an intake exception linked to the carrier waybill before unboxing, giving you timestamped evidence to review with your seller.",
        answerZh:
          "仓内收货台会在拆箱前对明显挤压、破损或受潮外箱拍照存证，并登记关联运单的入库异常工单，为您提供第一时间带时间戳的维权依据。",
      },
      {
        id: "short-shipment",
        question: "What if fewer items arrive than expected?",
        questionZh: "实际到仓件数比下单委托数量少怎么处理？",
        answer:
          "Every unboxed item is counted and tagged individually against your declared order quantity. If a parcel contains fewer or more units than declared, the system flags a quantity discrepancy with intake photos and pauses affected lines until you confirm how to proceed.",
        answerZh:
          "开箱后仓库会逐件点清数量并贴码。若实收与申报数量不一致（少发或多发），系统会附开箱照片挂起差异工单并冻结相关订单行，待您确认后再恢复作业或先行放行已就绪件。",
      },
    ],
  },
  {
    key: "services-scope",
    title: "Services & Scope",
    titleZh: "质检服务模式与边界",
    items: [
      {
        id: "service-scope",
        question: "What is the difference between Product Inspection and Sample Comparison?",
        questionZh: "实物商品质检（逐件全检）和供应商样品横向对比有什么区别？",
        answer:
          "Product Inspection checks 1 to 100+ items individually (priced per physical item), giving each piece its own checklist record—ideal for prototypes or small-batch inventory. Sample Comparison evaluates 2 or 3 comparable items together as one set (priced per group) under identical camera framing and flat measurement landmarks so you can compare candidate suppliers or batches side by side.",
        answerZh:
          "实物商品质检按实际委托件数逐件作业并分别建档（1–100+件，按件计费）；样品横向对比则将 2–3 家候选供应商的同类样品锁定在同一拍摄光源与尺寸基准下同组评估（按组计费），直观呈现各家尺寸偏差与工艺高下。",
      },
      {
        id: "piece-by-piece-batch",
        question: "Can you inspect 30 or 50 items individually, and how does that differ from a 1–3 item sample check?",
        questionZh: "支持 30 件或 50 件小批量逐件质检吗？和 1–3 件打样检查一样吗？",
        answer:
          "Yes. Standard Product Inspection supports 1 to 100 items self-serve online, assigning every single unit its own barcode ID, measurements, and defect log—whether you are evaluating 1–3 prototype samples in detail or screening 10–100 small-batch stock garments before export. Orders of 101 to 300 items are supported via a manual staff capacity quote.",
        answerZh:
          "完全支持。线上自助可下 1–100 件标准委托，从 1 件样衣到几十上百件中小批量均赋予每件唯一条码与独立检验/瑕疵记录，而不是按比例粗抽。101–300 件以上则由人工核定工台排期与交期。",
      },
      {
        id: "golden-sample",
        question: "Can you compare new items with my approved sample?",
        questionZh: "可以把大货来料与之前封存确认的标杆样（Golden Sample）对照吗？",
        answer:
          "Yes—through Golden Sample / Reference Matching. After an item has been inspected in QC Warehouse, you can request its conversion into a Golden Sample; our staff seals it inside secure reference sample storage. Future incoming samples can then be ordered under Reference Matching for direct physical side-by-side comparison.",
        answerZh:
          "可以。在任一历史订单结案处置中，您均可申请将合格单品转为标杆确认样封存于专用样品库。后续新下单选择「标杆确认样对照」时，将严格使用物理封存的实体样直接进行尺寸、颜色与细节比对。",
      },
      {
        id: "measurements",
        question: "What exactly do you measure and check?",
        questionZh: "具体会测量哪些尺寸、执行哪些检查项？",
        answer:
          "Checkpoints follow the published template for your chosen category—for example, Tops & Knitwear records HPS length, flat chest width, shoulder, sleeve, hem, garment weight, label details, and zone workmanship. Measurements use calibrated metric tapes (0.1 cm precision) with automatic two-pass re-checks when readings exceed variance thresholds.",
        answerZh:
          "检查项按已发布的品类模板执行，例如上衣类包含后中/肩点衣长、1/2 胸围、肩宽、袖长、领罗纹、克重称重、洗唛核对及分区外观检查。量尺采用校准米尺（0.1 cm 精度），超差时系统强制复测并留存带刻度米尺照片。",
      },
      {
        id: "guarantee-boundaries",
        question: "Do you guarantee that the items meet my specifications or are 100% defect-free?",
        questionZh: "报告是否等同于对未到仓大货质量的承诺或 100% 零缺陷担保？",
        answer:
          "No. QC Warehouse is an independent physical inspection service, not the manufacturer or an accredited laboratory. We document observable workmanship and flat measurements on the commissioned items received, and clearly state what was not tested (such as chemical fiber composition, wash shrinkage, safety certification, authenticity, or unreceived factory bulk stock).",
        answerZh:
          "不是。QC Warehouse 只对「实际到仓并纳入当次委托」的实体货品进行客观无损查验与实测记录，并在报告中写明未测试边界；不对未到仓大货、水洗缩率、纤维化验、正品鉴定及认证合规提供保证。",
      },
      {
        id: "certification",
        question: "Is a QC Warehouse report a laboratory test or compliance certificate?",
        questionZh: "质检报告能否替代第三方实验室理化检测或出口认证？",
        answer:
          "No. Reports document non-destructive physical observations and dimensional checks at our receiving studio. Chemical composition, GSM cut-swatch tests, flammability, CPSIA/REACH compliance, and formal certifications require accredited third-party laboratories.",
        answerZh:
          "不能。我们的报告仅记录无损物理观察、尺寸实测和图片证据；若涉及成分破坏取样、色牢度水洗、CPSIA/REACH 等法规认证，请送检资质实验室。",
      },
    ],
  },
  {
    key: "reports-pricing",
    title: "Reports, Pricing & Turnaround",
    titleZh: "报告交付、收费定价与时效",
    items: [
      {
        id: "before-deciding",
        question: "Can I see photos and measurements before deciding where items go?",
        questionZh: "我可以在看过完整实拍图与测量数据后，再决定各件货物的去向吗？",
        answer:
          "Yes—that is the core purpose of QC Warehouse. We publish your online English report and matching downloadable PDF (complete with metric tape photos, re-measurement logs, and red defect bounding boxes) first. You review the evidence and only then submit item-by-item return, storage, or forwarding instructions.",
        answerZh:
          "是的，这正是我们的核心机制。报告经独立 QA 复核发布并生成对应语言（英文/中文/双语）PDF 后，您查看实测照片、复测对比和坐标瑕疵标注，再按件下达退商家、留存或发集运指令。",
      },
      {
        id: "fee-included",
        question: "What is included in the inspection fee?",
        questionZh: "标准质检服务费包含哪些项目，哪些费用另计？",
        answer:
          "The inspection or comparison fee covers parcel arrival check-in, individual barcode tagging, execution of all checkpoints in the selected template, mandatory overview/measurement/defect photography, independent QA review, a reviewed English inspection report + PDF, and the initial post-report decision custody window. Outbound domestic postage and extended storage are separate.",
        answerZh:
          "质检/对比费已包含到仓签收、拆包贴码、所选模板检查点实施、规范实拍与瑕疵标框、独立 QA 复核、报告及 PDF 发布，以及初始处置观察期托管。检后国内退货/集运快递运费与超期仓储费另按实际计收。",
      },
      {
        id: "turnaround",
        question: "How long does inspection take?",
        questionZh: "检验通常需要几个工作日？SLA 从什么时候开始计时？",
        answer:
          "Active standard apparel packages estimate 3 business days. Turnaround timing starts only after all commissioned items for the order have physically arrived at our China facility, passed ownership/count check-in, and order payment is confirmed.",
        answerZh:
          "标准服装模板常规预计约 3 个工作日，但具体交期会根据商品复杂度、所选模块、测点与视频拍摄密度及仓内实时排班产能动态计算。计时严格在「订单完成付款 + 实物到齐核验无阻断」后才启动。",
      },
      {
        id: "payment",
        question: "How do billing and refunds work?",
        questionZh: "如何付款以及服务费和商品货款如何退款？",
        answer:
          "Orders are priced per commission (no monthly subscription) and processed in USD via Stripe. Inspection fee refund eligibility depends on whether physical warehouse work has started under our Terms of Service. Refunds for the merchandise itself must be requested directly from the seller you bought from.",
        answerZh:
          "按次委单 USD 计费，不捆绑会员订阅，由 Stripe 处理线上付款。平台检验费退款按《服务条款》依据实际履约进度核定；商品本身的退换货款则由买家按与卖家的交易协议向原供应商申请。",
      },
    ],
  },
  {
    key: "routing-returns",
    title: "Returns, Storage & Forwarding",
    titleZh: "检后退货、仓内托管与发往集运",
    items: [
      {
        id: "after-inspection",
        question: "What happens to items after inspection?",
        questionZh: "检验完成后，我的商品有哪些处置去向选择？",
        answer:
          "Every inspected item stays tagged in organized staging until you issue an instruction in your workspace: Return to Seller (domestic China), Forward to your designated Freight Forwarder in China, Store for later consolidation, or Convert an approved item into a sealed Golden Sample.",
        answerZh:
          "每件实物在检后按件独立挂牌托管，由您逐件发出处置指令：退回中国原卖家、合并/拆分寄往您在华指定的集运仓或货代地址、继续仓内暂存合并，或封存为标杆确认样。",
      },
      {
        id: "seller-returns",
        question: "Can you return defective items to the seller?",
        questionZh: "次品可以由仓库直接按我的退货地址寄回卖家吗？",
        answer:
          "Yes. First request return approval from your Chinese seller and obtain their domestic return address and recipient phone number. Submit those details in QC Warehouse, approve and pay the domestic return courier quote, and our team will pack the selected items, hand them to the courier, and record the outbound tracking number. Note that courier dispatch does not guarantee the seller will issue a merchandise refund.",
        answerZh:
          "可以。请先向卖家申请退货并获取中国境内收件地址及联系电话，在客户工作台逐件选择退回商品并填写退货地址，确认支付国内代寄运费后，仓库会打包寄出并回传真实承运商及退货单号。仓库代寄完成不代表保证卖家退款成功。",
      },
      {
        id: "forwarding",
        question: "Do you arrange international shipping or customs clearance?",
        questionZh: "你们是否提供国际干线运输或目的国清关服务？",
        answer:
          "QC Warehouse dispatches domestically within mainland China to your chosen international freight forwarder or consolidator warehouse (including your forwarder suite/member code) after you approve the domestic shipping quote. International air/sea linehaul and destination customs clearance are handled by your freight forwarder.",
        answerZh:
          "我们负责中国大陆境内转运发往您指定的集运仓或国际货代站点（支持标注货代入仓唛头/会员码）；国际空海运干线运输与目的国清关则由您的国际货代负责。",
      },
      {
        id: "restricted-items",
        question: "Which products are restricted from delivery to QC Warehouse?",
        questionZh: "哪些禁限寄或暂未开放品类不可寄往仓库？",
        answer:
          "Hazardous materials, batteries/electronics, liquids, cosmetics, food, pressurized containers, counterfeit branded goods, and unapproved product categories must not be shipped to our facility. Review the Restricted Items Policy before ordering from suppliers.",
        answerZh:
          "易燃易爆危险品、带电/液体/化妆品/食品/压缩罐体、仿牌侵权货物以及尚未正式开放准入的类目均不可寄往仓库。请在卖家发货前查阅《禁限寄规则》。",
      },
      {
        id: "refunds",
        question: "How do I get support for an active inspection order?",
        questionZh: "进行中的订单或质检结果若有疑问如何联系客服？",
        answer:
          "Sign in to your customer workspace and open a support case directly from the order or support desk, including your order number (QW-…) or carrier waybill so our operations team can inspect the exact chain-of-custody record.",
        answerZh:
          "请登录客户工作台，直接在对应订单详情页或「客服工单」提交工单并附上订单号（QW-…）或快递单号，运营与仓库团队会调取完整操作留痕与图片核实回复。",
      },
    ],
  },
];

function buildFaqJsonLd(locale: EnabledLocale) {
  const isZh = locale === "zh-CN";
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_CATEGORIES.flatMap((cat) =>
      cat.items.map((item) => ({
        "@type": "Question",
        name: isZh ? item.questionZh : item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: isZh ? item.answerZh : item.answer,
        },
      })),
    ),
  };
}

export function FAQ() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string>("all");

  useEffect(() => {
    const reveal = () => {
      const hashId = location.hash.slice(1);
      if (!hashId) return;
      const item = document.getElementById(hashId);
      if (item instanceof HTMLDetailsElement) {
        item.open = true;
        item.scrollIntoView({ block: "start" });
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);

  const term = query.trim().toLowerCase();
  const groups = FAQ_CATEGORIES.filter((cat) => activeCat === "all" || cat.key === activeCat)
    .map((cat) => ({
      ...cat,
      items: cat.items.filter(
        (item) =>
          !term ||
          item.question.toLowerCase().includes(term) ||
          item.questionZh.toLowerCase().includes(term) ||
          item.answer.toLowerCase().includes(term) ||
          item.answerZh.toLowerCase().includes(term),
      ),
    }))
    .filter((cat) => cat.items.length > 0);

  return (
    <div className="faq">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(buildFaqJsonLd(locale)) }}
      />

      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? "常见问题与买家帮助中心" : "FAQ & Buyer Help Center"}</strong>
      </div>

      <section className="pub-page-hero">
        <div className="row between flexwrap" style={{ gap: 16 }}>
          <div>
            <p className="pub-eyebrow">
              {isZh ? "买家帮助中心 · 服务边界与仓内操作指引" : "BUYER HELP CENTER · DECISION & OPERATIONS FAQ"}
            </p>
            <h1 style={{ marginBottom: 8 }}>{isZh ? "常见问题解答 (FAQ)" : "Frequently Asked Questions"}</h1>
            <p style={{ marginBottom: 0 }}>
              {isZh
                ? "清晰解答多供应商分批发货、1–100+ 件逐件检验与横向对比规则、报告免责边界、退回中国卖家以及发往集运仓的完整履约机制。"
                : "Clear, policy-accurate answers on shipping from multiple Chinese suppliers, 1–100+ item piece-by-piece checks, sample comparisons, scope boundaries, seller returns, and freight-forwarder handoff."}
            </p>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary" href={hrefFor("/contact")}>
              {isZh ? "提交售前或范围咨询 →" : "Ask a Question →"}
            </Link>
            <Link className="button" href="/orders/new">
              {isZh ? "创建质检委托" : "Start Inspection"}
            </Link>
          </div>
        </div>
      </section>

      <div className="pub-filter-pills" role="tablist" aria-label={isZh ? "问题分类" : "FAQ topic categories"}>
        <button
          type="button"
          className={`pub-filter-pill${activeCat === "all" ? " active" : ""}`}
          onClick={() => setActiveCat("all")}
        >
          {isZh ? "全部主题" : "All Topics"} ({FAQ_CATEGORIES.reduce((n, c) => n + c.items.length, 0)})
        </button>
        {FAQ_CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            className={`pub-filter-pill${activeCat === cat.key ? " active" : ""}`}
            onClick={() => setActiveCat(cat.key)}
          >
            {isZh ? cat.titleZh : cat.title} ({cat.items.length})
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="selectbar" style={{ marginBottom: 14 }}>
          <div className="search">
            <input
              type="search"
              aria-label={isZh ? "搜索常见问题" : "Search FAQ"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                isZh
                  ? "搜索关键词：多卖家合并寄、50件逐件检、退卖家、集运仓、确认样…"
                  : "Search e.g. multiple suppliers, 50 items, return to seller, forwarder, Golden Sample…"
              }
            />
          </div>
          {query && (
            <button type="button" className="button sm" onClick={() => setQuery("")}>
              {isZh ? "清空搜索" : "Clear search"}
            </button>
          )}
        </div>

        {groups.length === 0 && (
          <p role="status" className="notice">
            {isZh ? "未检索到匹配问题，请尝试更换关键词或 " : "No matching questions found. Try clearing your filter or "}
            <Link href={hrefFor("/contact")}>
              {isZh ? "直接联系人工客服团队提交咨询" : "send our inspection desk a direct inquiry"}
            </Link>
            .
          </p>
        )}

        {groups.map((group) => (
          <section className="faq-group" key={group.key} style={{ marginBottom: 18 }}>
            <h2 style={{ fontSize: "1.08rem", margin: "10px 0 8px", color: "#15325c" }}>
              {isZh ? group.titleZh : group.title}
            </h2>
            {group.items.map((item) => (
              <details className="faq-item" key={item.id} id={item.id}>
                <summary>
                  <span>{isZh ? item.questionZh : item.question}</span>
                  <span className="tag gray" style={{ flexShrink: 0 }}>
                    {isZh ? group.titleZh : group.title}
                  </span>
                </summary>
                <p style={{ fontSize: 13.5, lineHeight: 1.62, color: "#344861" }}>
                  {isZh ? item.answerZh : item.answer}
                </p>
                <a className="button sm" style={{ marginTop: 4 }} href={`#${item.id}`}>
                  {isZh ? "复制锚点直达" : "Direct link"}
                </a>
              </details>
            ))}
          </section>
        ))}
      </div>

      <div className="actions">
        <Link className="button primary" href={hrefFor("/catalog")}>
          {isZh ? "浏览服务与套餐目录" : "Explore Services & Packages"}
        </Link>
        <Link className="button" href={hrefFor("/pricing")}>
          {isZh ? "试算质检服务费" : "Estimate Inspection Fee"}
        </Link>
        <Link className="button" href={hrefFor("/legal/restricted-items")}>
          {isZh ? "禁限寄合规政策" : "Restricted Items Policy"}
        </Link>
        <Link className="button" href={hrefFor("/legal/terms")}>
          {isZh ? "服务条款" : "Terms of Service"}
        </Link>
      </div>
    </div>
  );
}
