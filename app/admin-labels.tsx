"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

export const ORDER_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  draft: { label: "草稿待提交", tone: "gray" },
  awaiting_payment: { label: "待客户付款", tone: "yellow" },
  awaiting_samples: { label: "待样件到仓", tone: "yellow" },
  samples_ready: { label: "已核身待开检", tone: "blue" },
  queued: { label: "待安排质检", tone: "blue" },
  inspecting: { label: "质检进行中", tone: "blue" },
  qa_review: { label: "待 QA 复核", tone: "yellow" },
  report_ready: { label: "报告已发布", tone: "green" },
  action_pending: { label: "待客户处置", tone: "yellow" },
  closed: { label: "已完结", tone: "green" },
  on_hold: { label: "暂停阻塞中", tone: "red" },
  cancelled: { label: "已取消", tone: "gray" },
};

export const PAYMENT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  requires_payment: { label: "待付款", tone: "yellow" },
  processing: { label: "渠道确认中", tone: "blue" },
  succeeded: { label: "支付成功", tone: "green" },
  partially_refunded: { label: "部分退款", tone: "blue" },
  refunded: { label: "已全额退款", tone: "gray" },
  failed: { label: "支付失败", tone: "red" },
  canceled: { label: "已取消/超时", tone: "gray" },
  open: { label: "待付款", tone: "yellow" },
  paid: { label: "已付款", tone: "green" },
  void: { label: "已作废", tone: "gray" },
  reconciliation: { label: "待对账", tone: "red" },
  expired: { label: "报价已过期", tone: "gray" },
};

export const REFUND_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  requested: { label: "待独立审批", tone: "yellow" },
  approved: { label: "已批待渠道退款", tone: "blue" },
  succeeded: { label: "退款已成功", tone: "green" },
  rejected: { label: "已驳回", tone: "red" },
  failed: { label: "渠道退款失败", tone: "red" },
  none: { label: "未退款", tone: "gray" },
  refund_pending: { label: "退款审批/处理中", tone: "yellow" },
  partial_refund: { label: "已部分退款", tone: "blue" },
  full_refund: { label: "已全额退款", tone: "gray" },
  refund_closed: { label: "退款申请已结束", tone: "gray" },
};

export const RECON_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  reconciled: { label: "账实已对平", tone: "green" },
  pending_webhook: { label: "待回调确认", tone: "blue" },
  issue: { label: "存在对账异常", tone: "red" },
  disputed: { label: "渠道争议/拒付", tone: "red" },
  not_applicable: { label: "未入账无需对账", tone: "gray" },
};

export const PURPOSE_ZH: Record<string, string> = {
  inspection: "质检服务费",
  dispatch: "出库/退货代收运费",
  storage: "延期仓储费",
};

export const SERVICE_CODE_ZH: Record<string, string> = {
  inspection: "标准单品/多件质检",
  std: "标准质检",
  compare: "样品横向对比 (2–3件)",
  reference_match: "确认样一致核对",
};

export const USER_STATUS_ZH: Record<string, { label: string; tone: "green" | "yellow" | "red" | "gray" }> = {
  active: { label: "正常启用", tone: "green" },
  restricted: { label: "受限管控", tone: "yellow" },
  disabled: { label: "已停用", tone: "red" },
  closed: { label: "已注销", tone: "gray" },
};

export const TASK_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  PENDING: { label: "待条件就绪", tone: "gray" },
  READY: { label: "待领取开检", tone: "yellow" },
  ASSIGNED: { label: "已指派待检", tone: "blue" },
  IN_PROGRESS: { label: "检验执行中", tone: "blue" },
  SUBMITTED: { label: "已提交待 QA", tone: "yellow" },
  QA_APPROVED: { label: "QA 已通过", tone: "green" },
  VOID: { label: "已作废", tone: "gray" },
};

export const REPORT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  draft: { label: "草稿/退回修改", tone: "yellow" },
  submitted: { label: "已提交待 QA 复核", tone: "yellow" },
  qa_approved: { label: "QA 已批·待生成 PDF", tone: "blue" },
  published: { label: "已正式发布", tone: "green" },
  superseded: { label: "历史旧版本", tone: "gray" },
};

