/**
 * LeveLux Seller Scan — backfill (Vercel Cron).
 *
 * Runs on a schedule (see vercel.json's `crons`) and makes sure every active product in the
 * store has its Seller Scan content (pronunciation, sales points, condition check, pairs-with,
 * and all four script lengths) generated and cached on its metafields -- the same cache
 * scan.js reads from -- WITHOUT waiting for a live seller to actually scan the item first.
 *
 * This exists because scan.js only ever generates content the moment someone scans/looks up an
 * item (or when levelux-photo-intake's create-product.js fires a one-time lookup right after a
 * new product is created). If that one-time trigger is ever missed (e.g. SCAN_PASSCODE wasn't
 * set yet when the item was created) or an item was created before either of those existed,
 * nothing ever backfills it on its own -- a host has to be the one to discover the gap live,
 * mid-show. This endpoint instead sweeps the whole catalog on a timer and closes any gaps itself.
 *
 * Each run:
 * 1. Pages through every ACTIVE product (cheap, no AI involved) and checks the same cache
 *    completeness scan.js uses (getCached below -- kept in sync with scan.js's own copy).
 * 2. For products missing "core" content entirely, runs the same phase-1 generation scan.js
 *    uses (pronunciation, sales points, condition check, pairs-with, 2-minute script), capped
 *    at CORE_BATCH_LIMIT per run since each one is a slower web-search Claude call.
 * 3. For products that have core but are missing the three "extended" lengths (20s/1min/4min),
 *    runs phase-2 generation, capped at EXTENDED_BATCH_LIMIT per run (faster, no web search).
 * 4. Returns a JSON summary of what it found and did. Nothing is ever lost between runs --
 *    metafields ARE the durable state, so a run that hits its batch cap just leaves the rest
 *    for the next scheduled run, and a fully caught-up catalog makes every future run a fast,
 *    cheap no-op scan.
 *
 * This intentionally duplicates scan.js's generation logic rather than importing it, so a
 * change here can never accidentally affect the live, staff-facing scan endpoint sellers
 * depend on mid-show -- if you change the prompts/cache shape in scan.js, mirror the change
 * here too.
 *
 * AUTH: only runs for requests carrying Vercel's own Cron secret (see CRON_SECRET below) --
 * this endpoint does real paid Anthropic API calls, so it can't be left open to the public
 * internet. Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on every Cron
 * Job invocation once that env var is set (Settings -> Environment Variables -> CRON_SECRET);
 * set it to any random string.
 *
 * ── REQUIRED ENV VARS (same as scan.js, plus one) ──
 * SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, ANTHROPIC_API_KEY -- shared with scan.js
 * CRON_SECRET -- any random string; must match what Vercel sends as the Cron auth header
 */

const SHOPIFY_API_VERSION = '2024-10';
const NS = 'custom';
const RED_ZONE_KEY_NEW = 'red_zone_price';
const RED_ZONE_KEY_LEGACY = 'flash_price';
const FLASH_SALE_KEY = 'preferred_price';
const PRONUNCIATION_KEY = 'brand_pronunciation';
const BRAND_ONLY_PRONUNCIATION_KEY = 'brand_only_pronunciation';
const SCRIPT_KEY = 'sales_script';
const SALES_POINTS_KEY = 'sales_points';
const SCRIPT_20S_KEY = 'script_20s';
const SCRIPT_1MIN_KEY = 'script_1min';
const SCRIPT_2MIN_KEY = 'script_2min';
const SCRIPT_4MIN_KEY = 'script_4min';
const CONDITION_CHECK_KEY = 'condition_check';
const PAIRS_WITH_KEY = 'pairs_with';
const PAIRS_WITH_CATEGORY_KEY = 'pairs_with_category';

// How many items to actually generate content for in one run -- keeps each invocation safely
// inside maxDuration even when the catalog has a big backlog. Core items are slower (they use
// web search) and each one also tries its extended lengths right after, so a smaller cap;
// extended-only items (core already done, just filling in the three shorter/longer scripts)
// are cheaper so more of them fit in one run.
const CORE_BATCH_LIMIT = 6;
const EXTENDED_BATCH_LIMIT = 12;

