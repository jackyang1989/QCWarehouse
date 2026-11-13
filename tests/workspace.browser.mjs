import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";

sharp.cache(false);
const { chromium } = await import(process.env.QCW_PLAYWRIGHT_MODULE ?? "playwright");
const baseURL = process.env.QCW_BROWSER_URL ?? "http://localhost:3411";
const origin = new URL(baseURL).origin;
assert(["localhost","127.0.0.1"].includes(new URL(origin).hostname), "Use a local isolated app.");
const out = process.env.QCW_BROWSER_EVIDENCE;
assert(out, "Set QCW_BROWSER_EVIDENCE to an evidence directory.");
await mkdir(out, {recursive:true});
const widths = [1440,1280,1024,768,390,375];
const resumeMatrix = process.env.QCW_BROWSER_RESUME_MATRIX === "1";
const entries = resumeMatrix?JSON.parse(await readFile(join(out,"viewports.json"),"utf8")):[];
if(resumeMatrix) {
  assert(process.env.QCW_BROWSER_FIXTURE_EMAIL?.endsWith("@qcw.test"));
  assert(process.env.QCW_BROWSER_INVENTORY_EMAIL?.endsWith("@qcw.test"));
  assert.notEqual(process.env.QCW_BROWSER_FIXTURE_EMAIL,process.env.QCW_BROWSER_INVENTORY_EMAIL);
  for(const {name,width,overflow} of entries) {
    assert(/^[a-z0-9-]+$/.test(name)&&widths.includes(width)&&overflow<=1);
    await access(join(out,`${name}-${width}.png`));
  }
}
const captured = (name,width) => entries.some(entry=>entry.name===name&&entry.width===width);
const missingViewports = name => widths.some(width=>!captured(name,width));
const browser = await chromium.launch({channel:"chrome",headless:true,args:["--disk-cache-size=16777216"]});

async function session(email = randomUUID()+"@qcw.test", staff = false, existingFixture = false) {
  const context = await browser.newContext({baseURL,viewport:{width:1440,height:1000}});
  async function call(path, options = {}) {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const csrf = (await context.cookies()).find(cookie => cookie.name === "qcw_csrf")?.value;
    const result = await context.request.fetch("/api/v1"+path, {method,data:options.body,timeout:30000,
      headers:method==="GET"?{}:{origin,"Idempotency-Key":options.key??randomUUID(),...(csrf?{"X-CSRF-Token":csrf}:{})}});
    assert.equal(result.status(), options.status ?? 200, method+" "+path);
    if(result.headers()["content-type"]?.startsWith("application/pdf")) return result.body();
    return result.json();
  }
  if(staff||existingFixture) {
    const signedIn=await call("/auth/demo/switch",{body:{email}});
    assert.equal(signedIn.kind,staff?"staff":"customer");
  } else {
    const attempt = await call("/auth/otp/request",{body:{email},status:202});
    assert(attempt.demo_code,"Test OTP requires the isolated demo environment.");
    const actor = await call("/auth/otp/verify",{body:{challenge_id:attempt.challenge_id,code:attempt.demo_code}});
    assert.equal(actor.state,"onboarding");
    const {terms} = await call("/public/terms");
    await call("/auth/registration/complete",{body:{
      terms_version_ids:terms.filter(term=>["terms","privacy"].includes(term.kind)).map(term=>term.id),
    }});
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console",message=>{
    if(message.type()==="error"&&/unique "key" prop|hydration/i.test(message.text())) errors.push(message.text());
  });
  return {context,page,call,errors};
}

const nextStep = page => page.getByRole("button",{name:/^Continue|Save & Review/}).click();
const ready = (page, name) => page.getByRole("heading",{name}).first().waitFor();

async function screenshotPage(page,path,width) {
  const height=await page.evaluate(()=>document.documentElement.scrollHeight);
  if(height<=12000) {
    await page.screenshot({path,fullPage:true,animations:"disabled"});
    return;
  }
  const chrome=await page.context().newCDPSession(page);
  try {
    const pieces=[];
    const tileHeight=4096;
    for(let y=0;y<height;y+=tileHeight) {
      const result=await chrome.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true,
        clip:{x:0,y,width,height:Math.min(tileHeight,height-y),scale:1}});
      pieces.push({input:Buffer.from(result.data,"base64"),left:0,top:y});
    }
    await sharp({create:{width,height,channels:3,background:"#ffffff"}}).composite(pieces).png().toFile(path);
  } finally {await chrome.detach();}
}

