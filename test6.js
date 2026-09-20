// test6.js — Playwright test for: (1) Sunglasses Sim + Bag Sim training tabs (category-filtered
// Live-Trial-style engines), (2) tone "why it matters" data points in Selling Guide, (3)
// sunglasses per-brand retail price/announcement guide in Sunglasses 101, (4) that the original
// Live Trial tab (all categories, manager rubric, 'trial-*' ids) still works unchanged after the
// engine-factory refactor. DOM-only assertions (app state lives in a top-level IIFE).
const { chromium } = require('playwright');

const BASE = 'http://localhost:8795/index.html';
let failures = 0;

function ok(label, cond) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}`);
    failures++;
  }
}

async function bypassGate(page) {
  await page.evaluate(() => {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('hub').style.display = 'flex';
  });
}

async function goToTrainingTab(page, tab) {
  await page.evaluate(() => {
    document.getElementById('hub').style.display = 'none';
    document.getElementById('training').style.display = 'block';
  });
  await page.click(`.training-tab[data-tab="${tab}"]`);
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [console error]', msg.text());
  });
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

  await page.goto(BASE);
  await bypassGate(page);

  // ---------- 1. Sunglasses Sim: tab exists, filters to sunglasses-only items ----------
  console.log('\n--- Sunglasses Sim ---');
  await goToTrainingTab(page, 'sunsim');
  const sunsimPlatform = await page.$('[data-platform]');
  ok('Sunglasses Sim platforms screen renders a platform picker', !!sunsimPlatform);
  const sunsimHasRubric = await page.$('#rubric-save');
  ok('Sunglasses Sim does NOT show the manager rubric', !sunsimHasRubric);
  if (sunsimPlatform) {
    await sunsimPlatform.click();
    await page.waitForTimeout(200);
    const bodyText = await page.evaluate(() => document.body.innerText);
    ok('Sunglasses Sim item list mentions a sunglasses brand (Versace)', bodyText.includes('Versace'));
    ok('Sunglasses Sim item list does NOT include a bag-only brand (Chanel)', !bodyText.includes('Chanel'));
  }

  // ---------- 2. Bag Sim: tab exists, filters to bag-only items ----------
  console.log('\n--- Bag Sim ---');
  await goToTrainingTab(page, 'bagsim');
  const bagsimPlatform = await page.$('[data-platform]');
  ok('Bag Sim platforms screen renders a platform picker', !!bagsimPlatform);
  if (bagsimPlatform) {
    await bagsimPlatform.click();
    await page.waitForTimeout(200);
    const bodyText = await page.evaluate(() => document.body.innerText);
    ok('Bag Sim item list mentions a bag brand (Louis Vuitton)', bodyText.includes('Louis Vuitton'));
    ok('Bag Sim item list does NOT include a sunglasses-only brand (Ray-Ban)', !bodyText.includes('Ray-Ban'));
  }

  // ---------- 3. Bag Sim go-live uses its own DOM ids (not colliding with #trial-*) ----------
  console.log('\n--- Bag Sim go-live flow uses bagsim- prefixed ids ---');
  const bagItem = await page.$('#training-bagsim [data-item]');
  if (bagItem) {
    await bagItem.click();
    await page.waitForTimeout(200);
    const bagsimGoLive = await page.$('#bagsim-go-live');
    ok('#bagsim-go-live button present on Bag Sim ready screen', !!bagsimGoLive);
    const trialGoLiveAbsent = await page.$('#trial-go-live');
    ok('#trial-go-live is NOT present while on Bag Sim (no id collision)', !trialGoLiveAbsent);
  }

  // ---------- 4. Original Live Trial still works after the factory refactor ----------
  console.log('\n--- Live Trial (original) still intact ---');
  await goToTrainingTab(page, 'trial');
  const trialHasRubric = await page.$('#rubric-save');
  ok('Live Trial still shows the manager rubric', !!trialHasRubric);
  const trialPlatform = await page.$('[data-platform]');
  ok('Live Trial platform picker still renders', !!trialPlatform);
  if (trialPlatform) {
    await trialPlatform.click();
    await page.waitForTimeout(200);
    const bodyText = await page.evaluate(() => document.body.innerText);
    ok('Live Trial item list includes a bag AND a sunglasses brand (all categories)', bodyText.includes('Louis Vuitton') && bodyText.includes('Ray-Ban'));
  }

  // ---------- 5. Selling Guide: tone data points ----------
  console.log('\n--- Selling Guide tone data points ---');
  await goToTrainingTab(page, 'selling');
  const sellingText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  ok('Selling Guide includes "Why tone matters" section', sellingText.includes('why tone matters'));
  ok('Selling Guide includes Sasha\'s Marc Jacobs example (bad)', sellingText.includes('here, i have this marc jacobs bag?'));
  ok('Selling Guide includes Sasha\'s Marc Jacobs example (good)', sellingText.includes('hey, we have this marc jacobs'));

  // ---------- 6. Sunglasses 101: retail price / announcement guide ----------
  console.log('\n--- Sunglasses 101 retail guide ---');
  await goToTrainingTab(page, 'sunglasses');
  const sgTextRaw = await page.evaluate(() => document.body.innerText);
  const sgText = sgTextRaw.toLowerCase();
  ok('Sunglasses 101 includes retail guide heading', sgText.includes('announcing retail price'));
  ok('Sunglasses 101 includes Versace 600 to 800 script line', sgText.includes('this is versace -- these retail for 600 to 800.'));
  ok('Sunglasses 101 includes Carrera retail range', sgText.includes('carrera') && sgText.includes('200'));
  ok('Sunglasses 101 flags at least one estimate as needing confirmation', sgText.includes('estimate'));

  // ---------- 7. Full go-live -> finish flow on Sunglasses Sim writes to its OWN storage key,
  // never touching 'liveTrialResults' (the key certificationStatus()/Day-14 banner depends on).
  console.log('\n--- Sunglasses Sim results storage isolation ---');
  await page.evaluate(() => localStorage.clear());
  await page.reload(); // fresh IIFE instance so every training tab is back to its un-rendered state
  await bypassGate(page);
  await goToTrainingTab(page, 'sunsim');
  await page.click('#training-sunsim [data-platform]');
  await page.waitForTimeout(200);
  await page.click('#training-sunsim [data-item]');
  await page.waitForTimeout(200);
  await page.click('#sunsim-go-live');
  await page.waitForTimeout(3300); // 3-2-1-GO (800ms/tick) + 400ms buffer
  // Answer every comment with a plain, brand+price-bearing statement so the session finishes.
  for (let i = 0; i < 6; i++) {
    const input = await page.$('#sunsim-response-input');
    if (!input) break;
    await input.fill('This is the brand, priced at $150, in great condition.');
    await page.click('#sunsim-send');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  const storageState = await page.evaluate(() => ({
    sunsim: localStorage.getItem('sunglassesSimResults'),
    liveTrial: localStorage.getItem('liveTrialResults'),
  }));
  ok('Sunglasses Sim wrote a result to its OWN "sunglassesSimResults" key', !!storageState.sunsim);
  ok('Sunglasses Sim did NOT write to the shared "liveTrialResults" key (cert tracking untouched)', !storageState.liveTrial);

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