module.exports = async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }

  const summary = {
    scanned: 0,
    missingCore: 0,
    missingExtendedOnly: 0,
    coreGenerated: 0,
    extendedGenerated: 0,
    errors: [],
  };

  try {
    const needsCore = [];
    const needsExtendedOnly = [];

    let cursor = null;
    do {
      const page = await fetchProductPage(cursor);
      for (const p of page.products) {
        summary.scanned++;
        const cached = getCached(p);
        if (!cached.core) {
          summary.missingCore++;
          needsCore.push(p);
        } else if (!cached.full) {
          summary.missingExtendedOnly++;
          needsExtendedOnly.push({ product: p, cached });
        }
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    for (const p of needsCore.slice(0, CORE_BATCH_LIMIT)) {
      try {
        const core = await generateCore(p.title, p.vendor);
        const cachedNow = {
          scripts: { sec20: '', min1: '', min2: core.script, min4: '' },
          conditionCheck: core.conditionCheck,
          pronunciation: core.pronunciation,
          brandPronunciation: core.brandPronunciation,
          salesPoints: core.salesPoints,
          pairsWith: core.pairsWith,
          pairsWithCategory: core.pairsWithCategory,
        };
        await cacheOnProduct(p.id, cachedNow);
        summary.coreGenerated++;

        // Also do this item's extended lengths right away, while we're here, rather than
        // waiting for a future run to notice it's core-only -- still bounded by the same
        // overall extended cap so one run can't run long just from newly-cored items.
        if (summary.extendedGenerated < EXTENDED_BATCH_LIMIT) {
          const ext = await generateExtended(p.title, {
            script: core.script,
            conditionCheck: core.conditionCheck,
            salesPoints: core.salesPoints,
          });
          await cacheOnProduct(p.id, {
            scripts: { sec20: ext.sec20, min1: ext.min1, min2: core.script, min4: ext.min4 },
            conditionCheck: core.conditionCheck,
            pronunciation: core.pronunciation,
            brandPronunciation: core.brandPronunciation,
            salesPoints: core.salesPoints,
            pairsWith: core.pairsWith,
            pairsWithCategory: core.pairsWithCategory,
          });
          summary.extendedGenerated++;
        }
      } catch (err) {
        console.error('Backfill core generation failed for', p.id, err);
        summary.errors.push({ productId: p.id, title: p.title, stage: 'core', message: err.message });
      }
    }

    const remainingExtendedSlots = EXTENDED_BATCH_LIMIT - summary.extendedGenerated;
    for (const { product: p, cached } of needsExtendedOnly.slice(0, Math.max(0, remainingExtendedSlots))) {
      try {
        const ext = await generateExtended(p.title, {
          script: cached.scripts.min2,
          conditionCheck: cached.conditionCheck,
          salesPoints: cached.salesPoints,
        });
        await cacheOnProduct(p.id, {
          scripts: { sec20: ext.sec20, min1: ext.min1, min2: cached.scripts.min2, min4: ext.min4 },
          conditionCheck: cached.conditionCheck,
          pronunciation: cached.pronunciation,
          brandPronunciation: cached.brandPronunciation,
          salesPoints: cached.salesPoints,
          pairsWith: cached.pairsWith,
          pairsWithCategory: cached.pairsWithCategory,
        });
        summary.extendedGenerated++;
      } catch (err) {
        console.error('Backfill extended generation failed for', p.id, err);
        summary.errors.push({ productId: p.id, title: p.title, stage: 'extended', message: err.message });
      }
    }

    res.status(200).json(summary);
  } catch (err) {
    console.error('Backfill run failed:', err);
    res.status(500).json(Object.assign({ error: err.message }, summary));
  }
};

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

async function shopifyGraphQL(query, variables) {
  const resp = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await resp.json();
  if (json.errors) {
    throw new Error('Shopify API error: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

const PRODUCT_METAFIELDS_GQL = `
  redZoneNew: metafield(namespace: "${NS}", key: "${RED_ZONE_KEY_NEW}") { value }
  redZoneLegacy: metafield(namespace: "${NS}", key: "${RED_ZONE_KEY_LEGACY}") { value }
  flashSale: metafield(namespace: "${NS}", key: "${FLASH_SALE_KEY}") { value }
  pronunciation: metafield(namespace: "${NS}", key: "${PRONUNCIATION_KEY}") { value }
  brandPronunciation: metafield(namespace: "${NS}", key: "${BRAND_ONLY_PRONUNCIATION_KEY}") { value }
  salesPoints: metafield(namespace: "${NS}", key: "${SALES_POINTS_KEY}") { value }
  script20: metafield(namespace: "${NS}", key: "${SCRIPT_20S_KEY}") { value }
  script1: metafield(namespace: "${NS}", key: "${SCRIPT_1MIN_KEY}") { value }
  script2: metafield(namespace: "${NS}", key: "${SCRIPT_2MIN_KEY}") { value }
  script4: metafield(namespace: "${NS}", key: "${SCRIPT_4MIN_KEY}") { value }
  conditionCheck: metafield(namespace: "${NS}", key: "${CONDITION_CHECK_KEY}") { value }
  pairsWith: metafield(namespace: "${NS}", key: "${PAIRS_WITH_KEY}") { value }
  pairsWithCategory: metafield(namespace: "${NS}", key: "${PAIRS_WITH_CATEGORY_KEY}") { value }
`;

async function fetchProductPage(cursor) {
  const query = `
    query BackfillProducts($cursor: String) {
      products(first: 100, after: $cursor, query: "status:active") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            vendor
            ${PRODUCT_METAFIELDS_GQL}
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { cursor });
  return {
    products: data.products.edges.map(({ node: p }) => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor || null,
      cachedScripts: {
        sec20: p.script20?.value || null,
        min1: p.script1?.value || null,
        min2: p.script2?.value || null,
        min4: p.script4?.value || null,
      },
      cachedConditionCheck: p.conditionCheck?.value || null,
      cachedPronunciation: p.pronunciation?.value || null,
      cachedBrandPronunciation: p.brandPronunciation?.value || null,
      cachedSalesPoints: p.salesPoints?.value || null,
      cachedPairsWith: p.pairsWith?.value || null,
      cachedPairsWithCategory: p.pairsWithCategory?.value || null,
    })),
    pageInfo: data.products.pageInfo,
  };
}

// Kept in sync with scan.js's own getCached -- if you change completeness rules there, mirror
// the change here too, or this backfill will disagree with scan.js about what's "done."
function getCached(product) {
  const s = product.cachedScripts || {};
  const core = !!(
    s.min2 &&
    product.cachedConditionCheck &&
    product.cachedPronunciation &&
    product.cachedSalesPoints &&
    product.cachedPairsWith
  );
  if (!core) {
    return {
      core: false,
      full: false,
      scripts: null,
      conditionCheck: null,
      pronunciation: null,
      brandPronunciation: null,
      salesPoints: null,
      pairsWith: null,
    };
  }
  const full = !!(s.sec20 && s.min1 && s.min4);
  return {
    core: true,
    full,
    scripts: s,
    conditionCheck: product.cachedConditionCheck,
    pronunciation: product.cachedPronunciation,
    brandPronunciation: product.cachedBrandPronunciation,
    salesPoints: product.cachedSalesPoints,
    pairsWith: product.cachedPairsWith,
    pairsWithCategory: product.cachedPairsWithCategory || null,
  };
}

async function cacheOnProduct(productId, { scripts, conditionCheck, pronunciation, brandPronunciation, salesPoints, pairsWith, pairsWithCategory }) {
  const mutation = `
    mutation SetMeta($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    metafields: [
      { ownerId: productId, namespace: NS, key: SCRIPT_KEY, type: 'multi_line_text_field', value: scripts.min4 },
      { ownerId: productId, namespace: NS, key: SCRIPT_20S_KEY, type: 'multi_line_text_field', value: scripts.sec20 },
      { ownerId: productId, namespace: NS, key: SCRIPT_1MIN_KEY, type: 'multi_line_text_field', value: scripts.min1 },
      { ownerId: productId, namespace: NS, key: SCRIPT_2MIN_KEY, type: 'multi_line_text_field', value: scripts.min2 },
      { ownerId: productId, namespace: NS, key: SCRIPT_4MIN_KEY, type: 'multi_line_text_field', value: scripts.min4 },
      { ownerId: productId, namespace: NS, key: CONDITION_CHECK_KEY, type: 'multi_line_text_field', value: conditionCheck || '' },
      { ownerId: productId, namespace: NS, key: PRONUNCIATION_KEY, type: 'single_line_text_field', value: pronunciation || '' },
      { ownerId: productId, namespace: NS, key: BRAND_ONLY_PRONUNCIATION_KEY, type: 'single_line_text_field', value: brandPronunciation || '' },
      { ownerId: productId, namespace: NS, key: SALES_POINTS_KEY, type: 'multi_line_text_field', value: salesPoints || '' },
      { ownerId: productId, namespace: NS, key: PAIRS_WITH_KEY, type: 'multi_line_text_field', value: pairsWith || '' },
      { ownerId: productId, namespace: NS, key: PAIRS_WITH_CATEGORY_KEY, type: 'single_line_text_field', value: pairsWithCategory || '' },
    ],
  });
}

// ---------------------------------------------------------------------------
// Claude generation -- identical prompts/logic to scan.js's phase 1 & 2, duplicated here on
// purpose (see the header comment): this file must never be able to break the live scan
// endpoint, and vice versa.
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = 'claude-sonnet-4-5';
const CLAUDE_MAX_TOKENS = 8192;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callClaudeOnce({ prompt, useWebSearch }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      tools: useWebSearch ? [{ type: 'web_search_20250305', name: 'web_search' }] : undefined,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await resp.json();
  if (data.error) {
    const err = new Error('Anthropic API error: ' + JSON.stringify(data.error));
    err.anthropicErrorType = data.error && data.error.type;
    err.httpStatus = resp.status;
    throw err;
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Claude response was cut off (hit max_tokens) before finishing');
  }

  const textBlock = [...data.content].reverse().find((b) => b.type === 'text');
  const raw = textBlock ? textBlock.text : '';

  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : stripped);
  } catch (e) {
    throw new Error("Could not parse Claude's response as JSON: " + e.message);
  }
}

async function callClaudeForJSON({ prompt, useWebSearch }, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callClaudeOnce({ prompt, useWebSearch });
    } catch (err) {
      lastErr = err;
      const retryable =
        err.anthropicErrorType === 'rate_limit_error' ||
        err.anthropicErrorType === 'overloaded_error' ||
        err.anthropicErrorType === 'api_error' ||
        (err.httpStatus && err.httpStatus >= 500) ||
        /cut off|could not parse/i.test(err.message || '');
      if (!retryable || attempt === maxAttempts) throw err;
      const delayMs = 700 * attempt;
      console.error(`Claude call failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms:`, err.message);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

// PHASE 1 -- identical to scan.js's generateCore.
async function generateCore(title, vendor) {
  const prompt = `You are the top-performing live host at LeveLux, a luxury resale business, about to go
on air (Whatnot/TikTok Shop style) with this exact item. You're writing your own script — the one
you'll read almost word-for-word to sell it — and it needs to be AS DETAILED, AS ACCURATE, and AS
CONFIDENT as the best live-sale narrations in the industry: the kind where the host clearly knows
the brand cold, name-drops specifics, and never sounds like they're reading a product description.

Item title: "${title}"
${vendor ? `Brand (Shopify vendor field, use this exact spelling as the source of truth for the brand name): "${vendor}"` : ''}

WRITE FOR EASY LISTENING, ROUGHLY A 5TH-GRADE READING LEVEL: short sentences, one idea at a time,
everyday words instead of fancy ones. This gets read out loud to a live audience, not studied on a
page, so plain and clear beats impressive-sounding. Keep every real fact, number, and confident
detail this prompt asks for -- just say it simply. If a technical or brand-specific word is truly
needed (a material, a hardware term), keep it, but say it in a short, plain way right there rather
than assuming the audience already knows it.

Research this specific brand/model/material/hardware combination using web search — brand history,
this model's release era and collection name, original retail price, typical resold range on the
secondary market (StockX, Fashionphile, The RealReal, eBay sold listings, etc. — cite real numbers,
not vague ranges like "several hundred dollars"), material and hardware specifics, what makes this
model desirable or hard to get. Then produce ALL of the following, using the SAME researched facts
and comps throughout so nothing contradicts across pieces.

VERIFY BEFORE YOU WRITE — every factual claim below must be something your web search actually
turned up, not something that sounds plausible for a brand like this. This applies to release
years/eras, collection or collaboration names, retail prices, resale comps, materials, hardware
names, and any "first released in..." / "designed by..." / "part of the ___ collection" style
claim. If your search does not turn up a specific fact, do not invent one or state a
plausible-sounding guess as if it were confirmed — either omit that detail entirely, or phrase it
in a way that doesn't assert a specific unconfirmed fact (e.g. "part of [Brand]'s classic monogram
line" rather than naming a year you're not sure of). Resale price comps must come from real
listings/sold prices you actually found — if you can't find real comps, say the item is "in the
range typical for [Brand]'s [category]" rather than inventing a specific number. It's far better
for a script to have one fewer flashy detail than to state something false on a live broadcast a
customer could later check.

1. PRONUNCIATION: cover EVERY hard-to-say word the host will actually need to say out loud for
this item -- not just the product title. Go through (a) every distinct brand, collection/
pattern, model, mythological/historical, and material name in the title "${title}" word by
word, AND (b) any other hard word you plan to use anywhere in the sales points, script, or
condition check you write below -- material names (e.g. "vachetta"), hardware/technique terms,
or any French/Italian/Greek/foreign or easily-fumbled word, even if it never appears in the
title itself. This includes collection/model names borrowed from mythology or history that
read like ordinary words but aren't (e.g. Gucci's "Dionysus", "Sylvie", "Ophidia") -- these are
exactly the names hosts stumble on and customers notice.

FORMAT every phonetic guide the SAME simple way, so it's instantly readable out loud, mid-show,
by someone who has never seen the word before: hyphens between syllables, the STRESSED syllable
in ALL CAPS, plain everyday English letter-sounds only -- no IPA symbols, no diacritical marks,
no linguistics notation.

KEEP EVERY SYLLABLE CHUNK SHORT AND EASY TO BLEND -- a host reading this cold, out loud, mid-show,
should never have to fuse together an unfamiliar cluster of sounds. Avoid chunks that blend a
consonant into a "w" sound or stack two consonants together (like "vwee" or "dzh") -- split them
into smaller, more familiar pieces instead, or swap in the closest simple English sound real hosts
and buyers actually use (the "Vui" in "Vuitton" is commonly said as "vee" or "voo-ee", not "vwee").
After any syllable that's still genuinely tricky, add a short "(rhymes with ___)" tag naming ONE
everyday word or name so common a child would know it (day, blur, prawn, cat, key, bus) -- never
another hard-to-say word as the rhyme.

Example: brand ("Louis Vuitton" -> "loo-EE vee-TAWN" (second word rhymes with "prawn")), pattern/
collection names ("Damier" -> "DAH-mee-ay" (rhymes with "day"), "Azur" -> "ah-ZHUR" (rhymes with
"blur"), "Monogram" is often mispronounced too), materials ("vachetta" -> "vah-KEH-tuh"),
mythological/historical names ("Dionysus" -> "dy-oh-NYE-suss" (rhymes with "bus")).

USE THE PRONUNCIATION REAL ENGLISH-SPEAKING HOSTS AND CUSTOMERS ACTUALLY USE, not a
hyper-literal rendering of the word's original language -- a name like "Dionysus" should get
its standard English dictionary pronunciation ("dy-oh-NYE-suss"), not a classical-Greek one
nobody selling or buying on Whatnot would recognize. When you're not sure, prefer the
pronunciation you actually find used in real fashion/retail sources over a textbook one.

Never skip a word just because it looks simple to read if people commonly get it wrong. Plain
everyday English words, model initials (MM, PM, GM), and plain sizes don't need one. Get every
pronunciation from your actual web research or standard phonetics, not a guess. Only if truly
nothing in the whole item needs one, say "None needed."

BRAND NAME, SEPARATELY: in addition to the combined pronunciation guide above, also produce a
standalone "brandPronunciation" for JUST the brand name itself${vendor ? ` (the vendor field
given above: "${vendor}")` : ' (the brand named in the title)'}, using the exact same hyphen/
ALL-CAPS-stress format. This is shown to the host right next to the brand name on screen, so it
must work completely on its own without the rest of the guide for context. If the brand name is
already plain, ordinary English that no one mispronounces (e.g. "Coach"), it's fine to return
"" for this field -- don't force a guide where none is needed. This is separate from, and in
addition to, the brand's entry in the combined "pronunciation" checklist above -- fill in both.

2. SALES POINTS: 5-7 short, punchy bullet-point selling angles (one line each) a host can glance
at mid-broadcast without breaking eye contact with the camera for long. The FIRST time any hard
word from your section 1 checklist (brand, collection/model, mythological/historical, or
material name) appears in these bullets, put its phonetic guide inline right after it in
parentheses, same hyphen/ALL-CAPS-stress format (e.g. "This Dionysus (dy-oh-NYE-suss) bag...").
After that first mention within the bullets, later mentions don't need to repeat it. Ordinary
words never need this treatment -- only the specific hard words already flagged in section 1.

3. THE 2-MINUTE SCRIPT (~280-340 words, about 2 minutes spoken at ~150 words/minute — a target,
not a hard limit): a COMPLETE, standalone narration in first person, natural spoken cadence
(short punchy sentences mixed with longer ones, rhetorical questions to viewers, asides like
"and if you know, you know—"). Cover: hook, brand and model story, material and hardware
detail, real retail-and-resale comps, one concrete styling occasion, the investment/scarcity
angle, and a call-to-action. IMPORTANT for vachetta leather trim specifically (common on Louis
Vuitton canvas pieces): never reuse the same stock phrase every time — vary both how you
describe the material (e.g. "vachetta leather," "natural cowhide trim," "untreated vachetta")
and its patina color (pale honey, golden wheat, warm caramel, toffee, amber, cognac, deep
chestnut, rich tobacco-brown), always framed as desirable, never as a flaw.

4. LIVE CONDITION CHECK — one shared walkthrough, independent of script length (a host reads this
once regardless of pitch length). Title it exactly "LIVE CONDITION CHECK — walk the item on
camera in this order" followed by a prompt list, in the second person, for the staff member to
narrate live from the physical piece (never pre-filled by you, since you haven't seen it):
1. FRONT — first impression, main material and any front hardware/logo
2. BACK — the back panel/exterior, any back pocket, and any PIPING along seams if present
3. SIDES — both side panels, gussets, or edges
4. CORNERS — all four base corners specifically, since that's where resale wear shows first
5. HANDLES/STRAPS — material and stitching condition, handle drop/wear, and the GLAZING (resin
edge coating) — smooth, hairline cracking, or peeling/flaking
6. HARDWARE — zippers, clasps, feet, chain/strap hardware: finish, tarnish, function
7. LEATHER TRIM / VACHETTA COLOR — current patina color as its own step
8. INTERIOR — lining condition, any smell, inside pocket(s)
9. AUTHENTICITY MARKERS — hologram/serial/date code, authenticity card, dust bag/box presence
10. SIGNS OF WEAR — disclose honestly, in specific but gentle, non-alarming language, mentioned
once, briefly, in passing.

Do not invent or imply any specific condition claim — every line here is an instruction for
the human, never narration about the actual physical condition.

TEACH, DON'T ANCHOR: for any judgment call above (patina color, hardware tone, wear degree,
glazing condition, piping condition), give a short menu of 4-6 concrete, genuinely different
options to choose from based on what they actually see, rather than one anchored example or a
bare open-ended question (e.g. for patina: "pale honey, golden wheat, warm caramel, deep amber,
rich chestnut — whichever this piece actually shows").

5. PAIRS WELL WITH: this store will use your answer to search its OWN live inventory for a real
item to suggest — so DO NOT write prose or a sentence. Instead give a short SEARCH HINT of
2-6 words describing the TYPE of complementary item, in terms of item type, material, and
hardware tone/color family only ("black Taiga leather wallet", "gold-hardware crossbody strap",
"tortoiseshell aviator sunglasses") — never a specific product name, model, or SKU, since you
have not seen this store's actual inventory. Also give your best-guess CATEGORY for that
complementary item, chosen ONLY from this exact list (pick whichever is closest, or "" if none
fit): "Pre owned", "Sunglasses", "Eyeglasses", "Jewelry", "Accessory", "Hat", "Briefcase".

Return ONLY a raw JSON object and nothing else — no prose before or after it, no markdown code
fences, no explanation of what you're about to do. Just the JSON, exactly in this shape:
{
"pronunciation": "...",
"brandPronunciation": "...",
"salesPoints": "...",
"script": "...",
"conditionCheck": "...",
"pairsWithHint": "...",
"pairsWithCategory": "..."
}
(salesPoints as a single string with one bullet per line, each starting with "- ". script is the
2-minute narration alone, with no condition-check text inside it. conditionCheck holds only the
LIVE CONDITION CHECK section. brandPronunciation holds ONLY the brand name's own phonetic guide (or
"" if none needed) -- it is separate from the combined "pronunciation" field, which still covers
every hard word in the whole item. pairsWithHint holds only the short search-hint phrase, never a
full sentence. pairsWithCategory holds only one value from the exact list above, or "".)`;

  const parsed = await callClaudeForJSON({ prompt, useWebSearch: true });
  return {
    pronunciation: parsed.pronunciation || '',
    brandPronunciation: parsed.brandPronunciation || '',
    salesPoints: parsed.salesPoints || '',
    script: parsed.script || '',
    conditionCheck: parsed.conditionCheck || '',
    pairsWith: parsed.pairsWithHint || '',
    pairsWithCategory: parsed.pairsWithCategory || '',
  };
}

// PHASE 2 -- identical to scan.js's generateExtended.
async function generateExtended(title, core) {
  const prompt = `You already wrote the following for this exact live-sale item during an earlier
research pass. Do not contradict it, and do not introduce any NEW specific fact (a year, a price,
a name) beyond what's already implied here -- these three scripts must read as if they came from
the same research as the one below.

Item title: "${title}"

ALREADY WRITTEN (for consistency only -- do not repeat it back):
2-MINUTE SCRIPT: ${core.script}
CONDITION CHECK: ${core.conditionCheck}
SALES POINTS: ${core.salesPoints}

Keep the SAME easy-listening, roughly 5th-grade reading level as the script above: short sentences,
everyday words, one idea at a time -- just as detailed and confident, just simpler to say and hear.

Write three MORE complete, standalone scripts for the same item, in first person, natural spoken
cadence, so a host can pick how much airtime this item gets live:

- SCRIPT_20S (~45-65 words, ~20 seconds spoken): one tight hook — the item, its single most
eye-catching fact (already established above), and a fast call-to-action.
- SCRIPT_1MIN (~130-160 words, ~1 minute spoken): a hook, one line of brand/model story, 2-3 of
the sharpest selling points above, one real price comp, and a call-to-action.
- SCRIPT_4MIN (~550-700 words, ~4 minutes spoken) — the fullest, most thorough version, as
detailed and confident as the best live-sale narrations in the industry. Weave in, in a natural
order: a hook-y opening line; the brand's story and this model's place in it; when/how it was
released or its era, if established above; rich material and hardware detail in tactile,
sensory language (vary vachetta/leather and patina-color phrasing the same way the 2-minute
script does, never reusing one stock phrase); the real retail/resale numbers already
established; sizing, how it's worn, and 2-3 styling occasions; the investment/scarcity angle;
and a strong, specific closing call-to-action.

Each script is a COMPLETE standalone narration at that length — not a trimmed copy of another one
or a summary of it — but all three (and the 2-minute script above) must stay internally consistent.

Return ONLY a raw JSON object and nothing else — no prose before or after it, no markdown code
fences:
{ "sec20": "...", "min1": "...", "min4": "..." }`;

  const parsed = await callClaudeForJSON({ prompt, useWebSearch: false });
  return {
    sec20: parsed.sec20 || '',
    min1: parsed.min1 || '',
    min4: parsed.min4 || '',
  };
}
