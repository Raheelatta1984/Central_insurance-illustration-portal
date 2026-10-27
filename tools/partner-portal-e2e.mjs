#!/usr/bin/env node
/**
 * Browser regression for the partner portal. Run after `npm run build:ui && npm run build:server`
 * and a Playwright Chromium install. PORTAL_TEST_CHROMIUM may point to an existing executable.
 * The review/commission rows below are isolated UI fixtures: the real signed journey, policy,
 * commission arithmetic and authorization boundary are exercised in the unit/integration suites.
 */
import { chromium } from 'playwright'; import assert from 'node:assert/strict';
import { createRuntimeState,dispatchApiRoute } from '../dist-server/core/routes.js';
import { createPortalServer } from '../dist-server/server/main.js';
import { loadAuthConfig } from '../dist-server/server/auth.js';
const state=createRuntimeState(1,()=> '2026-10-05T12:00:00Z');
await dispatchApiRoute(state,'POST','/partner-portal/demo/setup',new URLSearchParams(),{});
const scope={partnerId:'DEMO-BROKER',channelCode:'BROKER',subChannelCode:'DEMO-BROKER-DESK'};
const result=await dispatchApiRoute(state,'POST','/partner-portal/journey/open',new URLSearchParams(),{...scope,by:'alice',customerName:'Review fixture'}); const caseId=result.body.caseId;
const revisedCaseId=(await dispatchApiRoute(state,'POST','/partner-portal/journey/open',new URLSearchParams(),{...scope,by:'alice',customerName:'Revised fixture'})).body.caseId;
// Synthetic policy attribution exercises the UI scope selection; domain tests use a real issued policy.
state.world.journey.get(caseId).artefacts.policyId = 'POL-TEST';
state.world.partnerPortal.applications.push({id:'PAPP-BROWSER',caseId,scope,applicationId:'APP',quotationId:'QUOTE',quotationVersion:1,fingerprint:'fixture',submittedBy:'alice',submittedAt:state.now(),status:'pending',review:null,route:null,underwritingReview:null});
state.world.partnerPortal.applications.push({id:'PAPP-REVISED',caseId:revisedCaseId,scope,applicationId:'APP2',quotationId:'QUOTE2',quotationVersion:1,fingerprint:'fixture',submittedBy:'alice',submittedAt:state.now(),status:'approved',review:null,route:null,underwritingReview:null,revisedQuotation:{quotationId:'QTN-REVISED',version:1,decisionFingerprint:'decision',issuedBy:'uw',issuedAt:state.now()}});
state.world.partnerPortal.commissions.push({id:'COM-BROWSER',scope,policyId:'POL-TEST',productId:'PROD-UL-GLOBAL',period:'2026-10',sourceRef:'BATCH-TEST',currency:'AED',premiumMinor:'100000',expectedMinor:'15000',bps:1500,basis:'fixture',createdBy:'finance',createdAt:state.now(),statements:[{reference:'STMT-TEST',amountMinor:'15000',by:'finance',at:state.now()}],status:'awaiting-review',review:null,disbursements:[]});
const server=createPortalServer({state,auth:loadAuthConfig({PORTAL_AUTH_TOKENS:'test=bob:partner-manager,partner:DEMO-BROKER,subchannel:DEMO-BROKER-DESK;finance=fin:partner-finance;service=service:partner-insurer'}),env:{},dist:`${process.cwd()}/dist`,log:()=>{}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.PORTAL_TEST_CHROMIUM;
const browser=await chromium.launch({ ...(executablePath ? { executablePath } : {}), args:['--no-sandbox','--disable-dev-shm-usage'] });
const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(`${base}/partner-portal`,{waitUntil:'networkidle'});
 await page.getByLabel(/Access token/i).fill('test'); await page.getByRole('button',{name:/use access token/i}).click();
 await page.getByLabel(/Sub-channel/).waitFor(); await page.waitForTimeout(100);
 assert.equal(await page.getByLabel(/Sub-channel/).inputValue(),'DEMO-BROKER-DESK');
 await page.getByRole('button',{name:'Applications',exact:true}).click();
 await page.getByLabel('Customer name').fill('Restricted user test');
 await page.getByRole('button',{name:/Create journey/}).click();
 await page.getByRole('heading',{name:'Customer journey'}).waitFor();
 const created=state.world.journey.list().find(c=>c.customerName==='Restricted user test'); assert.equal(created.distribution.subChannelCode,'DEMO-BROKER-DESK'); assert.equal(created.openedBy,'bob');
 // Exercise the actual editor, not only the journey list.
 await page.getByLabel(/Customer kind/).selectOption('person');
 await page.getByLabel(/Name \(English\)/).fill('Restricted user test');
 await page.getByLabel(/Name \(Arabic\)/).fill('نور');
 await page.getByLabel(/Date of birth/).fill('1993-03-08');
 await page.getByLabel(/Identity document type/).selectOption('emirates-id');
 await page.getByLabel(/Identity document number/).fill('784-1993-2233445-6');
 await page.getByLabel(/Verification source/).selectOption('chip');
 await page.getByLabel(/^Phone/).fill('+971507789900');
 await page.getByLabel(/^Email/).fill('browser-fixture@example.ae');
 await page.getByLabel(/^Address/).fill('Sample tower');
 await page.getByLabel(/^City/).fill('Abu Dhabi');
 await page.getByLabel(/^Country/).selectOption('AE');
 await page.getByLabel(/^Consent granted/).fill('Harbour advisory desk');
 await page.getByRole('button',{name:'Submit',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Section submitted'}).waitFor();
 await page.waitForFunction(() => [...document.querySelectorAll('select')].some((select) => select.value === 'profile'));
 assert.ok(created.submitted.includes('identity'));
 await page.getByRole('combobox',{name:/^Application/}).selectOption('PAPP-BROWSER');
 const role=page.getByRole('combobox',{name:/^Reviewer level/}); assert.equal(await role.inputValue(),'manager');
 await page.getByLabel(/^Review note/).fill('Please update this information.');
 await page.getByRole('button',{name:/Return/}).click();
 await page.getByRole('status').filter({hasText:'Application returned'}).waitFor();
 assert.equal(state.world.partnerPortal.application('PAPP-BROWSER').review.by,'bob');
 // Revised acceptance controls: this is a UI fixture; domain tests exercise the real PDF and decision binding.
 await page.getByRole('combobox',{name:/^Application/}).selectOption('PAPP-REVISED');
 await page.getByRole('heading',{name:'Revised underwriting terms'}).waitFor();
 await page.getByText(/not verified electronic signing/i).first().waitFor();
 assert.equal(await page.getByRole('button',{name:'Prepare revised quotation'}).count(),0,'partner reviewer must not prepare insurer quotations');
 await page.route('**/api/partner-portal/quotation?id=PAPP-REVISED', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({pdf:{fileName:'revised.pdf',base64:Buffer.from('%PDF-1.7 fixture').toString('base64')}})}));
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('button',{name:'Download revised quotation PDF'}).click();
 assert.equal((await downloadPromise).suggestedFilename(),'revised.pdf');
 let acceptanceBody;
 await page.route('**/api/partner-portal/quotation/accept', route => { acceptanceBody=route.request().postDataJSON(); return route.fulfill({status:200,contentType:'application/json',body:'{}'}); });
 await page.getByLabel('Customer name for renewed acceptance').fill('Review fixture');
 await page.getByLabel(/customer reviewed the revised quotation/i).check();
 await page.getByRole('button',{name:'Record renewed acceptance'}).click();
 await page.getByRole('status').filter({hasText:'Renewed acceptance recorded'}).waitFor();
 assert.equal(acceptanceBody.id,'PAPP-REVISED'); assert.equal(acceptanceBody.signedBy,'Review fixture'); assert.equal(acceptanceBody.reviewedWithCustomer,true);
 await page.getByRole('button',{name:'Commission',exact:true}).click();
 await page.getByRole('combobox',{name:/^Commission/}).selectOption('COM-BROWSER');
 await page.getByLabel(/^Review note/).fill('Matches the statement exactly.');
 await page.getByRole('button',{name:/Approve/}).click();
 await page.getByRole('status').filter({hasText:'Commission approved'}).waitFor();
 assert.equal(state.world.partnerPortal.commission('COM-BROWSER').review.by,'bob');
 await page.getByRole('heading',{name:'Insurer statement history'}).waitFor();
 await page.getByRole('button',{name:'Service requests',exact:true}).click();
 await page.getByRole('combobox',{name:/^Request type/}).selectOption('reporting-request');
 await page.getByLabel('Subject',{exact:true}).fill('Quarterly report request');
 await page.getByLabel(/^Message/).first().fill('Please provide the quarterly distribution report.');
 await page.getByRole('button',{name:/Send request/}).click();
 await page.getByRole('status').filter({hasText:'Request sent'}).waitFor();
 await page.getByRole('button',{name:'Reports',exact:true}).click();
 await page.getByRole('heading',{name:'Operational snapshot'}).waitFor();
 await page.getByText('reporting request',{exact:true}).first().waitFor();
 await page.setViewportSize({width:390,height:844}); await page.getByRole('button',{name:'Overview',exact:true}).click();
 const dim=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth})); assert.equal(dim.width,dim.scrollWidth);
 // From the partner-wide filter, a selected policy must carry its real sub-channel into
 // finance and service writes. Intercept just those calls to inspect the outgoing UI payload.
 const finance = await browser.newPage();
 await finance.addInitScript(() => sessionStorage.setItem('portal-api-token', 'finance'));
 await finance.goto(`${base}/partner-portal`,{waitUntil:'networkidle'});
 await finance.getByLabel('Partner',{exact:true}).selectOption('DEMO-BROKER');
 await finance.getByRole('button',{name:'Commission',exact:true}).click();
 await finance.getByRole('combobox',{name:/^Policy/}).selectOption('POL-TEST');
 await finance.getByLabel(/Accrual source reference/).fill('UI-BATCH');
 await finance.getByLabel(/Premium basis/).fill('1000.00');
 let accrualBody;
 await finance.route('**/api/partner-portal/commission/accrue', async (route) => { accrualBody = route.request().postDataJSON(); await route.fulfill({status:200,contentType:'application/json',body:'{}'}); });
 await finance.getByRole('button',{name:'Record accrual'}).click();
 await finance.getByRole('status').filter({hasText:'Commission accrual reference recorded'}).waitFor();
 assert.equal(accrualBody.subChannelCode, 'DEMO-BROKER-DESK');
 await finance.close();
 const service = await browser.newPage();
 await service.addInitScript(() => sessionStorage.setItem('portal-api-token', 'service'));
 await service.goto(`${base}/partner-portal`,{waitUntil:'networkidle'});
 await service.getByLabel('Partner',{exact:true}).selectOption('DEMO-BROKER');
 await service.getByRole('button',{name:'Service requests',exact:true}).click();
 await service.getByRole('combobox',{name:/^Policy/}).selectOption('POL-TEST');
 await service.getByLabel('Subject',{exact:true}).fill('Policy information');
 await service.getByLabel(/^Message/).first().fill('Please provide the policy status.');
 let requestBody;
 await service.route('**/api/partner-portal/requests/open', async (route) => { requestBody = route.request().postDataJSON(); await route.fulfill({status:200,contentType:'application/json',body:'{}'}); });
 await service.getByRole('button',{name:/Send request/}).click();
 await service.getByRole('status').filter({hasText:'Request sent'}).waitFor();
 assert.equal(requestBody.subChannelCode, 'DEMO-BROKER-DESK');
 await service.close();
 // The deployed standalone demo has no server-side /partner-portal route or CSS assets.
 const offline = await browser.newPage({viewport:{width:1365,height:900}});
 offline.on('pageerror', error => errors.push(error.message));
 await offline.goto(`${new URL('../demo/offline.html',import.meta.url).href}#partner-portal`);
 await offline.getByRole('button',{name:/Create sample workspace/}).waitFor();
 assert.equal(await offline.locator('.pp').evaluate(node => getComputedStyle(node).display),'grid','standalone demo must inline portal CSS');
 await offline.getByRole('button',{name:/Create sample workspace/}).click();
 await offline.getByRole('heading',{name:'Your distribution, in one place'}).waitFor();
 await offline.getByRole('link',{name:'Back to console',exact:true}).click();
 await offline.getByText('Enterprise Security & DOA Governance Gate').waitFor();
 await offline.close();
 assert.deepEqual(errors,[]); console.log('Partner e2e passed: login, sub-channel scope, editor, reviews, revised-quote controls, commission, requests, reporting, mobile and standalone demo',dim);
} catch(e) {console.error('BODY',(await page.locator('body').innerText()).slice(-7000)); console.error('PAGE ERRORS',errors);throw e;} finally {await browser.close();await new Promise(r=>server.close(r));}
