// test6.js — Playwright test for: (1) Sunglasses Sim + Bag Sim training tabs (category-filtered
// Live-Trial-style engines), (2) tone "why it matters" data points in Selling Guide, (3)
// sunglasses per-brand retail price/announcement guide in Sunglasses 101, (4) that the original
// Live Trial tab (all categories, manager rubric, 'trial-*' ids) still works unchanged after the
// engine-factory refactor, (5) that Sunglasses Sim / Bag Sim's response step is verbal-practice
// only -- no textarea, a press-to-start 30s countdown, then a self-paced Run Next button, with no
// auto-grading -- while Live Trial keeps its original typed + auto-graded step, (6) sunglasses
// items list under a generic "Brand New Sunglasses / Rx Frames N" auction-lot title in every item
// picker, revealing the real brand only once she's on the ready/session screen, (7) off-item
// ambient chatter lines (viewers asking about other brands/items), (8)-(9) Sunglasses Sim results
// storage isolation and Live Trial's unchanged typed/graded step, and (10) new comment types: the
// ambient "do you have X?" brand-curiosity line is now randomized across the FULL brands pool
// (not 4 fixed names), an "I have a problem with my order" comment graded on redirecting to
// "send a message through your order" instead of resolving it live, and an off-item "can I see
// that bag?" inquiry using a real leveluxbag.com listing title. Most of (10) is checked by
// injecting a copy of index.html's own script (stripped of its outer IIFE) as a second <script>
// tag, since app state otherwise lives in a top-level IIFE closure Playwright can't reach; a real
// DOM flow then confirms both new comment types actually render live. (11)-(12): the former
// standalone "Auction Close" tab has been removed and its closing-chant/countdown drill folded
// into the end of every Sunglasses Sim / Bag Sim session (right before the results screen), using
// the exact item/brand she just practiced verbal responses for -- (11) confirms the closing-drill
// setup screen and live overlay both show that real session brand/item (Bag Sim's Louis Vuitton
// Neverfull MM), not a random pick, and that finishing the drill reaches the completion screen;
// (12) confirms "End early" inside the live overlay returns to the closing-drill setup screen
// (not results, not platforms), matching the old standalone tab's End-early behavior, now wired
// through the generic auctionDoneCallback/auctionEndEarlyCallback mechanism. Playwright's clock
// fast-forwards the 3-2-1-GO, 30s practice, and closing-drill countdowns instead of waiting on
// them in real time.
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
    // Sunglasses items list under a generic "Rx Frames" auction-lot title, not the real brand
    // name -- the real brand only comes out once she's live with the item (see the "ready" /
    // "session" screen checks further down).
    ok('Sunglasses Sim item list uses the generic "Rx Frames" listing title, not the real brand', /rx frames/i.test(bodyText) && !bodyText.includes('Versace'));
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
    // Sunglasses items show under the generic "Rx Frames" listing title here too (Live Trial
    // shares the same item picker), so check for that instead of the real sunglasses brand name.
    ok('Live Trial item list includes a bag brand AND a sunglasses item (all categories)', bodyText.includes('Louis Vuitton') && /rx frames/i.test(bodyText));
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

  // ---------- 7. Sunglasses Sim / Bag Sim response step is verbal-practice: no textarea, a
  // press-to-start 30s countdown, then a Run Next button she clicks herself. Live Trial keeps
  // the original typed + auto-graded flow (certification depends on it). Playwright's clock is
  // installed after the reload so the 3-2-1-GO countdown and the 30s practice timer can be
  // fast-forwarded instead of waiting in real time.
  console.log('\n--- Sunglasses Sim: verbal-practice response step (no typing, 30s countdown, Run Next) ---');
  await page.evaluate(() => localStorage.clear());
  await page.reload(); // fresh IIFE instance so every training tab is back to its un-rendered state
  await page.clock.install();
  await bypassGate(page);
  await goToTrainingTab(page, 'sunsim');
  await page.click('#training-sunsim [data-platform]');
  await page.waitForTimeout(50);
  await page.click('#training-sunsim [data-item]');
  await page.waitForTimeout(50);
  // The generic "Rx Frames" listing title was only for the picker -- once she's on the "ready"
  // screen (about to go live with the item in hand), the real brand shows again.
  const readyBodyText = await page.evaluate(() => document.body.innerText);
  ok('Ready screen reveals the real brand (Ray-Ban), not the generic listing title', readyBodyText.includes('Ray-Ban'));
  await page.click('#sunsim-go-live');
  await page.clock.runFor(3300); // 3-2-1-GO (800ms/tick) + 400ms buffer

  const noTextarea = await page.$('#sunsim-response-input');
  ok('Sunglasses Sim session screen has NO typed-response textarea', !noTextarea);
  const startBtnVisible = await page.isVisible('#sunsim-practice-start');
  ok('Sunglasses Sim shows a "press to start" button', startBtnVisible);
  const nextHiddenBefore = await page.isVisible('#sunsim-practice-next');
  ok('Run Next button is NOT visible before the countdown finishes', !nextHiddenBefore);

  await page.click('#sunsim-practice-start');
  await page.waitForTimeout(50);
  const countdownAfterStart = await page.textContent('#sunsim-practice-countdown');
  ok('Countdown shows 30 right after pressing start', countdownAfterStart.trim() === '30');
  await page.clock.runFor(15000);
  const countdownMidway = parseInt((await page.textContent('#sunsim-practice-countdown')).trim(), 10);
  ok('Countdown has ticked down partway through (< 30, > 0)', countdownMidway < 30 && countdownMidway > 0);
  await page.clock.runFor(15000); // completes the 30s
  const countdownAtZero = await page.textContent('#sunsim-practice-countdown');
  ok('Countdown reaches 0', countdownAtZero.trim() === '0');
  const nextVisibleAtZero = await page.isVisible('#sunsim-practice-next');
  ok('Run Next button appears once the countdown hits 0', nextVisibleAtZero);

  // ---------- 8. Full go-live -> finish flow on Sunglasses Sim (pressing Run Next through every
  // comment, then completing the closing drill that now follows it) writes to its OWN storage
  // key, never touching 'liveTrialResults' (the key certificationStatus()/Day-14 banner depends
  // on).
  console.log('\n--- Sunglasses Sim results storage isolation ---');
  for (let i = 0; i < 6; i++) {
    const nextBtn = await page.$('#sunsim-practice-next');
    if (nextBtn && (await nextBtn.isVisible())) {
      await nextBtn.click();
      await page.waitForTimeout(50);
    }
    const startBtn = await page.$('#sunsim-practice-start');
    if (!startBtn) break; // session screen is gone -- reached the closing-drill setup screen
    await startBtn.click();
    await page.clock.runFor(30000);
  }
  await page.waitForTimeout(50);
  const closeoutGoLiveBtn = await page.$('#sunsim-closeout-go-live');
  ok('Last comment leads to the closing-drill setup screen (not straight to results)', !!closeoutGoLiveBtn);
  await page.click('#sunsim-closeout-attention');
  await page.click('#sunsim-closeout-go-live');
  await page.waitForTimeout(50);
  ok('Closing-drill live overlay appears after Go Live', await page.isVisible('#auction-live'));
  await page.clock.runFor(21000); // default 20s closeout timer + buffer
  await page.waitForTimeout(50);
  const doneBtn = await page.$('#sunsim-done');
  ok('Reached the verbal-practice completion screen ("Practice complete") after the closing drill', !!doneBtn);
  const storageState = await page.evaluate(() => ({
    sunsim: localStorage.getItem('sunglassesSimResults'),
    liveTrial: localStorage.getItem('liveTrialResults'),
  }));
  ok('Sunglasses Sim wrote a result to its OWN "sunglassesSimResults" key', !!storageState.sunsim);
  ok('Sunglasses Sim did NOT write to the shared "liveTrialResults" key (cert tracking untouched)', !storageState.liveTrial);

  // ---------- 9. Live Trial keeps its original typed + auto-graded response step (unaffected by
  // the verbal-practice change above, since only Sunglasses Sim / Bag Sim opted into it). ----------
  console.log('\n--- Live Trial still uses the typed/graded response step ---');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await bypassGate(page);
  await goToTrainingTab(page, 'trial');
  await page.click('#training-trial [data-platform]');
  await page.waitForTimeout(200);
  await page.click('#training-trial [data-item]');
  await page.waitForTimeout(200);
  await page.click('#trial-go-live');
  await page.waitForTimeout(3300);
  const trialTextarea = await page.$('#trial-response-input');
  ok('Live Trial session screen still has the typed-response textarea', !!trialTextarea);
  const trialPracticeStart = await page.$('#trial-practice-start');
  ok('Live Trial does NOT show the verbal-practice Start button', !trialPracticeStart);

  // ---------- 10. New chat-comment types: brand-pool-randomized ambient curiosity line, an
  // "I have a problem with my order" redirect-graded comment, and an off-item "can I see that
  // bag?" inquiry using a real leveluxbag.com listing title. The pure logic (arrays + grading) is
  // exercised by injecting a copy of the app's own script -- stripped of its outer IIFE wrapper so
  // its top-level names attach to `window` -- as a second <script> tag on the already-loaded page.
  // This runs the SAME source as index.html, just unwrapped, so it's testing production logic, not
  // a reimplementation. DOM-only closures can't be reached any other way (see file header note).
  console.log('\n--- New comment types: order-problem redirect, off-item inquiry, brand-randomized ambient chatter ---');
  const fs = require('fs');
  const path = require('path');
  const fullSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].trim();
  if (!fullSrc.startsWith('(function () {') || !fullSrc.endsWith('})();')) {
    console.log('  [warn] could not locate expected IIFE wrapper -- skipping section 10 logic checks');
  } else {
    const unwrapped = fullSrc.slice('(function () {'.length, -('})();'.length)) +
      '\nwindow.__test = { BRANDS: BRANDS, TRIAL_AMBIENT_CHATTER: TRIAL_AMBIENT_CHATTER, ORDER_PROBLEM_VARIANTS: ORDER_PROBLEM_VARIANTS, OFF_ITEM_LISTING_TITLES: OFF_ITEM_LISTING_TITLES, pickTrialComments: pickTrialComments, gradeTrialSession: gradeTrialSession, randomAmbientLine: randomAmbientLine };';
    await page.addScriptTag({ content: unwrapped });

    const t10 = await page.evaluate(() => {
      const t = window.__test;
      const brandNames = t.BRANDS.map(function (b) { return b.name; });

      // Ambient chatter no longer hardcodes the 4 old brand-specific lines.
      const staleLinesGone = ['do you have Hurley?', 'do you have Ray-Ban?', 'do you have Oakley?', 'do you have the AI glasses?']
        .every(function (l) { return t.TRIAL_AMBIENT_CHATTER.indexOf(l) === -1; });
      const cornerLineKept = t.TRIAL_AMBIENT_CHATTER.indexOf('can I see that bag in the corner?') !== -1;

      // Sample randomAmbientLine many times: brand-curiosity lines should reference real BRANDS
      // entries and vary across many different names, not a fixed handful.
      let brandLineCount = 0;
      let badBrandLine = null;
      const namesSeen = {};
      for (let i = 0; i < 4000; i++) {
        const line = t.randomAmbientLine();
        if (line.indexOf('do you have ') === 0) {
          brandLineCount++;
          const name = line.slice('do you have '.length, -1);
          if (brandNames.indexOf(name) === -1) badBrandLine = line;
          namesSeen[name] = true;
        }
      }

      // Sample pickTrialComments many times for a fake item: confirm both new comment types show
      // up with their {{token}} fully substituted (never left literal), and check the redirect
      // grading behaves as taught.
      const fakeItem = { name: 'Test Bag', brand: 'Chanel', category: 'bag', keywords: ['leather'] };
      let sawOrderProblem = false, sawOffItemInquiry = false, anyUnsubstituted = false;
      for (let i = 0; i < 200; i++) {
        t.pickTrialComments(fakeItem).forEach(function (c) {
          if (c.def.checkOrderRedirect) sawOrderProblem = true;
          if (c.text.indexOf('AUTHENTIC CHANEL') !== -1) sawOffItemInquiry = true;
          if (c.text.indexOf('{{') !== -1) anyUnsubstituted = true;
        });
      }

      const goodOrderResp = { def: { checkOrderRedirect: true }, text: 'Please send a message through your order and we will help.', wasShowing: false };
      const badOrderResp = { def: { checkOrderRedirect: true }, text: 'Oh no, let me try to sort that out for you right now.', wasShowing: false };
      const goodGrade = t.gradeTrialSession({ item: fakeItem, comments: [1], responses: [goodOrderResp] });
      const badGrade = t.gradeTrialSession({ item: fakeItem, comments: [1], responses: [badOrderResp] });

      return {
        staleLinesGone: staleLinesGone, cornerLineKept: cornerLineKept,
        brandLineRate: brandLineCount / 4000, badBrandLine: badBrandLine, distinctBrandNamesSeen: Object.keys(namesSeen).length,
        sawOrderProblem: sawOrderProblem, sawOffItemInquiry: sawOffItemInquiry, anyUnsubstituted: anyUnsubstituted,
        goodOrderScore: goodGrade.orderScore, badOrderScore: badGrade.orderScore,
      };
    });

    ok('Ambient chatter no longer hardcodes the old fixed brand lines', t10.staleLinesGone);
    ok('Ambient chatter still has the "corner" off-item line', t10.cornerLineKept);
    ok('Brand-curiosity ambient line appears at a plausible rate (5%-30% of lines)', t10.brandLineRate > 0.05 && t10.brandLineRate < 0.30);
    ok('Every brand-curiosity line names a real brand from the full BRANDS pool', !t10.badBrandLine);
    ok('Brand-curiosity line varies across many different brands (not a fixed few)', t10.distinctBrandNamesSeen > 10);
    ok('"I have a problem with my order" comment type is generated', t10.sawOrderProblem);
    ok('Off-item "can I see that bag?" comment uses a real leveluxbag.com Chanel listing title', t10.sawOffItemInquiry);
    ok('No comment text is left with an unsubstituted {{token}}', !t10.anyUnsubstituted);
    ok('Grading: redirecting to "send a message through your order" scores orderScore 1', t10.goodOrderScore === 1);
    ok('Grading: trying to resolve the order problem live in chat scores orderScore 0', t10.badOrderScore === 0);
  }

  // Real DOM check: run a couple of full Live Trial sessions (fresh reload each time, since the
  // 6-of-7 "any"-pool comments are randomized per session) and confirm the new comment types
  // actually render, fully substituted, in the live chat UI -- not just in the isolated logic
  // check above.
  let domSawOrderProblem = false, domSawOffItemInquiry = false;
  const orderProblemMarkers = ['problem with my order', 'never showed up', "wasn’t what i ordered", 'says delivered but', 'refund on my last order', "still haven’t heard back"];
  for (let attempt = 0; attempt < 3 && !(domSawOrderProblem && domSawOffItemInquiry); attempt++) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await bypassGate(page);
    await goToTrainingTab(page, 'trial');
    await page.click('#training-trial [data-platform]');
    await page.waitForTimeout(150);
    await page.click('#training-trial [data-item]');
    await page.waitForTimeout(150);
    await page.click('#trial-go-live');
    await page.waitForTimeout(3300);
    await page.click('#trial-showing-toggle');
    for (let i = 0; i < 6; i++) {
      const sendBtn = await page.$('#trial-send');
      if (!sendBtn) break;
      const seen = (await page.evaluate(() => document.body.innerText)).toLowerCase();
      if (orderProblemMarkers.some((m) => seen.includes(m))) domSawOrderProblem = true;
      if (seen.includes('authentic chanel')) domSawOffItemInquiry = true;
      await page.fill('#trial-response-input', 'This is the Chanel bag, it is $500, authentic leather, please send a message through your order if anything is ever wrong.');
      await page.click('#trial-send');
      await page.waitForTimeout(80);
    }
  }
  ok('A live-rendered session showed the order-problem comment (not just in isolated logic)', domSawOrderProblem);
  ok('A live-rendered session showed the off-item real-listing-title comment (not just in isolated logic)', domSawOffItemInquiry);

  // ---------- 11. Bag Sim closing drill shows the REAL brand/item from the session she just
  // practiced (Louis Vuitton Neverfull MM, the first bag in TRIAL_INVENTORY), not a random pick --
  // confirming findBrandInfo()/startCloseoutDrill() wire the actual session item through. ----------
  console.log('\n--- Bag Sim closing drill uses the real session item/brand, not a random one ---');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.clock.install();
  await bypassGate(page);
  await goToTrainingTab(page, 'bagsim');
  await page.click('#training-bagsim [data-platform]');
  await page.waitForTimeout(50);
  await page.click('#training-bagsim [data-item]'); // first bag item = Louis Vuitton Neverfull MM
  await page.waitForTimeout(50);
  await page.click('#bagsim-go-live');
  await page.clock.runFor(3300); // 3-2-1-GO
  // Loop until the practice-start button disappears (i.e. the last comment's "Run Next" click has
  // fired advancePracticeNext() into beginCloseout()) rather than a fixed iteration count -- the
  // exact number of start/next clicks needed depends on whether a countdown was already mid-flight
  // going in, and a fixed count silently undercounts by one and gets test assertions to pass for
  // the wrong (still-mid-session) reason. Capped well above the 6-comment session length as a
  // safety net against an infinite loop if something regresses.
  for (let i = 0; i < 12; i++) {
    const nextBtn = await page.$('#bagsim-practice-next');
    if (nextBtn && (await nextBtn.isVisible())) {
      await nextBtn.click();
      await page.waitForTimeout(50);
    }
    const startBtn = await page.$('#bagsim-practice-start');
    if (!startBtn) break; // reached the closing-drill setup screen
    await startBtn.click();
    await page.clock.runFor(30000);
  }
  await page.waitForTimeout(50);
  ok('Bag Sim reached the closing-drill setup screen (not still mid-session)', !!(await page.$('#bagsim-closeout-go-live')));
  const bagCloseoutText = await page.evaluate(() => document.body.innerText);
  ok('Bag Sim closing-drill setup screen shows the real brand (Louis Vuitton), not a random one', bagCloseoutText.includes('Louis Vuitton'));
  ok('Bag Sim closing-drill setup screen shows the real item name (Neverfull MM)', bagCloseoutText.includes('Neverfull MM'));
  await page.click('#bagsim-closeout-attention');
  await page.click('#bagsim-closeout-go-live');
  await page.waitForTimeout(50);
  const liveOverlayBrandText = await page.textContent('#auction-live-brand');
  ok('Live closing overlay names the same real brand (Louis Vuitton), not a random one', (liveOverlayBrandText || '').includes('Louis Vuitton'));
  await page.clock.runFor(21000);
  await page.waitForTimeout(50);
  ok('Bag Sim reaches the completion screen after its own closing drill', !!(await page.$('#bagsim-done')));

  // ---------- 12. "End early" clicked inside the live closing overlay returns to the closing-drill
  // setup screen (not to results, not back to platforms) -- mirroring how the old standalone
  // Auction Close tab's "End early" behaved, now via the auctionEndEarlyCallback mechanism. ----------
  console.log('\n--- "End early" during the closing drill returns to the closing-drill setup screen ---');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.clock.install();
  await bypassGate(page);
  await goToTrainingTab(page, 'sunsim');
  await page.click('#training-sunsim [data-platform]');
  await page.waitForTimeout(50);
  await page.click('#training-sunsim [data-item]');
  await page.waitForTimeout(50);
  await page.click('#sunsim-go-live');
  await page.clock.runFor(3300);
  for (let i = 0; i < 12; i++) {
    const nextBtn = await page.$('#sunsim-practice-next');
    if (nextBtn && (await nextBtn.isVisible())) {
      await nextBtn.click();
      await page.waitForTimeout(50);
    }
    const startBtn = await page.$('#sunsim-practice-start');
    if (!startBtn) break;
    await startBtn.click();
    await page.clock.runFor(30000);
  }
  await page.waitForTimeout(50);
  ok('Reached the closing-drill setup screen before triggering "End early" mid-drill', !!(await page.$('#sunsim-closeout-go-live')));
  await page.click('#sunsim-closeout-attention');
  await page.click('#sunsim-closeout-go-live');
  await page.waitForTimeout(50);
  ok('Live closing overlay is showing before "End early" is pressed', await page.isVisible('#auction-live'));
  await page.click('#auction-live-end');
  await page.waitForTimeout(50);
  ok('Overlay is dismissed after "End early"', !(await page.isVisible('#auction-live')));
  ok('"End early" returns to the closing-drill setup screen (Go Live button back), not to results', !!(await page.$('#sunsim-closeout-go-live')));
  ok('"End early" during the closing drill does NOT drop her on the completion screen', !(await page.$('#sunsim-done')));

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
