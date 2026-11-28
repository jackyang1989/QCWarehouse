import Link from "next/link";
import { BRAND_ASSETS, BRAND_NAME } from "../packages/core/brand";

export default function NotFound() {
  return (
    <main id="main-content" className="public-shell pub-not-found">
      <section className="panel" style={{ maxWidth: 760, margin: "48px auto" }}>
        <div style={{ marginBottom: 20 }}>
          <Link href="/" className="wordmark" aria-label={`${BRAND_NAME} home`}>
            <img
              className="brand-wordmark-img"
              src={BRAND_ASSETS.wordmark}
              alt={BRAND_NAME}
              width={BRAND_ASSETS.width}
              height={BRAND_ASSETS.height}
            />
          </Link>
        </div>

        <p className="pub-eyebrow">HTTP 404 · PAGE NOT FOUND</p>
        <h1 style={{ marginBottom: 10 }}>Page not found · 页面未找到</h1>
        <p style={{ marginBottom: 12 }}>
          The page you requested does not exist or its URL has changed. Core receiving, product inspection, comparison, Golden Sample matching, and order workspace services continue operating normally.
        </p>
        <p className="muted" style={{ marginBottom: 22 }}>
          您访问的公开页面或链接不存在或已变更。中国收货仓实物检验、供应商样品对比、确认样比对及客户订单工作台服务均正常运行，可通过下方正式入口继续操作。
        </p>

        <div className="actions" style={{ gap: 10, flexWrap: "wrap" }}>
          <Link className="button primary" href="/">
            Back to Website (EN)
          </Link>
          <Link className="button" href="/zh">
            返回中文官网 (/zh)
          </Link>
          <Link className="button" href="/catalog">
            Services · 服务目录
          </Link>
          <Link className="button" href="/pricing">
            Pricing · 收费标准
          </Link>
          <Link className="button" href="/contact">
            Contact Support · 联系客服
          </Link>
          <Link className="button" href="/login">
            Customer Sign In · 客户登录
          </Link>
        </div>
      </section>
    </main>
  );
}
