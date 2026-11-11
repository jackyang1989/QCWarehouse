import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const { chromium } = await import(process.env.QCW_PLAYWRIGHT_MODULE ?? "playwright");
const baseURL = process.env.QCW_BROWSER_URL ?? "http://localhost:3411";
const origin = new URL(baseURL).origin;
assert(["localhost","127.0.0.1"].includes(new URL(origin).hostname), "Use a local isolated app.");
const out = process.env.QCW_BROWSER_EVIDENCE;
assert(out, "Set QCW_BROWSER_EVIDENCE to an evidence directory.");
await mkdir(out, {recursive:true});
const browser = await chromium.launch({channel:"chrome",headless:true});
const entries = [];

async function session(email = randomUUID()+"@qcw.test", staff = false, existingFixture = false) {
  const context = await browser.newContext({baseURL,viewport:{width:1440,height:1000}});
  async function call(path, options = {}) {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const csrf = (await context.cookies()).find(cookie => cookie.name === "qcw_csrf")?.value;
    const result = await context.request.fetch("/api/v1"+path, {method,data:options.body,
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

async function capture(page, name, width, heading) {
  await ready(page,heading);
  await page.waitForLoadState("networkidle");
  await page.evaluate(async()=>{await document.fonts.ready; window.scrollTo({top:0,behavior:"instant"});});
  const overflow = await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  if(overflow>1) {
    const elements=await page.evaluate(()=>[...document.querySelectorAll("body *")].flatMap(element=>{
      const bounds=element.getBoundingClientRect();
      if(bounds.right<=innerWidth+1||element.closest(".table-wrap,.tablewrap")||bounds.width===0) return [];
      return [element.tagName+"."+String(element.className).split(" ").join(".")+":"+Math.round(bounds.right)];
    }).slice(0,12));
    console.log("OVERFLOW",name,width,overflow,elements.join(" "));
  }
  await page.screenshot({path:join(out,name+"-"+width+".png"),fullPage:true,animations:"disabled"});
  entries.push({name,width,overflow});
}

async function captureWizard(page, name, heading) {
  for(const width of [1440,1280,1024,768,390,375]) {
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
  await context.route(patchRoute,interrupt);
  await context.setOffline(true);
  await notes.fill("Offline notes recovered after reload");
  await page.waitForFunction(()=>Object.values(sessionStorage).some(value=>value.includes("Offline notes recovered after reload")));
  assert.notEqual((await call(path)).customer_notes,"Offline notes recovered after reload");
  const offline=await page.reload().catch(error=>error);
  assert.match(String(offline),/INTERNET_DISCONNECTED/);
  await context.setOffline(false);
  await page.goto(url);
  await ready(page,/Step 4/);
  await page.waitForFunction(()=>document.querySelector("main textarea")?.value==="Offline notes recovered after reload");
  assert.notEqual((await call(path)).customer_notes,"Offline notes recovered after reload");
  await context.unroute(patchRoute,interrupt);
  await page.getByRole("button",{name:"Update Saved Draft"}).click();
  await page.getByText(new RegExp(`Draft ${initialDraft.public_no} saved`)).waitFor();
  saved=await call(path);
  assert.equal(saved.customer_notes,"Offline notes recovered after reload");

  const second=await context.newPage();
  await second.goto(url);
  await ready(second,/Step 4/);
  const localText="Unsaved notes from the first tab";
  const otherText="Newer notes saved by the second tab";
  await page.route(patchRoute,interrupt);
  await notes.fill(localText);
  await second.getByLabel(/Special/).fill(otherText);
  await second.getByRole("button",{name:"Update Saved Draft"}).click();
  await second.getByText(new RegExp(`Draft ${initialDraft.public_no} saved`)).waitFor();
  const newer=await call(path);
  assert(newer.revision>saved.revision);
  assert.equal(newer.customer_notes,otherText);
  await page.unroute(patchRoute,interrupt);
  await page.getByRole("button",{name:"Update Saved Draft"}).click();
  await page.getByRole("alert").filter({hasText:/changed in another window/}).waitFor();
  await page.reload();
  await page.getByRole("button",{name:"Review my unsaved edits"}).waitFor();
  assert.equal(await notes.inputValue(),otherText);
  await page.getByRole("button",{name:"Review my unsaved edits"}).click();
  assert.equal(await notes.inputValue(),localText);
  assert.equal((await call(path)).revision,newer.revision);
  await page.getByRole("button",{name:"Update Saved Draft"}).click();
  await page.getByText(new RegExp(`Draft ${initialDraft.public_no} saved`)).waitFor();
  assert.equal((await call(path)).customer_notes,localText);
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
    ["/account/notifications",/No updates yet/],["/support",/No support cases yet/],
  ]) {
    await page.goto(path);
    await page.getByText(empty).waitFor();
  }
  console.log("PASS fresh customer empty states match PostgreSQL in eight workspace modules");
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

try {
  const customer = await session();
  const other = await session();
  if(process.env.QCW_BROWSER_MANUAL_QUOTE_ONLY==="1") await verifyManualQuoteRenewal(customer,other);
  else {
    const profile = await customer.call("/me/receiving-address");
    const otherProfile = await other.call("/me/receiving-address");
    assert.notEqual(profile.receiving_code,otherProfile.receiving_code);
    await verifyDraftRecovery(other,customer);
    if(process.env.QCW_BROWSER_RECOVERY_ONLY!=="1") await verifyWorkspace(customer,other,profile,otherProfile);
  }
} finally {
  await writeFile(join(out,"viewports.json"),JSON.stringify(entries,null,2)+"\n");
  await browser.close();
}

async function verifyWorkspace(customer,other,profile,otherProfile) {
  const {page,call}=customer;
  await verifyEmptyWorkspace(customer);

  await page.goto("/orders/new");
  await page.getByRole("radio",{name:/Apparel.*Available now/}).waitFor();
  assert.equal(await page.getByRole("navigation",{name:"Inspection setup steps"}).count(),1);
  assert.equal(await page.locator(".wizard-side").count(),1);
  assert.equal(await page.getByRole("radio",{name:/Electronics/}).isDisabled(),true);
  await nextStep(page);
  await page.getByLabel("Inspection template").selectOption("leggings");
  await captureWizard(page,"wizard-configure",/Step 2/);
  await nextStep(page);
  await page.getByLabel(/Product name/).fill("QA leggings");
  await page.getByLabel(/Default supplier/).fill("Supplier A");
  await page.getByLabel("Item 2 supplier").fill("Supplier B");
  await page.getByLabel(/Default color/).fill("Black");
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
  const ownCharges=(await call("/me/billing")).charges.filter(charge=>charge.order_ids.includes(order.id));
  assert.equal(ownCharges.length,1);
  await call(`/charges/${ownCharges[0].charge_item_id}/receipt`,{status:404});
  await other.call("/checkout/demo/"+attemptId,{body:{},status:404});

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

  const fixtureEmail = process.env.QCW_BROWSER_FIXTURE_EMAIL;
  const fixture = fixtureEmail?await session(fixtureEmail,false,true):customer;
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

  if(process.env.QCW_BROWSER_COMPARISON_EMAIL) {
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
  }

  const outbound=desk.active_batches.flatMap(batch=>batch.outbound_shipments)[0];
  if(outbound) {
    await fixture.page.goto("/items");
    const batchPanel=fixture.page.locator("section").filter({has:fixture.page.getByRole("heading",{name:"Dispatch batches",exact:true})});
    await batchPanel.getByRole("button",{name:outbound.tracking_norm,exact:true}).click();
    await fixture.page.getByRole("dialog").getByText(outbound.tracking_norm,{exact:false}).first().waitFor();
    await fixture.page.keyboard.press("Escape");
  }

  if(process.env.QCW_BROWSER_INVENTORY_EMAIL) {
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
    console.log("PASS paginated inventory, cross-page item selection, two persisted handling instructions and exact item ownership");
  }

  for(const width of [1440,1280,1024,768,390,375]) {
    await fixture.page.setViewportSize({width,height:1000});
    for(const [name,path,heading] of paths) {
      await fixture.page.goto(path);
      await capture(fixture.page,name,width,heading);
      if(name==="order-parcels"&&["closed","cancelled"].includes(chosenOrder.state)) {
        assert.equal(await fixture.page.getByRole("button",{name:"Add inbound parcel"}).count(),0);
      }
    }
  }
  await fixture.page.goto("/orders/new");
  await fixture.page.getByRole("button",{name:"Open workspace menu"}).click();
  assert.equal(await fixture.page.locator(".workspace-sidebar").getByRole("link",{name:"Reports",exact:true}).isVisible(),true);
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
      await fixture.page.goto(`/orders/${published.order_number}/report/versions/${older.version}`);
      await fixture.page.getByText(/This is a historical report/).waitFor();
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