async function capture(page, name, width, heading) {
  await ready(page,heading);
  await page.getByText(/^Loading(?:\s.+)?…$/).filter({visible:true}).first().waitFor({state:"hidden"});
  await page.evaluate(async()=>{
    await document.fonts.ready;
    window.scrollTo({top:0,behavior:"instant"});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
  const overflow = await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  if(overflow>1) {
    const elements=await page.evaluate(()=>[...document.querySelectorAll("body *")].flatMap(element=>{
      const bounds=element.getBoundingClientRect();
      if(bounds.right<=innerWidth+1||element.closest(".table-wrap,.tablewrap")||bounds.width===0) return [];
      return [element.tagName+"."+String(element.className).split(" ").join(".")+":"+Math.round(bounds.right)];
    }).slice(0,12));
    console.log("OVERFLOW",name,width,overflow,elements.join(" "));
  }
  if(width<=767) {
    const clipped=await page.locator(".workspace-customer .responsive-table:not(.report-comparison .responsive-table) td :is(.tag,.code-btn)")
      .evaluateAll(elements=>elements.flatMap(element=>{
        if(!element.getClientRects().length) return [];
        const range=document.createRange();
        range.selectNodeContents(element);
        const cell=element.closest("td").getBoundingClientRect(),bounds=range.getBoundingClientRect();
        return bounds.right>cell.right+1||bounds.left<cell.left-1?[element.textContent.trim()]:[];
      }));
    assert.deepEqual(clipped,[],name+" at "+width+" px clips a status or code inside a mobile table card.");
  }
  await screenshotPage(page,join(out,name+"-"+width+".png"),width);
  entries.push({name,width,overflow});
}

async function captureWizard(page, name, heading) {
  for(const width of widths) {
    if(captured(name,width)) continue;
    await page.setViewportSize({width,height:1000});
    await capture(page,name,width,heading);
  }
  await page.setViewportSize({width:1440,height:1000});
}

async function verifyDraftRecovery({context,page,call}, unrelated) {
  await page.goto("/orders/new");
  await page.getByRole("radio",{name:/Apparel.*Available now/}).waitFor();
  await nextStep(page);
  await nextStep(page);

  let initialDraft;
  await page.route("**/api/v1/orders",async route=>{
    const response=await route.fetch({maxRetries:0});
    assert.equal(response.status(),201);
    initialDraft=await response.json();
    await route.abort("connectionreset");
  },{times:1});
  const product=page.getByLabel(/Product name/);
  await product.fill("Original request with no response");
  await page.getByRole("button",{name:"Save Draft",exact:true}).click();
  await page.getByRole("alert").filter({hasText:/Connection interrupted/}).waitFor();
  assert(initialDraft);
  await product.fill("Edited before reconnecting");
  await page.reload();
  await ready(page,/Step 3/);
  await page.getByText(/Recovered unsaved edits/).waitFor();
  assert.equal(await product.inputValue(),"Edited before reconnecting");
  await page.getByText(new RegExp(`Draft ${initialDraft.public_no} saved`)).waitFor();
  const path="/orders/"+initialDraft.id;
  let saved=await call(path);
  assert.equal(saved.lines[0].attributes.name,"Edited before reconnecting");
  assert.deepEqual((await call("/me/orders?state=draft")).rows.map(row=>row.id),[initialDraft.id]);
  await unrelated.call(path,{status:404});

  await nextStep(page);
  await ready(page,/Step 4/);
  const url=page.url();
  const notes=page.getByLabel(/Special/);
  const patchRoute="**/api/v1"+path;
  const interrupt=route=>route.request().method()==="PATCH"?route.abort("connectionreset"):route.continue();
  const offlineNote="Offline notes recovered after reload "+randomUUID().slice(0,8);
  await page.route(patchRoute,interrupt);
  await context.setOffline(true);
  await page.waitForFunction(()=>!navigator.onLine);
  await notes.fill(offlineNote);
  await page.waitForFunction(note=>Object.values(sessionStorage).some(value=>value.includes(note)),offlineNote);
  const offline=await page.reload().catch(error=>error);
  assert.match(String(offline),/INTERNET_DISCONNECTED/);
  assert.notEqual((await call(path)).customer_notes,offlineNote);
  await page.unroute(patchRoute,interrupt);
  await page.goto("about:blank");
  await context.setOffline(false);
  await page.goto(url);
  await ready(page,/Step 4/);
  await page.waitForFunction(note=>document.querySelector("main textarea")?.value===note,offlineNote);
  saved=await call(path);
  for(let attempt=0;attempt<40&&saved.customer_notes!==offlineNote;attempt++) {
    await delay(250);
    saved=await call(path);
  }
  assert.equal(saved.customer_notes,offlineNote);

  const first=await context.newPage();
  const second=await context.newPage();
  for(const tab of [first,second]) {
    await tab.goto(url);
    await ready(tab,/Step 4/);
    await tab.waitForFunction(note=>document.querySelector("main textarea")?.value===note,offlineNote);
  }
  const localNotes=first.getByLabel(/Special/);
  const localText="Unsaved notes from the first tab";
  const otherText="Newer notes saved by the second tab";
  await first.route(patchRoute,interrupt);
  await localNotes.fill(localText);
  await first.waitForFunction(note=>Object.values(sessionStorage).some(value=>value.includes(note)),localText);
  await second.getByLabel(/Special/).fill(otherText);
  await second.getByRole("button",{name:"Update Saved Draft"}).click();
  await second.getByText(new RegExp(`Draft ${initialDraft.public_no} saved`)).waitFor();
  const newer=await call(path);
  assert(newer.revision>saved.revision);
  assert.equal(newer.customer_notes,otherText);
  await first.unroute(patchRoute,interrupt);
  const conflict=first.getByText(/This draft changed in another window/);
  if(!await conflict.isVisible()) {
    try {await first.getByRole("button",{name:"Update Saved Draft"}).click({timeout:3000});}
    catch(error) {if(!await conflict.isVisible()) throw error;}
  }
  await conflict.waitFor();
  assert.equal((await call(path)).revision,newer.revision);
  await first.reload();
  await first.getByRole("button",{name:"Review my unsaved edits"}).waitFor();
  assert.equal(await localNotes.inputValue(),otherText);
  await first.getByRole("button",{name:"Review my unsaved edits"}).click();
  assert.equal(await localNotes.inputValue(),localText);
  assert.equal((await call(path)).revision,newer.revision);
  await first.getByRole("button",{name:"Update Saved Draft"}).click();
  await first.getByText(new RegExp(`Draft ${initialDraft.public_no} saved`)).waitFor();
  assert.equal((await call(path)).customer_notes,localText);
  await first.close();
  await second.close();
  console.log("PASS draft request replay after response loss, offline reload, two-tab revision conflict and explicit save");
}

async function verifyEmptyWorkspace({page,call}) {
  const desk=await call("/me/desk?include_items=0");
  assert.deepEqual([desk.summary.active_inspections,desk.summary.checked_in,desk.summary.pending_quotes],[0,0,0]);
  assert.equal((await call("/actions")).rows.length,0);
  assert.equal((await call("/me/inventory")).summary.total,0);
  assert.equal((await call("/me/reports?latest=1")).rows.length,0);
  for(const [path,empty] of [
    ["/orders",/You haven't created an inspection yet/],["/actions",/You’re all caught up/],
    ["/reports",/Published inspection reports will appear here/],["/parcels",/No parcels match this view/],
    ["/items",/Items will appear after physical warehouse intake/],["/account/billing",/No charges yet/],
    ["/support",/No support cases yet/],
  ]) {
    await page.goto(path);
    await page.getByText(empty).waitFor();
  }
  const {rows}=await call("/me/notifications");
  assert(rows.every(notice=>notice.template==="account.registered")&&rows.length<=1);
  await page.goto("/account/notifications");
  await page.getByText(/No updates yet|Your workspace is ready/).waitFor();
  console.log("PASS fresh customer empty states and registration activity match PostgreSQL");
}

async function verifyManualQuoteRenewal({page,call,errors},other) {
  const staff=await session("admin@qcw.test",true);
  const {offers}=await call("/catalog");
  const offer=offers.find(row=>row.sku_code==="apparel-inspection-1");
  assert(offer);
  const order=await call("/orders",{body:{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:101}]},status:201});
  const path="/orders/"+order.id,view="/orders/"+order.public_no;
  const terms=(await call("/public/terms")).terms.map(term=>term.id);
  async function issue(seconds,amount_cents) {
    const record=(await staff.call("/staff/admin/desk")).manualQuotes.find(row=>row.order_id===order.id);
    assert(record);
    return staff.call("/staff/orders/"+order.id+"/quotes",{status:201,body:{
      revision:record.revision,reason:"Manual renewal browser fixture",expires_at:new Date(Date.now()+seconds*1000).toISOString(),
      terms_version_ids:terms,lines:[{order_line_id:record.lines[0].id,amount_cents,business_days:7}],
    }});
  }
  async function requestUpdate() {
    await page.getByLabel("Describe your requirements").fill("Please update this quote for the same 101 items.");
    await page.getByRole("button",{name:"Request updated manual quote"}).click();
    await page.getByText(/Request received/).waitFor();
  }
  async function openAction(label) {
    await page.goto("/actions");
    const row=page.getByRole("row").filter({hasText:order.public_no}).filter({hasText:label});
    await row.getByRole("link",{name:"Open"}).click();
  }

  await call(path+"/manual-quote-request",{body:{revision:order.revision,reason:"Review 101 items for manual pricing."}});
  await issue(2,12700);
  await page.goto(view);
  await page.getByRole("button",{name:"Request updated manual quote"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Accept quote and pay"}).count(),0);
  await captureWizard(page,"manual-draft-expired",order.public_no);
  await openAction("Request an updated inspection quote");
  await page.waitForURL("**"+view+"#manual-quote-request");
  await requestUpdate();
  assert.equal((await call(path)).manual_quote.state,"requested");

  await issue(10,12900);
  await openAction("Review your inspection quote");
  await page.getByRole("heading",{name:/\$129\.00.*expires/}).waitFor();
  const policies=page.locator("form").filter({has:page.getByRole("button",{name:"Accept quote and pay"})});
  for(const checkbox of await policies.getByRole("checkbox").all()) await checkbox.check();
  await policies.getByRole("button",{name:"Accept quote and pay"}).click();
  await page.waitForURL("**/checkout/demo/*");
  await page.goto(view+"/payment");
  await page.getByRole("button",{name:"Request updated manual quote"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Resume payment"}).count(),0);
  assert.equal(await page.getByRole("button",{name:"Review a new quote"}).count(),0);
  assert.equal((await call(path)).manual_quote_renewable,true);
  await captureWizard(page,"manual-payment-expired",order.public_no);
  await requestUpdate();
  assert.equal((await call(path)).manual_quote.state,"requested");
  const pending=(await staff.call("/staff/admin/desk")).manualQuotes.find(row=>row.order_id===order.id);
  assert(pending);
  await staff.page.goto("/admin/dispositions#case-"+pending.id);
  await staff.page.locator("#case-"+pending.id).getByRole("button",{name:"发送人工报价"}).waitFor();
  const updated=await issue(120,13500);

  await page.goto("/account/billing");
  await page.getByRole("link",{name:"Review inspection quote"}).click();
  await page.getByRole("heading",{name:/\$135\.00.*expires/}).waitFor();
  assert.equal((await call(path)).manual_quote.id,updated.id);
  await captureWizard(page,"manual-quote-renewed",order.public_no);
  for(const checkbox of await policies.getByRole("checkbox").all()) await checkbox.check();
  await policies.getByRole("button",{name:"Accept quote and pay"}).click();
  await page.waitForURL("**/checkout/demo/*");
  await page.getByRole("button",{name:"Confirm test payment"}).click();
  await page.waitForURL("**"+view);
  assert.equal((await call(path)).items.length,101);
  assert.equal((await call(path+"/payment")).state,"paid");
  await other.call(path+"/manual-quote-request",{status:404,body:{revision:order.revision,reason:"Other customer cannot renew."}});
  assert.deepEqual(errors,[]);
  assert.deepEqual(staff.errors,[]);
  assert(entries.every(entry=>entry.overflow<=1),"A manual quote screenshot page has horizontal overflow.");
  console.log("PASS manual quote expiry in draft and payment, staff renewal, same-order checkout and customer isolation");
}

async function verifyFulfillmentRenewal(other) {
  const dbUrl=new URL(process.env.QCW_BROWSER_DATABASE_URL??"");
  assert(["postgres:","postgresql:"].includes(dbUrl.protocol)&&dbUrl.hostname==="127.0.0.1"&&
    /^\/qcw_test-[a-z0-9-]+$/.test(dbUrl.pathname),"Use an isolated local test database for expiry fixtures.");
  assert(process.env.QCW_BROWSER_INVENTORY_EMAIL?.endsWith("@qcw.test"));
  const {Client}=await import("pg");
  const db=new Client({connectionString:dbUrl.href});
  await db.connect();
  try {
    const buyer=await session(process.env.QCW_BROWSER_INVENTORY_EMAIL,false,true);
    const staff=await session("receiving@qcw.test",true);
    const {page,call}=buyer;
    const [item,stored]=(await call("/me/inventory?filter=handling")).rows.filter(row=>row.order_id);
    assert(item&&stored);
    const terms=(await call("/public/terms")).terms.find(term=>term.kind==="terms").id;
    const instruction=await call(`/orders/${item.order_id}/dispositions`,{status:201,body:{
      action:"to_forwarder",item_id:item.item_id,terms_version_id:terms,
      destination:{recipient:"Test Forwarder",address:"Isolated test fixture",phone:"00000000000",member_code:"QCW-TEST"},
    }});
    const retention=await call(`/orders/${stored.order_id}/dispositions`,{status:201,body:{action:"retain",item_id:stored.item_id,days:45,terms_version_id:terms}});
    const batch=await call("/dispatch-batches",{status:201,body:{disposition_ids:[instruction.id]}});
    const confirmed=await call(`/dispatch-batches/${batch.batch_id}/confirm`,{body:{revision:batch.revision}});
    const dispatchPath=`/staff/dispatch-batches/${batch.batch_id}`;
    const storagePath=`/staff/dispositions/${retention.id}/storage-quote`;
    const rates=(await staff.call("/staff/desk")).rates;
    const shipping=await staff.call(dispatchPath+"/quote",{body:{revision:confirmed.revision,rate_version_id:rates[0].id,
      parcels:[{item_ids:[item.item_id],weight_g:500}]}});
    const storage=await staff.call(storagePath,{body:{}});
    const verifyNotices=process.env.QCW_BROWSER_QUOTE_NOTICE_CHECK==="1";
    async function openQuoteNotice(id) {
      await page.goto("/account/notifications");
      await page.locator(`a[href="/account/billing?quote=${id}#quote-${id}"]`).click();
      await page.waitForURL(url=>url.searchParams.get("quote")===id);
      const card=page.locator("#quote-"+id);
      await card.waitFor();
      assert.equal(await card.count(),1);
      await page.waitForFunction(id=>document.activeElement?.id===id,"quote-"+id);
      return card;
    }
    if(verifyNotices) {
      let ready=false;
      for(let attempt=0;attempt<40&&!ready;attempt++) {
        const {rows}=await call("/me/notifications");
        ready=[shipping,storage].every(quote=>rows.some(row=>row.quote_id===quote.quote_id));
        if(!ready) await delay(250);
      }
      assert(ready,"Both quote notifications must be delivered by the isolated Worker.");
      const card=await openQuoteNotice(shipping.quote_id);
      await card.getByRole("button",{name:"Accept and pay"}).waitFor();
      await captureWizard(page,"notification-quote-open","Fulfillment quote");
    }
    for(const [table,q] of [["dispatch_quote_versions",shipping],["storage_quotes",storage]]) {
      const fixture=await db.query(`update ${table} set expires_at=now()+interval '3 seconds' where id=$1 and accepted_at is null returning id`,[q.quote_id]);
      assert.equal(fixture.rowCount,1,"The app must use the same isolated database as the expiry fixture.");
      await call(`/quotes/${q.quote_id}/accept`,{body:{revision:q.revision}});
    }
    await delay(3100);
    if(verifyNotices) {
      const card=await openQuoteNotice(storage.quote_id);
      await card.getByText(/This quote has expired/).waitFor();
      assert.equal(await card.getByRole("button",{name:"Resume payment"}).count(),0);
      const {charge_id}=await call("/quotes/"+storage.quote_id);
      const chargeRow=page.getByRole("row").filter({has:page.locator("#charge-"+charge_id)});
      await chargeRow.getByText("Expired",{exact:true}).waitFor();
      assert.equal(await chargeRow.getByRole("button",{name:"Pay",exact:true}).count(),0);
      await other.call("/quotes/"+storage.quote_id,{status:404});
      await captureWizard(page,"notification-quote-expired","Fulfillment quote");
    }
    for(const [name,row,q] of [["dispatch-expired",item,shipping],["storage-expired",stored,storage]]) {
      await page.goto(`/orders/${row.order_no}/quotes/${q.quote_id}`);
      await page.getByText("This quote has expired.",{exact:false}).waitFor();
      assert.equal(await page.getByRole("button",{name:"Resume payment"}).count(),0);
      await captureWizard(page,name,"Fulfillment quote");
    }
    await staff.page.goto(`/wh/dispatch/${batch.batch_id}`);
    await staff.page.getByText("旧报价已过期，且无待核对的付款。请按实际包裹重新报价。",{exact:true}).waitFor();
    await staff.page.locator('input[name="weight-1"]').fill("650");
    await staff.page.getByRole("button",{name:"提交称重并自动生成报价"}).click();
    await staff.page.getByText("等待客户接受报价或渠道确认付款。",{exact:true}).waitFor();
    await staff.page.goto("/wh/dispatch");
    const storageRow=staff.page.locator("p").filter({has:staff.page.getByRole("button",{name:stored.code,exact:true})});
    await storageRow.getByRole("button",{name:"重新报价",exact:true}).click();
    await storageRow.waitFor({state:"hidden"});
    const renewed=(await call("/me/desk?include_items=0")).quotes.filter(q=>q.item_codes?.[item.item_id]||q.item_codes?.[stored.item_id]);
    assert.equal(renewed.length,2);
    await other.call(`/orders/${item.order_id}/quotes/${renewed.find(q=>q.purpose==="dispatch").id}`,{status:404});
    await page.goto("/account/billing");
    await captureWizard(page,"fulfillment-quotes-renewed","Billing");
    for(const q of renewed) {
      const card=page.locator("#quote-"+q.id);
      await card.getByRole("button",{name:"Accept and pay"}).click();
      await page.waitForURL("**/checkout/demo/*");
      await page.getByRole("button",{name:"Confirm test payment"}).click();
      await page.waitForURL("**/account/billing");
    }
    for(const q of renewed) {
      const row=q.purpose==="dispatch"?item:stored;
      const paid=await call(`/orders/${row.order_id}/quotes/${q.id}`);
      assert.equal(paid.state,"paid");
      assert.equal(paid.amount_cents,q.amount_cents);
    }
    assert.deepEqual(buyer.errors,[]);
    assert.deepEqual(staff.errors,[]);
    assert(entries.every(entry=>entry.overflow<=1));
    console.log("PASS customer expiry, warehouse re-quote, customer payment, and cross-tenant quote isolation");
  } finally {await db.end();}
}

async function verifyScopeRenewal({page,call,errors},other) {
  const target=new URL(process.env.QCW_BROWSER_DATABASE_URL??"");
  assert(["postgres:","postgresql:"].includes(target.protocol)&&target.hostname==="127.0.0.1"&&
    /^\/qcw_test-[a-z0-9-]+$/.test(target.pathname),"Use an isolated local test database for expiry fixtures.");
  const {Client}=await import("pg");
  const db=new Client({connectionString:target.href});
  await db.connect();
  try {
    const {actor}=await call("/me");
    const offer=(await call("/catalog")).offers.find(row=>row.sku_code==="apparel-inspection-1");
    const draft=await call("/orders",{status:201,body:{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,quantity:1}]}});
    const order=`/orders/${draft.id}`;
    const quote=await call(order+"/quotes",{status:201,body:{revision:draft.revision}});
    const {terms}=await call("/public/terms");
    const initial=await call(order+"/submit",{body:{revision:draft.revision,quote_id:quote.id,terms_version_ids:terms.map(row=>row.id),
      acknowledgements:{scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true}}});
    const checkout=await call(`/charges/${initial.charge.charge_item_id}/checkout`,{body:{quote_revision:quote.revision}});
    await call(`/checkout/demo/${checkout.attempt_id}`,{body:{}});
    const scopes=order+"/scope-revisions";
    const view=await call(scopes);
    const proposal=await call(order+"/scope-additions",{status:201,body:{revision:view.order.revision,reason:"Inspect one additional item.",
      positions:view.positions.map(row=>row.id),additions:[{order_line_id:view.positions[0].line_id,count:1}]}});
    const expiredQuote=randomUUID(),oldCharge=randomUUID(),oldScope=proposal.scope_revision_id;
    const seeded=await db.query(`with accepted as (
      update scope_revisions set accepted_at=now()-interval '1 hour',accepted_by=$2 where id=$1 returning *
    ), quoted as (
      insert into inspection_quotes(id,order_id,revision,line_snapshot,terms_snapshot,amount_cents,currency,expires_at,accepted_at)
      select $3,s.order_id,(select max(revision)+1 from inspection_quotes where order_id=s.order_id),o.submission_snapshot->'lines',
        jsonb_build_object('scope_revision_id',s.id,'order_revision',o.revision),s.adjustment_cents,'USD',now()-interval '30 minutes',s.accepted_at
      from accepted s join orders o on o.id=s.order_id returning *
    ) insert into charge_items(id,org_id,purpose,inspection_quote_id,scope_revision_id,amount_cents,currency,snapshot)
      select $4,$5,'inspection',id,$1,amount_cents,currency,jsonb_build_object('scope_revision_id',$1::uuid,'quote_revision',revision)
      from quoted`,[oldScope,actor.id,expiredQuote,oldCharge,actor.org]);
    assert.equal(seeded.rowCount,1,"The app and browser fixtures must use the same isolated database.");
    await db.query(`insert into order_blocks(id,order_id,reason,object_key,opened_at)
      values($1,$2,'scope_payment_pending',$3,now())`,[randomUUID(),draft.id,oldScope]);
    await page.goto("/account/billing");
    const billRow=page.getByRole("row").filter({has:page.locator("#charge-"+oldCharge)});
    await billRow.getByRole("link",{name:"Review scope charge"}).click();
    const oldUrl=`/orders/${draft.public_no}#scope-${oldScope}`;
    await page.waitForURL(baseURL+oldUrl);
    const oldCard=page.locator("#scope-"+oldScope);
    await oldCard.getByText(/This payment quote has expired/).waitFor();
    await page.getByText("Renew the supplemental quote for your accepted scope change.",{exact:true}).waitFor();
    assert.equal(await oldCard.getByRole("button",{name:/^Pay supplemental charge/}).count(),0);
    await page.goto("/actions");
    await page.getByRole("row").filter({hasText:"Renew supplemental inspection quote"}).getByRole("link",{name:"Open"}).click();
    await page.waitForURL(baseURL+oldUrl);
    await captureWizard(page,"scope-payment-expired",/Inspection scope & sample discrepancies/);
    page.once("dialog",dialog=>dialog.accept());
    await oldCard.getByRole("button",{name:"Confirm and renew supplemental quote"}).click();
    await oldCard.getByText("The charge for this version is closed.").waitFor();
    const replacement=(await call(scopes)).proposals.find(row=>row.id!==oldScope);
    const newUrl=`/orders/${draft.public_no}#scope-${replacement.id}`;
    await page.waitForURL(baseURL+newUrl);
    await page.getByText("Complete the supplemental payment before the scope change takes effect.",{exact:true}).waitFor();
    assert.equal(replacement.supplemental_charge.amount_cents,proposal.adjustment_cents);
    await captureWizard(page,"scope-payment-renewed",/Inspection scope & sample discrepancies/);
    await other.call(scopes,{status:404});
    await page.locator("#scope-"+replacement.id).getByRole("button",{name:/^Pay supplemental charge/}).click();
    await page.waitForURL("**/checkout/demo/*");
    await page.getByRole("button",{name:"Confirm test payment"}).click();
    await page.waitForURL(baseURL+newUrl);
    await page.locator("#scope-"+replacement.id).getByText("Supplemental payment confirmed.").waitFor();
    assert.equal((await call(order)).items.length,2);
    assert.deepEqual(errors,[]);
    assert(entries.every(entry=>entry.overflow<=1));
    console.log("PASS expired scope charge, billing and action links, reconfirmation, exact checkout return and customer isolation");
  } finally {await db.end();}
}

async function verifySupportHistory({page,call,errors},other) {
  const history=[];
  for(let index=0;index<21;index++) {
    history.push(await call("/me/cases",{body:{subject:`Support history fixture ${index+1}`,message:"A message in the local support history fixture."}}));
  }
  const oldest=history[0];
  await page.goto("/support");
  const pager=page.getByRole("navigation",{name:"Support case pages"});
  await pager.getByRole("link",{name:"Next"}).click();
  await page.waitForURL("**/support?page=2");
  const oldLink=page.getByRole("link",{name:oldest.public_no,exact:true});
  await oldLink.waitFor();
  await captureWizard(page,"support-history-page-two","My support cases");
  await oldLink.click();
  await ready(page,"Support history fixture 1");
  await page.goBack();
  await oldLink.waitFor();
  await page.getByLabel("Case or order number").fill(oldest.public_no.toLowerCase());
  await page.getByLabel("Case status").selectOption("open");
  await page.getByRole("button",{name:"Find cases"}).click();
  await page.waitForURL(url=>url.searchParams.get("q")===oldest.public_no.toLowerCase()&&url.searchParams.get("state")==="open");
  await oldLink.waitFor();
  assert.equal(await page.getByRole("row").count(),2);
  assert.equal((await other.call("/me/cases?q="+oldest.public_no)).rows.length,0);
  await other.page.goto("/support?q="+oldest.public_no);
  await other.page.getByText("No support cases match these filters.").waitFor();
  assert.deepEqual(errors,[]);
  assert(entries.every(entry=>entry.overflow<=1));
  console.log("PASS support history pagination, case search, browser back, and customer isolation");
}

async function verifySellerReturn({page,call,errors},other) {
  const receiver=await session("receiving@qcw.test",true);
  const profile=await call("/me/receiving-address");
  const {offers}=await call("/catalog");
  const offer=offers.find(row=>row.sku_code==="apparel-inspection-1");
  const terms=(await call("/public/terms")).terms.map(term=>term.id);
  const {locations}=await receiver.call("/staff/desk");
  const location=locations.find(row=>row.code==="R-01");
  const photo=await sharp({create:{width:100,height:80,channels:3,background:"#11736d"}}).png().toBuffer();
  async function evidence(kind) {
    const csrf=(await receiver.context.cookies()).find(cookie=>cookie.name==="qcw_csrf")?.value;
    const upload=await receiver.context.request.post("/api/v1/staff/media",{
      headers:{origin,"Idempotency-Key":randomUUID(),"X-CSRF-Token":csrf},
      multipart:{kind,photo:{name:"fixture.png",mimeType:"image/png",buffer:photo}},
    });
    assert.equal(upload.status(),201);
    return (await upload.json()).id;
  }
  async function prepareItem() {
    const tracking_no="ZTO"+randomUUID().slice(0,8).toUpperCase(),code="S-"+randomUUID();
    const draft=await call("/orders",{status:201,body:{lines:[{category_id:offer.category_id,offer_id:offer.offer_id,
      quantity:1,items:[{sample_code:code,supplier_alias:"Fixture supplier",tracking_no}]}]}});
    const orderPath="/orders/"+draft.id;
    const quote=await call(orderPath+"/quotes",{status:201,body:{revision:draft.revision}});
    const submitted=await call(orderPath+"/submit",{body:{revision:draft.revision,quote_id:quote.id,terms_version_ids:terms,
      acknowledgements:{scope_notice:true,samples_not_batch:true,seller_refund_is_mine:true,no_certification:true,restricted_items:true}}});
    const checkout=await call("/charges/"+submitted.charge.charge_item_id+"/checkout",{body:{quote_revision:quote.revision}});
    await call("/checkout/demo/"+checkout.attempt_id,{body:{}});
    const advice=await call("/me/parcels",{status:201,body:{address_id:profile.warehouse_address.id,tracking_no,carrier_code:"zto",order_ids:[draft.id]}});
    const parcel=await receiver.call("/staff/intake/check-in",{status:201,body:{tracking_no,carrier_code:"zto",advice_id:advice.id,outer_media_ids:[await evidence("intake_outer")]}});
    const {item_ids:[id]}=await receiver.call("/staff/packages/"+parcel.id+"/items",{status:201,body:{revision:parcel.revision,items:[{code,location_id:location.id}]}});
    const position=(await call(orderPath)).items[0];
    await receiver.call("/staff/items/"+id+"/assign",{body:{revision:1,order_line_id:position.order_line_id,expected_item_id:position.id,evidence_ids:[await evidence("label_photo")]}});
    const current=await call(orderPath);
    await call(orderPath+"/cancel",{body:{revision:current.revision}});
    return {code,id};
  }
  const items=[await prepareItem(),await prepareItem()];
  await page.goto("/items?filter=handling");
  for(const item of items) await page.getByRole("checkbox",{name:`Select ${item.code} for handling`}).check();
  await page.getByText("Seller details for a combined return",{exact:true}).click();
  await page.getByLabel("Recipient",{exact:true}).fill("Fixture return recipient");
  await page.getByLabel("Destination phone").fill("13800000000");
  await page.getByLabel("Return address supplied by your seller").fill("Fixture seller return address");
  await page.getByLabel("Seller’s shop name (optional)").fill("Fixture shop");
  await page.getByLabel("Seller’s shop ID (optional)").fill("FIXTURE-SHOP-1");
  await captureWizard(page,"seller-return-details","Warehouse items");
  await page.getByRole("checkbox",{name:/I have arranged the return/}).check();
  await page.getByRole("button",{name:"Save handling instruction (2 items)"}).click();
  await page.getByText(/Instructions recorded for/).waitFor();
  const instructions=[];
  for(const item of items) {
    const {rows:[stored]}=await call("/me/inventory?code="+item.code);
    assert.equal(stored.active_disposition.return_info.seller_name,"Fixture shop");
    assert.equal(stored.active_disposition.return_info.seller_id,"FIXTURE-SHOP-1");
    instructions.push(stored.active_disposition.id);
  }
  await other.call("/dispatch-batches",{body:{disposition_ids:instructions},status:409});
  await page.getByRole("link",{name:"View items with saved instructions"}).click();
  for(const item of items) await page.getByRole("row").filter({has:page.getByRole("button",{name:item.code,exact:true})})
    .getByRole("checkbox",{name:"Select for shipping"}).check();
  await page.getByRole("button",{name:"Confirm selected items for quoting (2)"}).click();
  const batch=page.getByRole("heading",{name:"Dispatch batches"});
  await batch.waitFor();
  await page.getByRole("cell",{name:"Awaiting quote",exact:true}).waitFor();
  const savedBatch=(await call("/me/desk?include_items=0")).active_batches.find(row=>items.every(item=>row.item_codes.includes(item.code)));
  assert.equal(savedBatch.state,"confirmed");
  await captureWizard(page,"seller-return-batch","Warehouse items");
  assert.deepEqual(errors,[]);
  assert(entries.every(entry=>entry.overflow===0));
  console.log("PASS same-seller return details saved through customer form, cross-order batch confirmed, and foreign batch blocked");
}

async function verifyIncidentDecision({page,call,errors},other) {
  const receiver=await session("receiving@qcw.test",true);
  const admin=await session("admin@qcw.test",true);
  const profile=await call("/me/receiving-address");
  const tracking_no="ZTO"+randomUUID().slice(0,8).toUpperCase();
  const advice=await call("/me/parcels",{body:{address_id:profile.warehouse_address.id,tracking_no,carrier_code:"zto"},status:201});
  const photo=await sharp({create:{width:100,height:80,channels:3,background:"#11736d"}}).png().toBuffer();
  const csrf=(await receiver.context.cookies()).find(cookie=>cookie.name==="qcw_csrf")?.value;
  const upload=await receiver.context.request.post("/api/v1/staff/media",{
    headers:{origin,"Idempotency-Key":randomUUID(),"X-CSRF-Token":csrf},
    multipart:{kind:"intake_outer",photo:{name:"fixture.png",mimeType:"image/png",buffer:photo}},
  });
  assert.equal(upload.status(),201);
  const parcel=await receiver.call("/staff/intake/check-in",{body:{tracking_no,carrier_code:"zto",advice_id:advice.id,
    outer_media_ids:[(await upload.json()).id]},status:201});
  const {locations}=await receiver.call("/staff/desk");
  const itemCode="S-"+randomUUID();
  const item=await receiver.call(`/staff/packages/${parcel.id}/items`,{body:{revision:parcel.revision,
    items:[{code:itemCode,location_id:locations.find(location=>location.code==="R-01").id}]},status:201});
  const subject="Warehouse found a torn sample seam";
  const incident=await receiver.call("/staff/incidents",{body:{item_id:item.item_ids[0],kind:"damage",summary_en:subject},status:201});
  await page.goto("/items");
  const itemRow=page.getByRole("row").filter({has:page.getByRole("button",{name:itemCode,exact:true})});
  await itemRow.getByText("Warehouse incident under review",{exact:true}).waitFor();
  assert.equal(await itemRow.getByRole("checkbox",{name:`Select ${itemCode} for handling`}).count(),0);
  await captureWizard(page,"incident-inventory-hold","Warehouse items");
  const staffPath=`/staff/incidents/${incident.id}`,customerPath=`/me/incidents/${incident.id}`,casePath=`/support/cases/${incident.ticket_id}`;
  const proposalSummary="We propose merchandise compensation for the damage.";
  await receiver.call(staffPath+"/propose",{body:{compensation_cents:2500,currency:"USD",summary_en:proposalSummary}});
  await page.goto(casePath);
  await page.getByRole("heading",{name:"Incident resolution"}).waitFor();
  assert.equal(await page.getByText(proposalSummary,{exact:true}).count(),0);
  assert.equal(await page.getByRole("button",{name:"Submit compensation decision"}).count(),0);
  await captureWizard(page,"incident-under-review",subject);
  await other.call("/cases/"+incident.ticket_id,{status:404});
  await other.call(customerPath+"/response",{body:{decision:"accept"},status:404});
  await admin.call(staffPath+"/approve",{body:{reason:"Independent review of the warehouse evidence."}});
  await page.goto("/actions");
  const action=page.getByRole("row").filter({hasText:incident.ticket_no});
  await action.getByRole("cell",{name:"Review warehouse incident proposal",exact:true}).waitFor();
  await action.getByRole("link",{name:"Open"}).click();
  await page.waitForURL(url=>url.pathname===casePath&&url.hash==="#incident-decision");
  await page.getByLabel("Decision",{exact:true}).waitFor();
  assert.equal(await page.getByLabel("Decision",{exact:true}).inputValue(),"");
  await page.getByLabel("Reply",{exact:true}).fill("Thank you. I will confirm the proposal separately.");
  await page.getByRole("button",{name:"Send reply"}).click();
  await page.getByText("Your reply was sent.").waitFor();
  assert.equal((await call("/actions")).rows.find(row=>row.id===incident.ticket_id).state,"incident_decision");
  await captureWizard(page,"incident-decision-required",subject);
  await page.getByLabel("Decision",{exact:true}).selectOption("accept");
  await page.getByRole("button",{name:"Submit compensation decision"}).click();
  await page.getByText("You accepted this proposal.").waitFor();
  assert.equal((await call(customerPath)).paid,false);
  assert(!(await call("/actions")).rows.some(row=>row.id===incident.ticket_id));
  await page.getByText("Payout pending",{exact:true}).waitFor();
  await captureWizard(page,"incident-payout-pending",subject);
  await admin.call(staffPath+"/resolve",{body:{payout_reference:"ISOLATED-TEST-PAYOUT",payout_method:"bank_transfer",paid_amount_cents:2500}});
  await page.reload();
  await page.getByText("Payout recorded",{exact:true}).waitFor();
  assert.equal((await call(customerPath)).paid,true);
  await captureWizard(page,"incident-payout-recorded",subject);
  await page.goto("/items?filter=handling");
  await itemRow.getByRole("checkbox",{name:`Select ${itemCode} for handling`}).waitFor();
  assert.deepEqual(errors,[]);
  assert(entries.every(entry=>entry.overflow===0));
  console.log("PASS independently approved incident proposal, customer decision, retained action after reply, and separate payout proof");
}

async function verifyParcelOwnership({page,call,errors},other) {
  const receiver=await session("receiving@qcw.test",true);
  const admin=await session("admin@qcw.test",true);
  const tracking="ZT"+randomUUID().slice(0,8).toUpperCase();
  const photo=await sharp({create:{width:100,height:80,channels:3,background:"#11736d"}}).png().toBuffer();
  const csrf=(await receiver.context.cookies()).find(cookie=>cookie.name==="qcw_csrf")?.value;
  const upload=await receiver.context.request.post("/api/v1/staff/media",{
    headers:{origin,"Idempotency-Key":randomUUID(),"X-CSRF-Token":csrf},
    multipart:{kind:"intake_outer",photo:{name:"fixture.png",mimeType:"image/png",buffer:photo}},
  });
  assert.equal(upload.status(),201);
  const parcel=await receiver.call("/staff/intake/check-in",{body:{tracking_no:tracking,carrier_code:"zto",
    outer_media_ids:[(await upload.json()).id],outer_condition:"torn",condition_note:"Private fixture handling note."},status:201});
  assert.equal(parcel.state,"unmatched");
  await page.goto("/parcels");
  await page.getByRole("button",{name:"Needs Attention"}).click();
  await page.waitForURL(url=>url.searchParams.get("tab")==="attention");
  const reviews=page.locator("section").filter({has:page.getByRole("heading",{name:"Parcel ownership reviews"})});
  await reviews.getByText("Find a missing parcel",{exact:true}).click();
  await reviews.getByLabel("Seller’s tracking number",{exact:true}).fill(tracking);
  await reviews.locator('select[name="carrier_code"]').selectOption("zto");
  await reviews.getByLabel(/^Seller shipment proof/).setInputFiles({name:"seller.png",mimeType:"image/png",buffer:photo});
  await captureWizard(page,"parcel-claim-form","Parcels");
  await page.getByRole("button",{name:"Request ownership review"}).click();
  const confirmed=page.getByRole("status").filter({hasText:"is with support"});
  await confirmed.waitFor();
  const claim=(await call("/me/intake-claims")).rows[0];
  assert.equal(claim.tracking_no,tracking);
  assert.equal(claim.advice_id,null);
  assert.deepEqual((await other.call("/me/intake-claims")).rows,[]);
  await captureWizard(page,"parcel-claim-submitted","Parcels");
  await confirmed.getByRole("link",{name:claim.public_no}).click();
  await page.getByRole("heading",{name:"Seller parcel"}).waitFor();
  const reply="My seller confirmed the parcel label and tracking number.";
  await page.getByLabel("Reply",{exact:true}).fill(reply);
  await page.getByRole("button",{name:"Send reply"}).click();
  await page.getByText(reply,{exact:true}).waitFor();
  await captureWizard(page,"parcel-claim-in-review","Inbound parcel ownership review");
  await other.call("/cases/"+claim.id,{status:404});
  await admin.page.goto("/admin/orders#case-"+claim.id);
  const review=admin.page.locator("#case-"+claim.id);
  await review.getByRole("link",{name:"查看工单与客户补充回复"}).click();
  await admin.page.getByText(reply,{exact:true}).waitFor();
  await admin.page.getByRole("link",{name:"查看认领核验"}).click();
  await review.locator('select[name="decision"]').selectOption("approve");
  const staffNote="Matched the physical label with private seller evidence.";
  await review.getByLabel("核验证据和原因").fill(staffNote);
  await review.getByRole("button",{name:"记录核验结论"}).click();
  await review.locator("summary").filter({hasText:"approve"}).waitFor();
  const approved=(await call("/me/intake-claims")).rows[0];
  assert.equal(approved.decision,"approve");
  assert(approved.advice_id);
  await other.call("/me/parcels/"+approved.advice_id+"/tracking",{status:404});
  let received=false;
  for(let attempt=0;attempt<60&&!received;attempt++) {
    const {rows}=await call("/me/notifications");
    received=rows.some(row=>row.case_id===claim.id)&&rows.some(row=>row.advice_id===approved.advice_id);
    if(!received)await delay(1000);
  }
  assert(received,"The Worker did not deliver the private claim decision notification.");
  await page.goto("/account/notifications");
  const notices=page.getByText("Support has replied to your case",{exact:true});
  await notices.waitFor({timeout:60000});
  const notice=page.getByRole("link",{name:"Open"}).and(page.locator('a[href="/support/cases/'+claim.id+'"]'));
  const notificationRow=page.getByRole("row").filter({has:notice});
  await notificationRow.getByText(claim.public_no,{exact:true}).waitFor();
  await page.getByRole("row").filter({hasText:"The warehouse received your parcel"}).getByText(tracking,{exact:true}).waitFor();
  await captureWizard(page,"parcel-claim-notifications","Notifications");
  await notice.click();
  await page.getByText("Ownership confirmed",{exact:true}).waitFor();
  assert.equal(await page.getByText(staffNote,{exact:true}).count(),0);
  await captureWizard(page,"parcel-claim-approved","Inbound parcel ownership review");
  await page.getByRole("link",{name:"Open parcel"}).click();
  await page.waitForURL("**/parcels/"+approved.advice_id);
  await page.getByText(tracking,{exact:true}).waitFor();
  await page.getByText("Warehouse · Received at warehouse",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Request carrier update"}).count(),0);
  const cachedRead=page.waitForResponse(response=>response.request().method()==="GET"&&
    new URL(response.url()).pathname==="/api/v1/me/parcels/"+approved.advice_id+"/tracking");
  await page.getByRole("button",{name:"Reload tracking status"}).click();
  assert.equal((await cachedRead).status(),200);
  const receipt=page.getByRole("region",{name:"Warehouse receipt"});
  await receipt.getByText("Warehouse check-in",{exact:true}).waitFor();
  await receipt.getByText("Torn",{exact:true}).waitFor();
  assert.equal(await page.getByText("Private fixture handling note.",{exact:true}).count(),0);
  await captureWizard(page,"parcel-claim-receipt","Tracking details");
  assert.deepEqual([...errors,...admin.errors,...receiver.errors,...other.errors],[]);
  assert(entries.every(entry=>entry.overflow===0));
  console.log("PASS parcel claim from customer evidence through staff review, private notification and owned warehouse receipt");
}

try {
  const customer = await session(resumeMatrix?process.env.QCW_BROWSER_FIXTURE_EMAIL:undefined,false,resumeMatrix);
  const other = await session(resumeMatrix?process.env.QCW_BROWSER_INVENTORY_EMAIL:undefined,false,resumeMatrix);
  if(resumeMatrix) await verifyWorkspaceViews(customer,other);
  else if(process.env.QCW_BROWSER_INTAKE_CLAIM_ONLY==="1") await verifyParcelOwnership(customer,other);
  else if(process.env.QCW_BROWSER_INCIDENT_ONLY==="1") await verifyIncidentDecision(customer,other);
  else if(process.env.QCW_BROWSER_SELLER_RETURN_ONLY==="1") await verifySellerReturn(customer,other);
  else if(process.env.QCW_BROWSER_SUPPORT_ONLY==="1") await verifySupportHistory(customer,other);
  else if(process.env.QCW_BROWSER_SCOPE_ONLY==="1") await verifyScopeRenewal(customer,other);
  else if(process.env.QCW_BROWSER_FULFILLMENT_ONLY==="1") await verifyFulfillmentRenewal(other);
  else if(process.env.QCW_BROWSER_MANUAL_QUOTE_ONLY==="1") await verifyManualQuoteRenewal(customer,other);
  else {
    const profile = await customer.call("/me/receiving-address");
    const otherProfile = await other.call("/me/receiving-address");
    assert.notEqual(profile.receiving_code,otherProfile.receiving_code);
    if(process.env.QCW_BROWSER_WORKSPACE_ONLY!=="1") await verifyDraftRecovery(other,customer);
    if(process.env.QCW_BROWSER_RECOVERY_ONLY!=="1") await verifyWorkspace(customer,other,profile,otherProfile);
  }
} finally {
  await browser.close();
  await writeFile(join(out,"viewports.json"),JSON.stringify(entries,null,2)+"\n");
}

async function verifyWorkspace(customer,other,profile,otherProfile) {
  const {page,call}=customer;
  await verifyEmptyWorkspace(customer);

  await page.goto("/orders/new");
  await page.getByRole("radio",{name:/Apparel.*Available now/}).waitFor();
  assert.equal(await page.getByRole("navigation",{name:"Inspection setup steps"}).count(),1);
  assert.equal(await page.locator(".wizard-side").count(),1);
  assert.equal(await page.getByRole("radio",{name:/Electronics/}).isDisabled(),true);
  const {offers}=await call("/catalog");
  const apparelPrices=offers.filter(offer=>offer.category_slug==="apparel"&&offer.service==="inspection")
    .map(offer=>offer.rules.unit_cents).filter(Number.isFinite);
  const lowestPrice=Math.min(...apparelPrices);
  assert(lowestPrice<Math.max(...apparelPrices),"The apparel fixture must have different per-item prices.");
  const formattedPrice=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(lowestPrice/100);
  await page.getByRole("radio",{name:/Product Inspection/}).getByText(`From ${formattedPrice} / item`,{exact:true}).waitFor();
  if(process.env.QCW_BROWSER_NEW_CUSTOMER_ONLY==="1") await captureWizard(page,"new-inspection",/Step 1/);
  await nextStep(page);
  await page.getByLabel("Inspection template").selectOption("leggings");
  await captureWizard(page,"wizard-configure",/Step 2/);
  await nextStep(page);
  await page.getByLabel(/Product name/).fill("QA leggings");
  await page.getByLabel(/Default supplier/).fill("Supplier A");
  await page.getByLabel("Item 2 supplier").fill("Supplier B");
  await page.getByLabel(/Default color/).fill("Black");
  const declaredWaybills=Array.from({length:2},()=>"SF"+randomUUID().slice(0,8).toUpperCase());
  for(const [index,waybill] of declaredWaybills.entries()) await page.getByLabel(`Item ${index+1} waybill`).fill(waybill);
  assert.equal(await page.getByLabel("Item 2 color").inputValue(),"Black");
  await captureWizard(page,"wizard-items",/Step 3/);
  await nextStep(page);
  await ready(page,/Step 4/);
  const orderNumber = new URL(page.url()).searchParams.get("draft");
  const order = await call("/orders/by-number/"+orderNumber);
  const orderPath = "/orders/"+order.id;
  await page.reload();
  await ready(page,/Step 4/);
  assert.match(await page.locator("main").innerText(),/Inseam/);
  assert.doesNotMatch(await page.locator("main").innerText(),/Underbust|Sleeve Length/);
  await page.getByRole("button",{name:"Set targets and tolerances"}).click();
  assert((await page.getByRole("spinbutton",{name:/tolerance/}).all()).length>0);
  for(const field of await page.getByRole("spinbutton",{name:/tolerance/}).all()) assert.equal(await field.inputValue(),"");
  await page.getByRole("button",{name:"Record measured values"}).click();
  await captureWizard(page,"wizard-scope",/Step 4/);
  await page.getByLabel(/Special/).fill("Check the care label.");
  const draft = await call(orderPath);
  assert.equal(draft.lines[0].draft_items[1].supplier_alias,"Supplier B");
  assert.equal(draft.lines[0].draft_items[1].color_declared,"Black");
  assert.equal((await call(orderPath+"/quotes",{body:{revision:0},status:422})).error.code,"INVALID_REQUEST");
  assert.equal((await call(orderPath+"/quotes",{body:{revision:draft.revision+10},status:409})).error.code,"VERSION_CONFLICT");
  await call("/orders/undefined",{status:404});
  await other.call(orderPath,{status:404});

  const quoteRoute = "**/api/v1/orders/*/quotes";
  for(const code of [404,422,409,500,"timeout"]) {
    const fail = async route => {
      if(code==="timeout") {
        await new Promise(resolve=>setTimeout(resolve,16000));
        await route.abort("timedout").catch(()=>{});
      } else await route.fulfill({status:code,json:{error:{message:"Test quote failure "+code,code:"TEST_QUOTE_FAILURE"}}});
    };
    await page.route(quoteRoute,fail,{times:1});
    if(code===404) await nextStep(page);
    else await page.getByRole("button",{name:"Retry quote"}).click();
    await page.getByRole("alert").filter({hasText:code==="timeout"?/quote request timed out/:new RegExp("Test quote failure "+code)}).waitFor({timeout:20000});
    assert.equal(await page.getByRole("button",{name:/Continue to Payment/}).isDisabled(),true);
    assert.equal(await page.getByRole("button",{name:/Confirm quote and pay/}).count(),0);
    assert.equal(await page.locator(".wizard-summary-body").getByText("Awaiting quote").count(),1);
  }
  const quoteResponse = page.waitForResponse(response=>response.url().endsWith("/quotes")&&response.request().method()==="POST"&&response.status()===201);
  await page.getByRole("button",{name:"Retry quote"}).click();
  const quote = await (await quoteResponse).json();
  const saved = await call(orderPath);
  const catalog = await call("/catalog");
  const offer = catalog.offers.find(candidate=>candidate.offer_id===saved.lines[0].offer_id);
  assert.equal(quote.order_id,order.id);
  assert.equal(quote.line_snapshot[0].template_version_id,saved.lines[0].template_version_id);
  assert.equal(quote.amount_cents,saved.lines[0].quantity*offer.rules.unit_cents);
  assert(Date.parse(quote.expires_at)>Date.now());
  assert.equal(saved.customer_notes,"Check the care label.");
  await page.getByText(/Official quote · QW/).waitFor();
  await captureWizard(page,"wizard-review",/Step 5/);
  assert.equal(await page.getByRole("button",{name:/Continue to Payment/}).isDisabled(),true);
  for(const input of await page.getByRole("checkbox").all()) await input.check();
  await nextStep(page);
  await ready(page,/Step 6/);
  await captureWizard(page,"wizard-payment",/Step 6/);
  await page.setViewportSize({width:375,height:1000});
  await page.getByRole("button",{name:/Confirm quote and pay/}).dblclick();
  await page.waitForURL("**/checkout/demo/*");
  const attemptId = new URL(page.url()).pathname.split("/").at(-1);
  await page.getByRole("button",{name:"Confirm test payment"}).waitFor();
  await captureWizard(page,"test-checkout",/Test checkout/);
  await page.setViewportSize({width:375,height:1000});
  await page.getByRole("button",{name:"Confirm test payment"}).click();
  await page.waitForURL("**/orders/"+orderNumber);
  await ready(page,orderNumber);
  await page.getByRole("link",{name:"Register seller tracking",exact:true}).first().waitFor();
  assert.equal((await call(orderPath)).state,"awaiting_samples");
  assert.equal((await call(orderPath+"/payment")).state,"paid");
  assert.equal((await call("/checkout/demo/"+attemptId,{body:{}})).order_number,orderNumber);
  await page.goto("/actions");
  const registrationAction=page.getByRole("row").filter({hasText:orderNumber});
  await registrationAction.getByRole("link",{name:"Open"}).click();
  await page.waitForURL(`**/orders/${orderNumber}/parcels`);
  const declaredTracking=page.getByLabel("Use a tracking number declared in this order");
  const sf=(await call("/carriers")).carriers.find(carrier=>carrier.code==="sf");
  for(const [index,waybill] of declaredWaybills.entries()) {
    await declaredTracking.selectOption(waybill);
    assert.equal(await page.getByLabel("Seller’s tracking number").inputValue(),waybill);
    if(index===1&&process.env.QCW_BROWSER_NEW_CUSTOMER_ONLY==="1") {
      await captureWizard(page,"order-parcels-registration-pending",/Register new seller tracking for this order/);
    }
    await page.getByLabel("Carrier (if known)").selectOption("sf");
    await page.getByRole("button",{name:"Add inbound parcel"}).click();
    await page.getByRole("status").filter({hasText:waybill}).waitFor();
    await declaredTracking.locator(`option[value="${waybill}"]`).waitFor({state:"detached"});
    await page.getByRole("row").filter({has:page.getByRole("button",{name:waybill,exact:true})})
      .getByRole("cell",{name:sf.labels.en,exact:true}).waitFor();
    const current=await call(orderPath);
    assert.deepEqual(current.unregistered_waybills.map(row=>row.tracking_no),declaredWaybills.slice(index+1));
    assert.equal(current.parcels.find(row=>row.tracking_norm===waybill).warehouse_state,null);
    const actions=await call("/actions");
    assert.equal(actions.rows.some(row=>row.id===order.id&&row.state==="awaiting_samples"),index===0);
  }
  const firstParcel=(await call(orderPath)).parcels.find(parcel=>parcel.tracking_norm===declaredWaybills[0]);
  await page.goto("/parcels/"+firstParcel.id);
  await page.getByText("Correct tracking number or carrier before check-in",{exact:true}).click();
  assert(sf.phone_rule.required);
  const phone=page.getByLabel(sf.format_hint,{exact:true});
  await phone.waitFor();
  if(process.env.QCW_BROWSER_NEW_CUSTOMER_ONLY==="1") await captureWizard(page,"parcel-correction-phone","Tracking details");
  const correctedWaybill="SF"+randomUUID().slice(0,8).toUpperCase();
  await page.getByLabel("Corrected tracking number").fill(correctedWaybill);
  await page.getByLabel("Reason for correction").fill("Seller confirmed a replacement label.");
  await phone.fill(sf.phone_rule.format==="last4"?"1234":"13800000000");
  await page.getByRole("button",{name:"Save corrected tracking"}).click();
  await page.getByRole("status").filter({hasText:correctedWaybill}).waitFor();
  assert.equal((await call(orderPath)).parcel_registration_due,false);
  await page.goto("/orders/"+orderNumber);
  await page.getByRole("link",{name:"Track inbound parcels",exact:true}).waitFor();
  if(process.env.QCW_BROWSER_NEW_CUSTOMER_ONLY==="1") await captureWizard(page,"order-parcels-registration-complete",orderNumber);
  const ownCharges=(await call("/me/billing")).charges.filter(charge=>charge.order_ids.includes(order.id));
  assert.equal(ownCharges.length,1);
  await call(`/charges/${ownCharges[0].charge_item_id}/receipt`,{status:404});
  await other.call("/checkout/demo/"+attemptId,{body:{},status:404});
  const chargeId=ownCharges[0].charge_item_id;
  await page.goto("/orders/"+orderNumber+"/payment");
  await page.getByRole("link",{name:"Open billing"}).click();
  await page.waitForURL("**/account/billing?charge="+chargeId+"#charge-"+chargeId);
  const chargeAnchor=page.locator("#charge-"+chargeId);
  const focusedBill=page.getByRole("row").filter({has:chargeAnchor});
  await focusedBill.getByText("Test payment confirmed").waitFor();
  await page.waitForFunction(id=>document.activeElement?.id===id,"charge-"+chargeId);
  await captureWizard(page,"billing-focused-charge","Billing");
  await other.page.goto("/account/billing?charge="+chargeId);
  await other.page.getByText("This charge is unavailable.").waitFor();
  assert.equal(await other.page.locator("#charge-"+chargeId).count(),0);

  await page.goto("/account/security");
  await page.getByLabel("Display name").fill("Browser fixture name");
  await page.getByLabel("Display time zone").fill("Pacific/Honolulu");
  await page.getByRole("button",{name:"Save display preferences"}).click();
  await page.getByText("Display preferences saved.").waitFor();
  assert.deepEqual((await call("/me")).profile,{display_name:"Browser fixture name",timezone:"Pacific/Honolulu"});
  const createdAt=(await call(orderPath)).created_at;
  const displayed=new Intl.DateTimeFormat("en-US",{
    year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Pacific/Honolulu",
  }).format(new Date(createdAt));
  await page.goto("/orders/"+orderNumber);
  await page.getByText(displayed,{exact:true}).first().waitFor();
  await page.goto("/account/security");
  await page.waitForFunction(()=>document.querySelector('input[name="timezone"]')?.value==="Pacific/Honolulu");

  const trackingNo="SF"+randomUUID().slice(0,8).toUpperCase();
  const parcel=await call("/me/parcels",{body:{address_id:profile.warehouse_address.id,carrier_code:"sf",tracking_no:trackingNo},status:201});
  await page.goto("/parcels/"+parcel.id);
  await page.getByRole("link",{name:"Get help with this parcel"}).click();
  await page.waitForURL("**/support?parcel="+parcel.id);
  assert.equal(await page.getByLabel("Related inbound parcel (optional)").inputValue(),parcel.id);
  await page.getByLabel("Subject").fill("Test parcel case with evidence");
  await page.getByLabel("Message",{exact:true}).fill("Please check the evidence for this inbound parcel.");
  const proof=await sharp({create:{width:40,height:40,channels:3,background:"#126a70"}}).png().toBuffer();
  await page.locator('input[type="file"][name="photo"]').setInputFiles({name:"fixture.png",mimeType:"image/png",buffer:proof});
  await page.getByRole("button",{name:"Submit case"}).click();
  const caseLink=page.getByRole("link",{name:/^C-/}).first();
  await caseLink.click();
  await page.getByRole("link",{name:"Parcel "+trackingNo}).waitFor();
  const caseData=await call("/cases/"+new URL(page.url()).pathname.split("/").at(-1));
  assert.equal(caseData.parcel.id,parcel.id);
  const mediaId=caseData.events[0].media_ids[0];
  assert(mediaId);
  assert.equal((await customer.context.request.get("/api/v1/media/"+mediaId)).status(),200);
  await other.call("/media/"+mediaId,{status:404});
  await customer.context.grantPermissions(["clipboard-read","clipboard-write"],{origin});
  await page.goto("/account");
  await page.getByRole("button",{name:"Copy Chinese shipping address"}).click();
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  assert(copied.includes(profile.receiving_code));
  assert(!copied.includes(otherProfile.receiving_code));
  await page.goto("/orders?state=awaiting_samples");
  await page.getByRole("link",{name:orderNumber,exact:true}).click();
  await page.waitForURL("**/orders/"+orderNumber);
  await page.goBack();
  await page.waitForURL("**/orders?state=awaiting_samples");
  await page.goForward();
  await page.waitForURL("**/orders/"+orderNumber);
  const expiredContext=await browser.newContext({baseURL});
  await expiredContext.addCookies(await customer.context.cookies());
  const expired=await expiredContext.newPage();
  await expiredContext.clearCookies();
  await expired.goto("/orders/"+orderNumber);
  assert.equal(new URL(expired.url()).pathname,"/login");
  assert.equal(new URL(expired.url()).searchParams.get("next"),"/orders/"+orderNumber);
  await expiredContext.close();
  console.log("PASS quote 404/422/409/500/timeout UI recovery, actual quote snapshot, refresh, payment replay and tenant isolation");
  if(process.env.QCW_BROWSER_NEW_CUSTOMER_ONLY==="1") {
    assert.deepEqual(customer.errors,[]);
    assert(entries.every(entry=>entry.overflow<=1),"A screenshot page has horizontal overflow.");
    return;
  }
  await verifyWorkspaceViews(customer,other);
}

async function verifyWorkspaceViews(customer,other) {
  const fixtureEmail = process.env.QCW_BROWSER_FIXTURE_EMAIL;
  const fixture = fixtureEmail?await session(fixtureEmail,false,true):customer;
  if(fixture!==customer) await customer.page.close();
  const desk = await fixture.call("/me/desk");
  const published = (await fixture.call("/me/reports?latest=1")).rows[0];
  const caseId = desk.tickets[0]?.id;
  const chosenOrder = desk.orders.find(item=>item.public_no===published?.order_number)??desk.orders[0];
  const parcelId = desk.advices[0]?.id;
  const shipmentId = desk.shipments[0]?.id;
  const detail=await fixture.call("/orders/"+chosenOrder.id);
  const orderQuote=detail.quotes[0]?.id;
  const orderShipment=detail.shipments[0]?.id;
  const orderCase=detail.cases[0]?.id;
  const paths = [
    ["account","/account",/Workspace Overview/],["new-inspection","/orders/new",/Create an Inspection/],
    ["orders","/orders",/Inspection orders/],["actions","/actions",/Action required/i],
    ["reports","/reports",/^Reports$/],["parcels","/parcels",/^Parcels$/],["items","/items",/Warehouse items/],
    ["billing","/account/billing",/^Billing$/],["notifications","/account/notifications",/^Notifications$/],
    ["support","/support",/^Support$/],["account-security","/account/security",/Sign-in methods & security/i],
    ["order","/orders/"+chosenOrder.public_no,chosenOrder.public_no],
    ["order-payment","/orders/"+chosenOrder.public_no+"/payment",/Inspection payment/],
    ["order-parcels","/orders/"+chosenOrder.public_no+"/parcels",/Inbound parcels linked/],
    ["order-items","/orders/"+chosenOrder.public_no+"/dispositions",/Instructions by item/],
    ["order-storage","/orders/"+chosenOrder.public_no+"/storage",/Storage by item/],
  ];
  if(published) paths.push(["report","/orders/"+published.order_number+"/report/versions/"+published.version,published.report_number]);
  if(parcelId) paths.push(["parcel","/parcels/"+parcelId,/tracking/i]);
  if(shipmentId) paths.push(["shipment","/shipments/"+shipmentId,/tracking/i]);
  if(caseId) paths.push(["support-case","/support/cases/"+caseId,/Messages/]);
  if(orderCase) paths.push(["order-case","/orders/"+chosenOrder.public_no+"/cases/"+orderCase,/Messages/]);
  if(orderQuote) paths.push(["order-quote","/orders/"+chosenOrder.public_no+"/quotes/"+orderQuote,/Fulfillment quote/]);
  if(orderShipment) paths.push(["order-shipment","/orders/"+chosenOrder.public_no+"/shipments/"+orderShipment,/Shipment details/]);

  if(process.env.QCW_BROWSER_COMPARISON_EMAIL&&missingViewports("report-comparison")) {
    const comparison=await session(process.env.QCW_BROWSER_COMPARISON_EMAIL,false,true);
    const candidates=(await comparison.call("/me/reports?latest=1")).rows;
    let compared;
    for(const candidate of candidates) {
      const inspection=await comparison.call("/orders/"+candidate.order_id);
      if(inspection.lines.some(line=>line.service==="compare")) {compared=candidate;break;}
    }
    assert(compared,"The comparison customer must have a published comparison report.");
    await comparison.page.goto(`/orders/${compared.order_number}/report/versions/${compared.version}`);
    await comparison.page.locator(".report-comparison table").first().waitFor();
    await captureWizard(comparison.page,"report-comparison",compared.report_number);
    await comparison.page.setViewportSize({width:375,height:1000});
    const scrolls=await comparison.page.locator(".report-comparison .table-wrap").first().evaluate(table=>table.scrollWidth>table.clientWidth);
    assert(scrolls,"The side-by-side report should remain horizontally scrollable inside its mobile comparison table.");
    assert.deepEqual(comparison.errors,[]);
    await comparison.context.close();
  }

  const outbound=desk.active_batches.flatMap(batch=>batch.outbound_shipments)[0];
  if(outbound) {
    await fixture.page.goto("/items");
    const batchPanel=fixture.page.locator("section").filter({has:fixture.page.getByRole("heading",{name:"Dispatch batches",exact:true})});
    await batchPanel.getByRole("button",{name:outbound.tracking_norm,exact:true}).click();
    await fixture.page.getByRole("dialog").getByText(outbound.tracking_norm,{exact:false}).first().waitFor();
    await fixture.page.keyboard.press("Escape");
  }

  if(process.env.QCW_BROWSER_INVENTORY_EMAIL&&missingViewports("inventory-item")) {
    const inventory=process.env.QCW_BROWSER_INVENTORY_EMAIL===fixtureEmail?fixture:await session(process.env.QCW_BROWSER_INVENTORY_EMAIL,false,true);
    const results=await inventory.call("/me/inventory?filter=handling");
    const {page:itemsPage}=inventory;
    assert(results.has_more);
    const [first,later]=[results.rows[0],(await inventory.call("/me/inventory?filter=handling&page=2")).rows[0]];
    await itemsPage.goto("/items?filter=handling");
    await itemsPage.getByRole("checkbox",{name:`Select ${first.code} for handling`,exact:true}).check();
    await itemsPage.getByRole("navigation",{name:"Inventory pages"}).getByRole("link",{name:"Next"}).click();
    await itemsPage.getByRole("checkbox",{name:`Select ${later.code} for handling`,exact:true}).check();
    await itemsPage.getByText("2 selected",{exact:true}).waitFor();
    await itemsPage.getByLabel("Requested action").selectOption("retain");
    await itemsPage.getByRole("checkbox",{name:/I authorize this request/}).check();
    await itemsPage.getByRole("button",{name:"Save handling instruction (2 items)"}).click();
    await itemsPage.getByText(/Instructions recorded for/).waitFor();
    for(const item of [first,later]) {
      assert.equal((await inventory.call("/me/inventory?code="+item.code)).rows[0].active_disposition.action,"retain");
    }
    await itemsPage.goto("/items?item="+encodeURIComponent(later.code));
    const itemDialog=itemsPage.getByRole("dialog",{name:`Warehouse Item · ${later.code}`});
    await itemDialog.waitFor();
    assert.equal(await itemDialog.getByRole("button",{name:"Close"}).evaluate(button=>button===document.activeElement),true);
    await captureWizard(itemsPage,"inventory-item",new RegExp(later.code));
    await other.call("/me/inventory?code="+later.code,{status:404});
    await itemsPage.keyboard.press("Escape");
    assert.deepEqual(inventory.errors,[]);
    if(inventory!==fixture) await inventory.context.close();
    console.log("PASS paginated inventory, cross-page item selection, two persisted handling instructions and exact item ownership");
  }

  for(const width of widths) {
    await fixture.page.setViewportSize({width,height:1000});
    for(const [name,path,heading] of paths) {
      if(captured(name,width)) continue;
      await fixture.page.goto(path,{waitUntil:"domcontentloaded"});
      try {await capture(fixture.page,name,width,heading);}
      catch(error) {throw new Error(`Capture failed for ${name} at ${width} px`,{cause:error});}
      if(name==="order-parcels"&&["closed","cancelled"].includes(chosenOrder.state)) {
        assert.equal(await fixture.page.getByRole("button",{name:"Add inbound parcel"}).count(),0);
      }
    }
  }
  await fixture.page.goto("/orders/"+chosenOrder.public_no+"/payment",{waitUntil:"domcontentloaded"});
  const scope=fixture.page.locator("section").filter({has:fixture.page.getByRole("heading",{name:"Inspection scope",exact:true})});
  await scope.waitFor();
  const scopeCode=scope.locator("button.code-btn").first();
  if(await scopeCode.count()) {
    const layout=await scopeCode.evaluate(button=>{
      const cell=button.closest("td");
      const label=cell.querySelector(".table-cell-label").getBoundingClientRect();
      const bounds=button.getBoundingClientRect();
      const range=document.createRange();
      range.selectNodeContents(button);
      const text=range.getBoundingClientRect();
      return {stacked:text.top>=label.bottom,contained:text.top>=bounds.top&&text.bottom<=bounds.bottom&&
        bounds.right<=cell.getBoundingClientRect().right+1};
    });
    assert.deepEqual(layout,{stacked:true,contained:true});
  }
  await fixture.page.goto("/orders/new",{waitUntil:"domcontentloaded"});
  await fixture.page.getByRole("radio",{name:/Apparel.*Available now/}).waitFor();
  await fixture.page.getByRole("button",{name:"Open workspace menu"}).click();
  await fixture.page.locator(".workspace-sidebar").getByRole("link",{name:"Reports",exact:true}).waitFor();
  await fixture.page.locator(".workspace-sidebar").getByRole("link",{name:"Orders",exact:true}).click();
  await fixture.page.waitForURL("**/orders");
  await fixture.page.getByRole("button",{name:"Open workspace menu"}).waitFor();

  if(published) {
    const versionPath="/orders/"+published.order_id+"/report/versions/"+published.version;
    const file=await fixture.call(versionPath+"/pdf");
    const binary=await fixture.context.request.get(file.url);
    assert.equal(binary.status(),200);
    assert.equal((await binary.body()).subarray(0,4).toString(),"%PDF");
    await other.call(versionPath,{status:404});
    await other.call(versionPath+"/pdf",{status:404});
    const current=await fixture.call(versionPath);
    const older=current.versions.find(version=>version.state==="superseded");
    if(older) {
      const olderPath=`/orders/${published.order_id}/report/versions/${older.version}`;
      await fixture.page.goto(`/orders/${published.order_number}/report/versions/${older.version}`,{waitUntil:"domcontentloaded"});
      try {
        await fixture.page.getByText(/This is a historical report/).waitFor({timeout:15000});
      } catch (error) {
        if(await fixture.page.getByRole("status").getByText("Loading report evidence…").count()===0) throw error;
        await fixture.page.reload({waitUntil:"domcontentloaded"});
        await fixture.page.getByText(/This is a historical report/).waitFor();
      }
      const olderPdf=await fixture.call(olderPath+"/pdf");
      assert.equal(olderPdf.version,older.version);
      assert.notEqual(olderPdf.url,file.url);
      await captureWizard(fixture.page,"report-historical",published.report_number);
    }
  }
  if(caseId) await other.call("/cases/"+caseId,{status:404});
  if(parcelId) await other.call("/me/parcels/"+parcelId+"/tracking",{status:404});
  const reviewer = await session("reviewer@qcw.test",true);
  const inspector = await session("inspector@qcw.test",true);
  await reviewer.page.goto("/wh/review");
  await inspector.page.goto("/wh/inspection");
  for(const [actor,route] of [[reviewer,"reviewer"],[inspector,"inspector"]]) {
    assert.equal((await actor.page.locator(".workspace-sidebar").count()),1,route);
    await actor.call("/me/desk",{status:403});
    assert.deepEqual(actor.errors,[]);
  }
  assert.deepEqual(customer.errors,[]);
  assert.deepEqual(fixture.errors,[]);
  assert(entries.every(entry=>entry.overflow<=1),"A screenshot page has horizontal overflow.");
  console.log("PASS browser viewports, customer report/PDF ownership and reviewer/inspector workspace isolation");
}
