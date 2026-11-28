"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { localizePublicPath } from "../packages/core/locale-contract";
import { useLocale } from "./i18n-client";
import { Empty, ErrorBlock, Form, Panel, request, text, useLoad } from "./ui";

type Receipt = { public_no: string; case_id?: string };

type ContactConfig = {
  support_email: string;
  whatsapp_enabled: boolean;
  whatsapp_verified: boolean;
  whatsapp_number: string | null;
  whatsapp_url: string | null;
  business_hours_zh: string;
  business_hours_en: string;
  response_sla_zh: string;
  response_sla_en: string;
  timezone: string;
};

const INQUIRY_TOPICS = [
  { id: "general", labelEn: "General Questions", labelZh: "常规咨询", tag: "GENERAL" },
  { id: "scope", labelEn: "Inspection Scope & Checkpoints", labelZh: "质检范围与查验要点", tag: "INSPECTION SCOPE" },
  { id: "quote", labelEn: "Quantity / Custom Quotation (100+ Items)", labelZh: "大批量/定制报价（100+件）", tag: "CUSTOM QUOTATION" },
  { id: "category", labelEn: "Category Availability", labelZh: "品类开放咨询", tag: "CATEGORY AVAILABILITY" },
  { id: "existing", labelEn: "Existing Order Support", labelZh: "现有订单售后", tag: "EXISTING ORDER" },
] as const;