export const TICKET_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  open: { label: "待处理", tone: "red" },
  waiting_customer: { label: "待客户回复", tone: "yellow" },
  waiting_internal: { label: "待内部跟进", tone: "blue" },
  resolved: { label: "已解决", tone: "green" },
  closed: { label: "已关闭", tone: "gray" },
};

export const TICKET_CATEGORY_ZH: Record<string, string> = {
  identity_unclear: "未认领包裹审核",
  receipt_mismatch: "收货数量/品类不符",
  measurement_dispute: "质检结果异议",
  return_info_incomplete: "退货资料待补",
  damage_or_loss: "库内丢损与赔付",
  payment_refund: "付款/对账/退款",
  privacy_share: "隐私与分享请求",
  non_standard_quote: "非标/超规询价",
  recovery: "账号找回双人审批",
  delivery_issue: "派送/收件异常",
  tracking_exception: "物流追踪异常",
  disposal: "逾期/违禁处置",
};

export const INCIDENT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  open: { label: "待调查拟方案", tone: "red" },
  proposed: { label: "待独立财务审批", tone: "yellow" },
  approved_awaiting_customer: { label: "已批待客户确认", tone: "blue" },
  customer_rejected: { label: "客户驳回待重拟", tone: "red" },
  awaiting_payout: { label: "客户已确认·待打款", tone: "yellow" },
  resolved: { label: "已赔付结案", tone: "green" },
  closed: { label: "已关闭", tone: "gray" },
};

export const INCIDENT_KIND_ZH: Record<string, string> = {
  loss: "库内实物缺失",
  damage: "库内物理破损",
  wrong_inspection: "质检重大差错",
};

export const DISPOSAL_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  pending_approval: { label: "待独立审批", tone: "yellow" },
  approved: { label: "已审批待执行", tone: "blue" },
  executed: { label: "已执行归档", tone: "green" },
  cancelled: { label: "已取消", tone: "gray" },
};

export const STOCKTAKE_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  in_progress: { label: "盘点作业中", tone: "blue" },
  submitted: { label: "有差异待主管复核", tone: "yellow" },
  approved: { label: "差异已调账结案", tone: "green" },
  recount: { label: "退回重新复盘", tone: "red" },
};

export const BATCH_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  draft: { label: "客户组批草稿", tone: "gray" },
  confirmed: { label: "待称重计价", tone: "yellow" },
  quoted: { label: "已报价待付款", tone: "yellow" },
  paid: { label: "已付款待打包交接", tone: "blue" },
  completed: { label: "已出库交接", tone: "green" },
  cancelled: { label: "已取消", tone: "gray" },
};

export const DISPOSITION_ACTION_ZH: Record<string, string> = {
  to_forwarder: "发往集运仓",
  to_domestic_address: "发往国内指定地址",
  return_to_seller: "退回原卖家",
  retain: "延长库内保管",
  reserve_reference: "留存为确认样",
};

export const TRANSPORT_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  unknown: { label: "待承运商揽收", tone: "gray" },
  in_transit: { label: "运输在途", tone: "blue" },
  out_for_delivery: { label: "派送中", tone: "blue" },
  delivered: { label: "承运商已签收", tone: "green" },
  returning: { label: "退回途中", tone: "yellow" },
  returned: { label: "已退回", tone: "gray" },
  exception: { label: "物流异常", tone: "red" },
};

export const SYNC_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }> = {
  active: { label: "正常同步", tone: "green" },
  pending: { label: "待首次同步", tone: "gray" },
  needs_verification: { label: "待手机号核验", tone: "yellow" },
  needs_carrier: { label: "待识别承运商", tone: "yellow" },
  delayed: { label: "同步延迟", tone: "yellow" },
  provider_error: { label: "接口查询异常", tone: "red" },
  unsupported: { label: "暂不支持自动查询", tone: "gray" },
  no_record: { label: "暂无物流记录", tone: "gray" },
  stopped: { label: "已停止追踪", tone: "gray" },
};

