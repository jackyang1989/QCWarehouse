import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

try {
  const customer = await session();
  const other = await session();
  const {page,call} = customer;
  const profile = await call("/me/receiving-address");
  const otherProfile = await other.call("/me/receiving-address");
  assert.notEqual(profile.receiving_code,otherProfile.receiving_code);

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
  await page.getByRole("button",{name:"Confirm test payment"}).click();
  await page.waitForURL("**/orders/"+orderNumber);
  await ready(page,orderNumber);
  assert.equal((await call(orderPath)).state,"awaiting_samples");
  assert.equal((await call(orderPath+"/payment")).state,"paid");
  assert.equal((await call("/checkout/demo/"+attemptId,{body:{}})).order_number,orderNumber);
  assert.equal((await call("/me/billing")).charges.filter(charge=>charge.order_ids.includes(order.id)).length,1);
  await other.call("/checkout/demo/"+attemptId,{body:{},status:404});
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

  const outbound=desk.active_batches.flatMap(batch=>batch.outbound_shipments)[0];
  if(outbound) {
    await fixture.page.goto("/items");
    const batchPanel=fixture.page.locator("section").filter({has:fixture.page.getByRole("heading",{name:"Dispatch batches",exact:true})});
    await batchPanel.getByRole("button",{name:outbound.tracking_norm,exact:true}).click();
    await fixture.page.getByRole("dialog").getByText(outbound.tracking_norm,{exact:false}).first().waitFor();
    await fixture.page.keyboard.press("Escape");
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
} finally {
  await writeFile(join(out,"viewports.json"),JSON.stringify(entries,null,2)+"\n");
  await browser.close();
}