export function PublicInquiry() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const searchParams = useSearchParams();
  const { data, error, reload } = useLoad("/public/inquiry-categories");
  const contactConfigLoad = useLoad("/public/contact-config");
  const contactConfig = contactConfigLoad.data as ContactConfig | undefined;
  const [receipt, setReceipt] = useState<Receipt>();
  const [topic, setTopic] = useState<string>("general");
  const [sampleCount, setSampleCount] = useState<string>("1");
  const submission = useRef<{ payload: string; key: string }>(null);

  useEffect(() => {
    const paramTopic = searchParams.get("topic");
    if (paramTopic && INQUIRY_TOPICS.some((t) => t.id === paramTopic)) {
      setTopic(paramTopic);
    }
    const paramQty = searchParams.get("qty");
    if (paramQty && Number(paramQty) >= 1) {
      setSampleCount(String(Math.floor(Number(paramQty))));
    } else if (paramTopic === "quote") {
      setSampleCount("120");
    }
  }, [searchParams]);

  const requestedItem = searchParams.get("item");
  const selectedTopicObj = INQUIRY_TOPICS.find((t) => t.id === topic) ?? INQUIRY_TOPICS[0];
  const supportEmail = contactConfig?.support_email ?? "support@qcwarehouse.com";
  const showWhatsApp = Boolean(
    contactConfig?.whatsapp_enabled &&
      contactConfig?.whatsapp_verified &&
      contactConfig?.whatsapp_url &&
      contactConfig?.whatsapp_number,
  );
  const hoursText = isZh
    ? (contactConfig?.business_hours_zh ?? "周一至周六 09:00–18:00（北京时间）")
    : (contactConfig?.business_hours_en ?? "Mon–Sat 09:00–18:00 (Asia/Shanghai · UTC+8)");
  const slaText = isZh
    ? (contactConfig?.response_sla_zh ?? "1 个工作日内人工回复（非实时在线聊天）")
    : (contactConfig?.response_sla_en ?? "Within 1 Business Day (Async ticket review)");

  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? "联系客服与售前定制咨询" : "Contact & Commercial Inquiries"}</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-split">
          <div>
            <p className="pub-eyebrow">
              {isZh ? "售前咨询与人工工单服务台（非实时聊天）" : "COMMERCIAL INQUIRY & SUPPORT DESK (NON-REALTIME)"}
            </p>
            <h1>{isZh ? "联系 QC Warehouse 质检支持团队" : "Contact QC Warehouse Inspection Support"}</h1>
            <p style={{ marginBottom: 14 }}>
              {isZh
                ? "欢迎咨询服装类目检查要点、申请 100+ 件批量人工排期报价、了解规划中品类开放计划，或跟进已提交的质检订单。所有咨询均生成真实工单与邮件回执，不采用虚假实时聊天。"
                : "Ask pre-order questions about apparel checkpoints, request custom batch pricing for 100+ items, inquire about planned product categories, or connect with support regarding an active order. Every inquiry logs a real tracked ticket (no live chat simulation)."}
            </p>
            <p style={{ marginBottom: 16 }}>
              {isZh ? "官方联系邮箱：" : "Email support at "}
              <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
              {showWhatsApp && contactConfig?.whatsapp_url ? (
                <>
                  {" · "}
                  <a href={contactConfig.whatsapp_url} target="_blank" rel="noopener noreferrer">
                    WhatsApp ({contactConfig.whatsapp_number})
                  </a>
                </>
              ) : null}
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                {isZh ? "立即自助下单 →" : "Start Self-Serve Order →"}
              </Link>
              <Link className="button" href={hrefFor("/faq")}>
                {isZh ? "浏览常见问题 FAQ" : "Browse Buyer FAQ"}
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>{isZh ? "预计人工回复时限" : "Response Target"}</span>
              <strong>{slaText}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "营业服务时段" : "Business Hours"}</span>
              <strong>{hoursText}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "线上自助下单" : "Self-Serve Online"}</span>
              <strong>{isZh ? "1–100 件实时核价" : "1–100 Units Instant Quote"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "人工排期专席" : "Custom Batch Desk"}</span>
              <strong>{isZh ? "101–300+ 件按需排期" : "101–300+ Units Scheduled"}</strong>
            </div>
          </div>
        </div>
      </section>

      {/* Topic Selector */}
      <div className="pub-filter-pills" role="group" aria-label={isZh ? "选择咨询主题" : "Select inquiry topic"}>
        {INQUIRY_TOPICS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`pub-filter-pill${topic === item.id ? " active" : ""}`}
            onClick={() => setTopic(item.id)}
          >
            {isZh ? item.labelZh : item.labelEn}
          </button>
        ))}
      </div>

      {topic === "existing" && (
        <div className="line-note" style={{ marginBottom: 18 }}>
          <strong>{isZh ? "已有 QC Warehouse 客户账号？" : "Have an active QC Warehouse account?"}</strong>{" "}
          {isZh ? (
            <>
              建议登录后从 <Link href="/support"><strong>客户工单</strong></Link> 或 <Link href="/orders"><strong>我的订单</strong></Link> 提交问题，系统将自动关联订单号（<span className="code">QW-…</span>）与包裹记录。如无法登录也可通过下方表单留言。
            </>
          ) : (
            <>
              Signing in and opening a ticket from <Link href="/support"><strong>Customer Support</strong></Link> or <Link href="/orders"><strong>My Orders</strong></Link> attaches your order ID (<span className="code">QW-…</span>) and parcel records automatically for faster resolution. You may also submit the form below if you cannot access your account.
            </>
          )}
        </div>
      )}

      <div className="detail-layout">
        <div>
          {receipt ? (
            <Panel title={isZh ? "咨询已进入人工客服工单队列" : "Inquiry Logged in Support Queue"}>
              <p role="status">
                {isZh ? "您的咨询已成功创建工单，追踪编号：" : "Your inquiry has been recorded under ticket reference "}
                <strong className="code">{receipt.public_no}</strong>.
              </p>
              <p>
                {isZh
                  ? "请妥善保存该工单编号以便后续跟进。运营与仓库支持团队将在工作时段内以中英双语人工审核您的范围与批量咨询。"
                  : "Keep this reference number for follow-up. Our operations desk reviews scope and custom-quantity inquiries in English and Chinese business hours."}
              </p>
              <div className="actions" style={{ marginTop: 14 }}>
                {receipt.case_id && (
                  <Link className="button primary sm" href={"/support/cases/" + receipt.case_id}>
                    {isZh ? "查看工单详情 →" : "Open Support Case →"}
                  </Link>
                )}
                <button type="button" className="button sm" onClick={() => setReceipt(undefined)}>
                  {isZh ? "继续发送下一条咨询" : "Send another inquiry"}
                </button>
                <Link className="button sm" href={hrefFor("/catalog")}>
                  {isZh ? "浏览服务目录" : "Browse Services"}
                </Link>
              </div>
            </Panel>
          ) : (
            <Panel title={`${isZh ? "提交咨询" : "Submit Inquiry"} — ${isZh ? selectedTopicObj.labelZh : selectedTopicObj.labelEn}`}>
              {error && (
                <>
                  <ErrorBlock error={error} />
                  <button type="button" className="button sm" onClick={reload}>
                    {isZh ? "重试加载表单" : "Retry loading form"}
                  </button>
                </>
              )}
              {!data && !error && <p role="status" className="muted">{isZh ? "正在加载咨询表单…" : "Loading inquiry form…"}</p>}
              {data &&
                !error &&
                (data.categories.length ? (
                  <Form
                    label={isZh ? "提交售前咨询并获取工单号" : "Submit Commercial Inquiry"}
                    run={async (f) => {
                      const rawCompany = text(f, "company").trim();
                      const rawOrderRef = text(f, "order_ref").trim();
                      const rawBody = text(f, "description").trim();
                      const metaParts = [`[${selectedTopicObj.tag}]`];
                      if (rawCompany) metaParts.push(`Brand/Company: ${rawCompany}`);
                      if (rawOrderRef) metaParts.push(`Order/Waybill: ${rawOrderRef}`);
                      const header = metaParts.join(" · ");
                      const combined = `${header}\n${rawBody}`.slice(0, 1000);
                      const qtyNum = Math.max(1, Math.floor(Number(text(f, "sample_count")) || 1));

                      const payload = {
                        email: text(f, "email").toLowerCase(),
                        category_id: text(f, "category_id"),
                        sample_count: qtyNum,
                        description: combined,
                      };
                      const serialized = JSON.stringify(payload);
                      if (submission.current?.payload !== serialized) {
                        submission.current = { payload: serialized, key: crypto.randomUUID() };
                      }
                      setReceipt(await request("/public/inquiries", "POST", payload, submission.current.key));
                    }}
                  >
                    <div className="fields">
                      <label>
                        {isZh ? "联系邮箱" : "Business email"}
                        <input
                          name="email"
                          type="email"
                          placeholder="you@brand.com"
                          required
                          maxLength={254}
                          autoComplete="email"
                        />
                      </label>
                      <label>
                        {isZh ? "相关商品类目" : "Closest product category"}
                        <select name="category_id" required defaultValue={data.categories[0]?.id ?? ""}>
                          {data.categories.map((c: { id: string; label: string }) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {isZh ? "预计检验件数" : "Estimated item quantity"}
                        <input
                          name="sample_count"
                          type="number"
                          min={1}
                          max={100000}
                          step={1}
                          required
                          value={sampleCount}
                          onChange={(e) => setSampleCount(e.target.value)}
                        />
                      </label>
                      <label>
                        {isZh ? "品牌 / 店铺名称（选填）" : "Brand / store name (optional)"}
                        <input
                          name="company"
                          type="text"
                          maxLength={120}
                          placeholder={isZh ? "例如：独立品牌 / Shopify 店铺名" : "Your company or Shopify store"}
                        />
                      </label>
                    </div>

                    {topic === "existing" && (
                      <label style={{ marginTop: 12 }}>
                        {isZh ? "订单号或国内快递单号（选填）" : "Order number or domestic tracking number (optional)"}
                        <input name="order_ref" type="text" maxLength={80} placeholder={isZh ? "如 QW-… 或国内快递单号" : "e.g. QW-… or SF123456789"} />
                      </label>
                    )}

                    <label style={{ marginTop: 14 }}>
                      {isZh ? "请描述您的需求或问题" : "How can our inspection team help?"}
                      <textarea
                        name="description"
                        required
                        maxLength={900}
                        defaultValue={
                          requestedItem
                            ? (isZh ? `咨询品类开通状态与质检可行性：${requestedItem}。 ` : `Inquiring about category readiness and inspection feasibility for: ${requestedItem}. `)
                            : ""
                        }
                        placeholder={
                          isZh
                            ? "请说明商品品类、预计数量、重点核验尺寸/工艺及期望交付时间…"
                            : topic === "quote"
                            ? "Describe your garment types, total quantity, target delivery window, and whether you need piece-by-piece checks…"
                            : topic === "scope"
                            ? "Tell us the garment construction, specific measurements, or defects you want documented…"
                            : "Share your product type, approximate sample or batch size, and questions…"
                        }
                      />
                    </label>
                    <small>
                      {isZh
                        ? "提交后会生成 QC Warehouse 真实人工客服工单（限 900 字内）。请勿在留言中填写密码或银行卡号。"
                        : "Submitted inquiries create a real tracked support ticket in QC Warehouse (up to 900 characters). Do not include passwords or payment card numbers."}
                    </small>
                  </Form>
                ) : (
                  <Empty>{isZh ? "暂无可用的公开咨询分类。" : "Public inquiry categories are currently unavailable."}</Empty>
                ))}
            </Panel>
          )}
        </div>

        <aside style={{ display: "grid", gap: 16 }}>
          <Panel title={isZh ? "下单前我们可以为您确认" : "What We Can Confirm Before You Order"}>
            <ul className="pub-check-list" style={{ marginTop: 0 }}>
              <li>
                <b className="mark-ok">✓</b>
                <span>{isZh ? "您的成衣版型最匹配的细分质检模板与测量部位" : "Which apparel template fits your garment construction"}</span>
              </li>
              <li>
                <b className="mark-ok">✓</b>
                <span>{isZh ? "101–300+ 件中小批量全检的工台产能与排期交期" : "Studio bench capacity & turnaround for 101–300+ item runs"}</span>
              </li>
              <li>
                <b className="mark-ok">✓</b>
                <span>{isZh ? "专项查验要点是否属于无损外观/尺寸查验范围" : "Whether a specialized checkpoint can be observed non-destructively"}</span>
              </li>
              <li>
                <b className="mark-no">—</b>
                <span>{isZh ? "我们不提供代采付款、工厂整批验厂、破坏性化学测试或代与卖家谈赔" : "We cannot source suppliers, pay sellers, perform lab chemical tests, or negotiate seller refunds"}</span>
              </li>
            </ul>
          </Panel>

          <Panel title={isZh ? "常用自助服务入口" : "Self-Serve Shortcuts"}>
            <p className="small muted">
              {isZh
                ? "标准服装（1–100 件逐件检验或 2–3 件横向对比）无需等待报价，可立即在线创建订单。"
                : "Ready to inspect standard Apparel (1–100 items or 2–3 sample comparison)? You can start immediately without waiting for a manual quote."}
            </p>
            <div className="actions" style={{ marginTop: 10 }}>
              <Link className="button primary sm" href="/orders/new">{isZh ? "立即下单 →" : "Start Inspection →"}</Link>
              <Link className="button sm" href={hrefFor("/pricing")}>{isZh ? "费用试算器" : "Fee Estimator"}</Link>
              <Link className="button sm" href={hrefFor("/faq")}>{isZh ? "阅读 FAQ" : "Read FAQ"}</Link>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
