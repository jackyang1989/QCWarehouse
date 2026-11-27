import type { EnabledLocale, FixedResourceEntry } from "../locale-contract";

function entry(
  key: string,
  en: string,
  zh: string,
  placeholders: readonly string[] = [],
): FixedResourceEntry {
  return {
    kind: "fixed",
    key,
    placeholders,
    values: {
      "en-US": en,
      "zh-CN": zh,
    },
  };
}

export const FIXED_I18N_RESOURCES: readonly FixedResourceEntry[] = [
  // Public Navigation & Chrome
  entry("nav.public.services", "Services", "服务项目"),
  entry("nav.public.categories", "Categories", "支持类目"),
  entry("nav.public.howItWorks", "How It Works", "质检流程"),
  entry("nav.public.sampleReports", "Sample Reports", "报告示例"),
  entry("nav.public.pricing", "Pricing", "收费标准"),
  entry("nav.public.faq", "FAQ", "常见问题"),
  entry("nav.public.contact", "Contact Support", "联系客服"),
  entry("nav.public.home", "Overview", "官网首页"),

  entry("public.taglineHeader", "INDEPENDENT PRODUCT INSPECTION IN CHINA", "中国独立实物商品质检中心"),
  entry("public.signIn", "Sign In", "登录"),
  entry("public.myWorkspace", "My Workspace", "客户工作台"),
  entry("public.signOut", "Sign Out", "退出登录"),
  entry("public.startInspection", "Start Inspection", "立即下单质检"),
  entry(
    "public.footerLead",
    "Independent product inspection in China, supplier sample comparison, and post-inspection item routing for international e-commerce brands and small-batch buyers.",
    "为中国跨境电商与中小批量采购商提供独立实物到仓质检、供应商样品横向对比及检后逐件处置发运服务。",
  ),
  entry(
    "public.footerBoundary",
    "Service scope: {brand} inspects and photographs physical samples at our China facility before international dispatch. We don't source or sell products, and factory AQL audits or laboratory certifications sit outside our scope.",
    "服务边界：{brand} 仅在中国仓对实际到仓样品与货物进行拆包查验、实测与拍照存证；不从事代采销售，不包含工厂验厂或实验室认证。",
    ["brand"],
  ),
  entry("public.colServices", "Services", "核心服务"),
  entry("public.colProcess", "Process & Evidence", "流程与证据"),
  entry("public.colAccount", "Account & Policies", "账户与条款"),
  entry("public.linkAllPolicies", "All Policies", "全部协议条款"),
  entry("public.linkTerms", "Terms of Service", "服务条款"),
  entry("public.linkPrivacy", "Privacy Policy", "隐私政策"),
  entry("public.linkRestricted", "Restricted Items", "禁限寄规则"),
  entry("public.linkReportNotice", "Report Limitations", "报告声明"),
  entry("public.linkStaffSignIn", "Staff sign-in", "员工入口"),

  // Language Switcher
  entry("lang.enUS", "English", "English"),
  entry("lang.zhCN", "简体中文", "简体中文"),
  entry("lang.switchLabel", "Language selector", "切换界面语言"),
  entry("lang.saving", "Saving...", "保存中..."),

  // Workspace Context & Common Navigation
  entry("workspace.customerTitle", "My Workspace", "客户工作台"),
  entry("workspace.warehouseTitle", "Warehouse Center", "仓库作业中心"),
  entry("workspace.adminTitle", "Operations Admin", "运营管理后台"),
  entry("workspace.customerBadge", "CLIENT WORKSPACE", "客户工作空间"),
  entry("workspace.detailTitle", "Detail Workspace", "详情工作台"),
  entry("workspace.signOutStaff", "Sign out", "退出登录"),
  entry("workspace.signOutCustomer", "Sign out", "退出登录"),
  entry("workspace.securityLink", "Sign-in methods & security", "登录方式与账户安全"),
  entry("workspace.rolePrefix", "Role: {roles}", "岗位：{roles}", ["roles"]),
  entry("workspace.demoBadge", "Demo Mode", "演示模式"),
  entry("workspace.switchHome", "Website", "官网"),
  entry("workspace.switchCustomer", "Customer Portal", "客户中心"),
  entry("workspace.switchWarehouse", "Warehouse", "仓库台"),
  entry("workspace.switchAdmin", "Admin", "管理后台"),
  entry(
    "workspace.internalFooter",
    "{brand} {area} · Timezone {timeZone} · Immutable audit ledger enabled",
    "{brand} {area} · 时区 {timeZone} · 全操作实时写入不可变审计台账",
    ["brand", "area", "timeZone"],
  ),

  // Customer Tabs
  entry("tab.customer.account", "Account", "账户概览"),
  entry("tab.customer.orders", "Orders", "我的订单"),
  entry("tab.customer.newOrder", "New Inspection", "新建质检委托"),
  entry("tab.customer.parcels", "Parcels", "包裹跟踪"),
  entry("tab.customer.items", "Items", "在库实物"),
  entry("tab.customer.reports", "Reports", "质检报告"),
  entry("tab.customer.billing", "Billing", "费用账单"),
  entry("tab.customer.support", "Support", "客服工单"),
  entry("tab.customer.actions", "Action Required", "待办事项"),
  entry("tab.customer.notifications", "Notifications", "消息通知"),

  // Public Homepage Key Blocks (enabling full / vs /zh parity)
  entry("home.heroEyebrow", "Independent Receiving & QC Studio in China", "中国独立收货查验与摄影质检中心"),
  entry(
    "home.heroTitle",
    "Know what arrived, what failed, and what to do next — before international shipping.",
    "发往海外前，先核清实收数量、实物测量与瑕疵证据，再做逐件处置。",
  ),
  entry(
    "home.heroSubtitle",
    "Inspect individual supplier samples (1–3 pcs) or small-batch inventory (10–100+ pcs) with calibrated flat-lay photos, 0.1 cm measurements, and QA-reviewed reports.",
    "支持单件打样复核（1–3 件）、中小批量逐件全检（10–100+ 件）、供应商样品横向对比与确认样比对。",
  ),
  entry("home.ctaPrimary", "Start an Inspection", "创建质检委托"),
  entry("home.ctaSecondary", "View Sample Report", "查看真实样板报告"),
  entry("home.servicesHeading", "Three Focused Inspection Services", "三大专注质检服务"),
  entry("home.processHeading", "Five Clear Stages from Supplier Parcel to Item Routing", "从国内快递到仓到逐件处置发运的五个透明阶段"),

  // Accessibility & UI States
  entry("a11y.skipToContent", "Skip to main content", "跳至主要内容"),
  entry("a11y.primaryNav", "Primary", "主导航"),
  entry("a11y.mobileNav", "Mobile Primary", "移动端主导航"),
  entry("a11y.footerNav", "Footer", "页脚导航"),
  entry("a11y.breadcrumb", "Breadcrumb", "面包屑导航"),
  entry("a11y.openMenu", "Open navigation menu", "展开导航菜单"),
  entry("a11y.closeMenu", "Close navigation menu", "关闭导航菜单"),

  // Lifecycle & Domain States
  entry("state.draft", "Draft", "草稿"),
  entry("state.awaiting_payment", "Awaiting Payment", "待付款"),
  entry("state.awaiting_samples", "Awaiting Samples", "待寄样到仓"),
  entry("state.samples_ready", "Samples Ready", "实物已到齐"),
  entry("state.queued", "Queued", "排队待检"),
  entry("state.inspecting", "Inspecting", "质检进行中"),
  entry("state.qa_review", "QA Review", "独立QA复核中"),
  entry("state.report_ready", "Report Ready", "报告已发布"),
  entry("state.closed", "Closed", "已结单"),
  entry("state.ready", "Ready", "可用就绪"),
  entry("state.quarantined", "Quarantined", "已隔离待核"),
  entry("state.pending", "Pending", "待处理"),
  entry("state.approved", "Approved", "已批准"),
  entry("state.published", "Published", "已发布"),
  entry("state.stale", "Stale (Source Updated)", "源文案已变更待更新"),
  entry("state.failed", "Failed", "失败"),

  // Backend Error Code Localization
  entry("error.UNAUTHORIZED", "Sign in to continue.", "请先登录后再继续操作。"),
  entry("error.FORBIDDEN", "Your current role does not have permission for this action.", "当前角色或作用域无权执行该操作。"),
  entry("error.NOT_FOUND", "Requested record was not found.", "未找到目标记录或无权查看。"),
  entry("error.INVALID_REQUEST", "Review the highlighted fields and try again.", "请求参数校验失败，请检查输入内容。"),
  entry("error.RECORD_CONFLICT", "This record changed concurrently; reload and retry.", "记录状态已发生冲突，请刷新后重试。"),
  entry("error.LOCALE_UNSUPPORTED", "The requested language is not registered.", "所选语言不受系统支持。"),
  entry("error.LOCALE_NOT_ENABLED", "This language is not enabled yet.", "该语言尚未正式启用。"),
  entry("error.NON_TRANSLATABLE_FACT_MUTATION", "Language switches cannot alter business facts such as SKU, address, or currency.", "切换语言不得篡改SKU、原地址或币种等业务事实。"),
  entry("error.STAFF_REAUTH_REQUIRED", "Recent MFA verification is required for this sensitive operation.", "执行该敏感操作需要近期完成 MFA 身份重认证。"),
  entry("error.SOD_VIOLATION", "Separation of duties prevents self-approval of this record.", "职责分离规则禁止由本人审批自己提交的内容。"),
  entry("error.HUMAN_TRANSLATION_LOCKED", "Approved human translation is locked against AI overwrite.", "已人工锁定译文禁止被 AI 自动草稿覆盖。"),
  entry("error.SERVER_ERROR", "The operation failed. Please retry or contact support.", "系统处理失败，请重试或联系技术支持。"),

  // Unified Notifications & Three-Portal Bell
  entry("bell.label", "Notifications", "通知中心"),
  entry("bell.unreadCount", "{count} unread notifications", "有 {count} 条未读通知", ["count"]),
  entry("bell.openInbox", "Open full inbox", "查看全部通知"),
  entry("bell.empty", "No notifications yet.", "暂无消息通知"),
  entry(
    "bell.todoNotice",
    "Marking a notification as read does not complete or close Action Required tasks.",
    "将通知标记为已读不会关闭对应的待办事项（请前往具体业务完成实际操作）。",
  ),
  entry("inbox.securityCategory", "Security & Governance", "安全与权限"),
  entry("inbox.announcementsCategory", "Announcements", "系统公告"),
  entry("inbox.channelInApp", "In-App", "站内"),
  entry("inbox.channelEmail", "Email", "邮件"),
];

const MESSAGE_MAP = new Map<string, FixedResourceEntry>(
  FIXED_I18N_RESOURCES.map((item) => [item.key, item]),
);

export function t(
  locale: EnabledLocale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const rec = MESSAGE_MAP.get(key);
  let template = rec?.values[locale] ?? rec?.values["en-US"] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}

export function localizeErrorCode(
  code: string | null | undefined,
  locale: EnabledLocale,
  fallback?: string,
): string {
  if (code) {
    const k = `error.${code}`;
    if (MESSAGE_MAP.has(k)) {
      return t(locale, k);
    }
  }
  return fallback || t(locale, "error.SERVER_ERROR");
}

/**
 * Formats an authoritative monetary amount in its stored currency without converting exchange rates (§53.2).
 */
export function formatCurrencyFact(
  amountCents: number,
  currency: string,
  locale: EnabledLocale,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
}

export function formatDateTimeLocalized(
  input: string | Date,
  locale: EnabledLocale,
  timeZone = "UTC",
): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}