export const TRACKING_ALERT_KIND_ZH: Record<string, string> = {
  delivered_unreceived: "已签收但仓库未入库",
  stale_transit: "长时间在途无更新",
  delivery_exception: "派送失败/拦截异常",
  returned_to_sender: "快件被退回寄件方",
  sync_failed: "渠道同步连续失败",
};

export const AUDIT_ACTION_ZH: Record<string, string> = {
  complete_registration: "客户完成注册并领取专属收件码",
  create_order: "创建质检草稿订单",
  submit_order: "客户同意条款并提交订单报价",
  issue_manual_quote: "人工核定并下发非标报价",
  payment_confirmed: "确认支付入账",
  payment_reconciliation_required: "标记延迟/重复付款待对账",
  payment_amount_mismatch: "拦截回调金额/币种不符",
  resolve_payment_dispute: "处理支付渠道争议冻结",
  request_refund: "发起原路退款申请",
  approve_refund: "独立复核批准退款",
  reject_refund: "独立复核驳回退款",
  refund_executed: "渠道退款执行完成",
  check_in_package: "仓库实收包裹登记",
  create_intake_items: "拆包生成逐件实物条码",
  assign_item: "实物绑定订单预期位置",
  identify_item: "确认实物 SKU/颜色/尺码核身",
  decide_intake_claim: "核验未认领包裹归属申诉",
  bind_unmatched_owner: "人工绑定未认领包裹客户",
  bind_unmatched_package: "人工绑定未认领包裹至客户档案",
  physical_check_in: "仓库扫码实收包裹入库",
  intake_items: "拆包登记逐件实物编码",
  advice_parcel: "客户登记卖家发运包裹预报",
  create_draft: "创建质检草稿订单",
  edit_draft: "编辑质检草稿订单",
  cancel_order: "取消质检订单",
  hold_order: "人工暂停订单流转 (Hold)",
  resume_order: "人工恢复订单流转 (Resume)",
  close_order: "完结并归档质检订单",
  start_task: "领取并开始单件质检任务",
  record_results: "保存质检实测与拍照证据",
  submit_task: "提交单件质检任务结果",
  publish_report: "正式生成并发布质检报告 PDF",
  authorize_disposition: "客户下达检后实物处置指令",
  plan_dispatch: "创建检后发运/退货出库批次",
  confirm_dispatch: "客户确认出库批次地址与清单",
  quote_batch: "仓库称重并签发出库运费报价",
  pack_shipment: "完成出库包裹打包称重",
  handover_shipment: "完成出库包裹承运商交接",
  create_ticket: "创建客户服务工单",
  issue_media_upload_url: "签发媒体凭证上传预签名地址",
  complete_media_upload: "完成媒体凭证文件上传校验",
  rejected_forbidden: "拦截越权或未授权访问请求 (403)",
  submit_report: "提交质检报告供 QA 复核",
  approve_report: "QA 独立复核批准报告",
  return_report: "QA 退回报告要求补正",
  create_incident: "登记库内丢损/异常事故",
  propose_incident_resolution: "拟定事故赔偿方案",
  approve_incident_resolution: "独立财务审批事故方案",
  customer_respond_incident: "客户响应事故赔偿方案",
  resolve_incident_compensation: "登记打款凭证并结案事故",
  create_disposal_case: "立项逾期/违禁件处置单",
  approve_disposal_case: "独立审批特殊处置单",
  execute_disposal_case: "登记完成物理处置归档",
  retry_failed_job: "人工重排失败后台作业",
  retry_email_delivery: "补发邮件投递尝试",
  update_user_roles: "调整员工系统角色权限",
  update_user_status: "变更用户账号启用状态",
  publish_terms_version: "正式发布法务协议版本",
  publish_template: "独立复核发布质检模板",
  publish_sku_price: "发布服务价格新版本",
  publish_shipping_rate: "发布运费费率新版本",
  create_warehouse_address: "新建仓库收货地址版本",
  set_default_address: "切换默认公共仓库地址",
  update_business_calendar: "更新工作日历与节假日",
  save_quote_policy: "更新报价与保管SLA策略",
  record_recovery_run: "登记备份恢复与对账演练",
  record_rehearsal_run: "归档实仓演练验证证据",
  configure_legal_entity: "更新运营法律主体信息",
  record_launch_signoff: "签署上线门禁与运行模式",
  ticket_claim: "员工领取工单",
  ticket_state_change: "调整工单指派人",
  ticket_message: "发送工单公开回复",
  ticket_internal_note: "记录工单内部备注",
};

