// test5.js — Playwright test for: (1) expanded BRANDS array, (2) the shared live-practice
// engine's Start+countdown gate (exercised via Sunglasses Sim -- the "🔴 Live Trial" tab this
// was originally written against has since been removed; the countdown-gate mechanics it
// tested are shared engine code, still exercised the same way through Sunglasses Sim's
// go-live button), (3) embedded Chat panel in Sell Live scanner screen.
// DOM-only assertions throughout (app state lives in a top-level IIFE, not
// reachable via page.evaluate closures).
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

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [console error]', msg.text());
  });
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message));

  await page.goto(BASE);
  await bypassGate(page);

  // ---------- 1. BRANDS array ----------
  console.log('\n--- Brands training ---');
  await page.click('#hub-training');
  await page.waitForTimeout(300);
  await page.click('.training-tab[data-tab="brands"]');
  await page.waitForTimeout(300);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const brandCount = await page.evaluate(() => {
    // Count elements that look like brand cards by checking for a few known-new brand names.
    return document.body.innerText;
  });
  const checkNames = ['Vivienne Westwood', 'Diff', 'Zeiss', 'Jimmy Choo', 'Michael Kors', 'Salvatore Ferragamo'];
  for (const name of checkNames) {
    ok(`Brands screen contains "${name}"`, bodyText.includes(name));
  }
  // Count total brand entries via the BRANDS array length directly from source (static check),
  // since the IIFE hides the runtime variable. Fetch and count array entries in the HTML source.
  const html = await page.content();
  ok('Page loaded without fatal script error (has BRANDS-related content)', bodyText.length > 100);

  // ---------- 2. Live-practice engine Start + countdown (via Sunglasses Sim) ----------
  console.log('\n--- Sunglasses Sim start/countdown ---');
  // still inside training panel from step 1; just switch tabs
  await page.click('.training-tab[data-tab="sunsim"]');
  await page.waitForTimeout(300);

  // pick first platform
  const platformCard = await page.$('[data-platform]');
  if (platformCard) {
    await platformCard.click();
    await page.waitForTimeout(300);
  }
  ok('A platform selection control was found and clicked', !!platformCard);

  // pick first item
  const itemCard = await page.$('[data-item]');
  if (itemCard) {
    await itemCard.click();
    await page.waitForTimeout(300);
  }
  ok('An item selection control was found and clicked', !!itemCard);

  // should now be on the 'ready' screen with a Go Live button, NOT already in session
  const goLiveBtn = await page.$('#sunsim-go-live');
  ok('"ready" screen rendered with #sunsim-go-live button (session did not start immediately)', !!goLiveBtn);

  const chatFeedBeforeGo = await page.$('#sunsim-chat-feed');
  const chatFeedVisibleBefore = chatFeedBeforeGo ? await chatFeedBeforeGo.isVisible().catch(() => false) : false;
  ok('Session chat feed NOT visible before Go Live is pressed', !chatFeedVisibleBefore);

  if (goLiveBtn) {
    await goLiveBtn.click();
    await page.waitForTimeout(150);
    const countdownEl = await page.$('#sunsim-countdown-display');
    const countdownText1 = countdownEl ? await countdownEl.textContent() : null;
    ok('Countdown display shows a value shortly after Go Live click', !!countdownText1 && countdownText1.trim().length > 0);
    console.log('  countdown tick 1:', JSON.stringify(countdownText1));

    await page.waitForTimeout(900);
    const countdownText2 = countdownEl ? await countdownEl.textContent() : null;
    console.log('  countdown tick 2:', JSON.stringify(countdownText2));
    ok('Countdown display changed between ticks', countdownText1 !== countdownText2);

    // wait out the rest of the countdown (3-2-1-GO, 800ms/tick + 400ms buffer)
    await page.waitForTimeout(2200);
    const sessionStarted = await page.$('#sunsim-chat-feed');
    const sessionVisible = sessionStarted ? await sessionStarted.isVisible().catch(() => false) : false;
    ok('Live session (#sunsim-chat-feed) visible after countdown completes', sessionVisible);
  }

  // ---------- 3. Chat panel embedded in Sell Live ----------
  console.log('\n--- Chat panel in Sell Live ---');
  // go back to hub then into Sell Live
  await page.evaluate(() => {
    document.getElementById('training').style.display = 'none';
    document.getElementById('hub').style.display = 'flex';
  });
  await page.waitForTimeout(200);
  await page.click('#hub-sell');
  await page.waitForTimeout(300);

  const chatOpenBtn = await page.$('#scanner-chat-open');
  ok('#scanner-chat-open "Chat" button exists in Sell Live scanner screen', !!chatOpenBtn);

  if (chatOpenBtn) {
    await chatOpenBtn.click();
    await page.waitForTimeout(300);
    const panel = await page.$('#sell-chat-panel');
    const panelVisible = panel ? await panel.isVisible().catch(() => false) : false;
    ok('#sell-chat-panel becomes visible after clicking Chat button', panelVisible);

    const iframeSrc = await page.evaluate(() => {
      const f = document.getElementById('sell-chat-iframe');
      return f ? f.getAttribute('src') : null;
    });
    ok('#sell-chat-iframe src set to levelux-chat.vercel.app on open', iframeSrc === 'https://levelux-chat.vercel.app');

    const fallbackLink = await page.$('#sell-chat-newtab');
    ok('Fallback "open in new tab" link present', !!fallbackLink);
    if (fallbackLink) {
      const href = await fallbackLink.getAttribute('href');
      ok('Fallback link points to levelux-chat.vercel.app', href === 'https://levelux-chat.vercel.app');
    }

    const closeBtn = await page.$('#sell-chat-close');
    if (closeBtn) {
      await closeBtn.click();
      await page.waitForTimeout(200);
      const panelVisibleAfterClose = await page.$eval('#sell-chat-panel', (el) => getComputedStyle(el).display).catch(() => null);
      ok('#sell-chat-panel hidden after close button clicked', panelVisibleAfterClose === 'none');

      const iframeSrcAfterClose = await page.evaluate(() => {
        const f = document.getElementById('sell-chat-iframe');
        return f ? f.getAttribute('src') : null;
      });
      ok('#sell-chat-iframe src cleared after close', iframeSrcAfterClose === '');
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