export const ROLE_ZH: Record<string, string> = {
  super_admin: "超级管理员",
  finance: "财务专员",
  support: "客服与运营专员",
  template_admin: "模板与目录配置",
  warehouse_admin: "仓库主管",
  receiver: "收货与库管员",
  inspector: "现场质检员",
  reviewer: "独立 QA 复核员",
};

export function dictLabel(dict: Record<string, { label: string; tone?: string }>, key?: string | null, fallback = "—") {
  if (!key) return fallback;
  return dict[key]?.label ?? key;
}

export function BizTag({
  dict,
  value,
  fallback = "—",
}: {
  dict: Record<string, { label: string; tone: "green" | "yellow" | "blue" | "red" | "gray" }>;
  value?: string | null;
  fallback?: string;
}) {
  if (!value) return <span className="tag gray">{fallback}</span>;
  const hit = dict[value];
  const cls = hit ? `tag ${hit.tone}` : "tag";
  return <span className={cls} title={value}>{hit ? hit.label : value}</span>;
}

export function Money({
  cents,
  currency = "USD",
  align = "right",
  mutedZero = false,
}: {
  cents: number | null | undefined;
  currency?: string;
  align?: "left" | "right";
  mutedZero?: boolean;
}) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) {
    return <span className={`money-cell ${align === "left" ? "left" : ""} muted`}>—</span>;
  }
  const num = Number(cents) / 100;
  const formatted = /^[A-Z]{3}$/.test(currency)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(num)
    : `${num.toFixed(2)} ${currency}`;
  return (
    <span className={`money-cell ${align === "left" ? "left" : ""}${mutedZero && num === 0 ? " muted" : ""}`}>
      {formatted}
    </span>
  );
}

export function CopyId({
  value,
  short = true,
  label,
}: {
  value?: string | null;
  short?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  const shown = label ?? (short && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value);
  return (
    <span className="copy-id-wrap">
      <code className="code nowrap" title={value}>{shown}</code>
      <button
        type="button"
        className="copy-id-btn"
        title={`复制完整编号：${value}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            // ignore clipboard failure
          }
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </span>
  );
}

export function AdminTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="admin-tabs" role="tablist">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={`admin-tab${active === t.id ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          <span>{t.label}</span>
          {t.count !== undefined && <span className="admin-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  kind = "empty",
  title,
  description,
  actionHref,
  actionLabel,
  onAction,
}: {
  kind?: "empty" | "filtered" | "unconfigured" | "forbidden";
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const badgeMap = {
    empty: "当前无待处理记录",
    filtered: "筛选条件无匹配",
    unconfigured: "外部/平台能力待配置",
    forbidden: "权限受限说明",
  };
  return (
    <div className="admin-empty-box" role="status">
      <div className="admin-empty-badge">{badgeMap[kind]}</div>
      <strong>{title}</strong>
      <p className="muted">{description}</p>
      {(actionHref || onAction) && (
        <div className="actions">
          {actionHref && actionLabel && <Link className="button sm" href={actionHref}>{actionLabel}</Link>}
          {onAction && actionLabel && <button type="button" className="button sm" onClick={onAction}>{actionLabel}</button>}
        </div>
      )}
    </div>
  );
}

export function StatusBanner({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "error" | "success";
  title: string;
  children: ReactNode;
}) {
  const cls = tone === "warning" ? "notice warning" : tone === "error" ? "notice error" : tone === "success" ? "notice success" : "notice";
  return (
    <div className={cls} role={tone === "error" || tone === "warning" ? "alert" : "status"}>
      <strong>{title}：</strong>{children}
    </div>
  );
}
