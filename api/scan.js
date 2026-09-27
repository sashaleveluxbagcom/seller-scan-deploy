/**
 * LeveLux Seller Scan — backend function (Vercel serverless).
 *
 * What it does, per scan:
 *   1. Looks up the scanned barcode/SKU in Shopify (title, asking/flash/red-zone prices).
 *   2. If a full set of sales-pitch scripts was already generated for this exact product,
 *      returns the cached versions (stored back onto the product's existing metafields)
 *      INSTANTLY -- nobody waits on Claude. It then also kicks off a fresh re-research in the
 *      background (via Vercel's waitUntil) and overwrites the cache for next time, so scripts
 *      keep themselves current without ever blocking a lookup. This is a deliberate choice:
 *      it means an item scanned repeatedly in one show re-researches repeatedly in the
 *      background too (a real, ongoing Anthropic API cost per lookup) in exchange for never
 *      staying frozen on stale first-draft research. IMPORTANT: this background refresh (and the
 *      extended-lengths generation in step 3) only fires for a real lookup -- a request carrying
 *      `pollOnly: true` (see step 3 and index.html's pollExtended) always just reads whatever is
 *      cached right now and never triggers new generation work, so the frontend's status-check
 *      polling can never pile up duplicate background jobs on top of each other.
 *   3. If nothing is cached yet (first time this exact product has ever been looked up), this
 *      is a TWO-PHASE generation so the seller never has to wait on the whole thing:
 *        Phase 1 ("core", synchronous -- this is what the seller actually waits on): a SMALL,
 *          fast Claude call (with web search) researches the title and writes pronunciation,
 *          bullet sales points, the live-condition-check walkthrough, the pairs-with suggestion,
 *          and just ONE script -- the 2-minute length, since that's the app's default view.
 *        Phase 2 ("extended", background, via waitUntil -- never blocks the response): a second,
 *          cheaper Claude call (NO web search -- it reuses the facts phase 1 already researched)
 *          writes the remaining three lengths (20 sec / 1 min / 4 min), consistent with the
 *          phase-1 script. The response includes `extendedPending: true` while this is still
 *          running, so the frontend can show "still preparing" for those lengths instead of
 *          blank content.
 *      Splitting it this way replaced a single giant synchronous call that generated all four
 *      scripts + everything else at once -- that call could take up to a minute and, if it ran
 *      out of output budget partway through, used to fall back to dumping its own raw/truncated
 *      response text onto the screen as if it were a real script. Both generation functions now
 *      throw a clean error instead of ever doing that (see callClaudeForJSON below).
 *
 * ── FIELD MAPPING (verified directly against the live Levelux Bag store on 2026-09-13) ──
 *   Asking price   → the variant's native "Price" field
 *   Flash sale price → metafield custom.preferred_price ("Flash Sale Price" — "the deal tier,
 *                      between Asking and Red Zone", populated on 812 products)
 *   Red zone price → metafield custom.flash_price. NOTE: this is a legacy field whose Shopify
 *                      Admin display NAME is "Red Zone Price" but whose underlying KEY is still
 *                      "flash_price" from before a rename — it's the one actually populated
 *                      (642 products) and is what shows on the live host dashboard today.
 *                      A newer, correctly-keyed field also exists (custom.red_zone_price,
 *                      description "Red zone floor price shown on the live host dashboard") but
 *                      is only populated on 15 products so far — this code prefers that new field
 *                      when it's set, and falls back to the legacy one otherwise, so it keeps
 *                      working through the rest of the migration.
 *                      ⚠️ Worth cleaning up in Shopify Admin → Metafields when you have time: two
 *                      definitions are both named "Red Zone Price" (Settings → Metafields and
 *                      metaobjects → Products), which is easy to mix up in any other tool you build.
 *   Pronunciation  → metafield custom.brand_pronunciation ("Phonetic brand pronunciation for hosts")
 *   Sales script   → metafield custom.sales_script -- kept in sync with the 4-minute script for
 *                      any other tool (e.g. the host dashboard) that still reads this one field.
 *   Sales points   → metafield custom.sales_points ("Bullet-point selling angles shown on the host
 *                      dashboard when scanned")
 *   Script lengths → four NEW metafields this feature added: custom.script_20s, custom.script_1min,
 *                      custom.script_2min, custom.script_4min -- one full narration per length, so
 *                      a host can pick how much airtime an item gets live.
 *   Condition check → NEW metafield custom.condition_check -- the physical walkaround guidance,
 *                      shared across all four script lengths (it's about honestly presenting the
 *                      physical item, not about pitch length).
 *   Staff commission → NOT a Shopify field -- computed on every response as 1% of the red zone
 *                      price (see STAFF_COMMISSION_RATE below), shown to the seller only, never
 *                      persisted anywhere.
 *   These all already existed (or were added for this exact purpose) in the store -- this code
 *   fills them in automatically on first scan/click rather than requiring manual setup.
 *
 *   MIGRATION NOTE: an item scanned before a given feature shipped is missing whatever new
 *   metafield that feature added. getCached() below treats an item missing any "core" field
 *   (2-min script, pronunciation, sales points, condition check, pairs-with) as needing a fresh
 *   core generation, and separately treats one missing any "extended" field (20 sec/1 min/4 min
 *   scripts) as needing a fresh background extended generation -- so each item only ever re-runs
 *   whichever half it's actually missing, not necessarily both.
 *
 * ── REQUIRED ENV VARS (set these in Vercel → Project → Settings → Environment Variables) ──
 *   SHOPIFY_STORE_DOMAIN   leveluxbag.myshopify.com (this store's real domain)
 *   SHOPIFY_ADMIN_TOKEN    Admin API access token — already generated for the existing "Levelux"
 *                          custom app in Shopify Admin (Settings → Apps → Develop apps → Levelux),
 *                          scoped to read_products, write_products, read_themes, write_themes
 *   ANTHROPIC_API_KEY      Your Anthropic API key (used server-side only, never sent to the browser)
 *   SCAN_PASSCODE          The passcode staff must enter on the scan page (checked here too, not
 *                          just in the page's UI, so the endpoint itself can't be hit without it)
 *   STOREFRONT_ORIGIN      e.g. "https://www.leveluxbag.com" — locks down CORS to your storefront
 */

const { waitUntil } = require('@vercel/functions');
const passcodeMatches = require('./_passcode.js');
const { shopifyGraphQL } = require('../lib/shopify.js');

const NS = 'custom';
const RED_ZONE_KEY_NEW = 'red_zone_price';    // correct key, only 15 products populated so far
const RED_ZONE_KEY_LEGACY = 'flash_price';    // mislabeled "Red Zone Price" in Admin UI, 642 products
const FLASH_SALE_KEY = 'preferred_price';     // labeled "Flash Sale Price" in Admin UI

// Staff commission: what the seller who moves this item personally earns, shown to them (not
// customers) right on the item view. Flat 1% of the red zone (floor) price -- Sasha's rule as of
// 2026-09-18. Rounded UP to a whole dollar (Sasha: "round it up... whole numbers") rather than
// showing cents. Change STAFF_COMMISSION_RATE here if the rate ever changes.
const STAFF_COMMISSION_RATE = 0.01;
function computeStaffCommission(redZonePrice) {
  const n = parseFloat(redZonePrice);
  return isFinite(n) ? String(Math.ceil(n * STAFF_COMMISSION_RATE)) : null;
}

const PRONUNCIATION_KEY = 'brand_pronunciation';
// Separate from PRONUNCIATION_KEY above (which is the full combined guide covering every hard
// word in the item -- brand, collection/model, materials, etc). This one holds JUST the vendor/
// brand name's own phonetic guide, so the frontend can show it right next to the brand label
// itself (Sasha, 2026-09-18: "make sure pronunciation is in the brands... as well" -- she wants
// it visible right where the brand name is, not only buried in the combined paragraph below).
const BRAND_ONLY_PRONUNCIATION_KEY = 'brand_only_pronunciation';
const SCRIPT_KEY = 'sales_script';            // legacy single-script field -- kept in sync with min4
const SALES_POINTS_KEY = 'sales_points';
const SCRIPT_20S_KEY = 'script_20s';
const SCRIPT_1MIN_KEY = 'script_1min';
const SCRIPT_2MIN_KEY = 'script_2min';
const SCRIPT_4MIN_KEY = 'script_4min';
const CONDITION_CHECK_KEY = 'condition_check';
// pairs_with now holds a short SEARCH HINT phrase (e.g. "black Taiga leather wallet"), not
// prose -- it's used to look up a real, currently-in-stock item from this store's own
// inventory (see findPairsWithProduct) rather than describing a generic item type in text.
const PAIRS_WITH_KEY = 'pairs_with';
const PAIRS_WITH_CATEGORY_KEY = 'pairs_with_category';

module.exports = async function handler(req, res) {
  // CORS: only your storefront origin may call this.
  res.setHeader('Access-Control-Allow-Origin', process.env.STOREFRONT_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const { code, productId, passcode, pollOnly } = req.body || {};

  if (!passcodeMatches(passcode)) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }

  // Two ways in: a scanned/typed barcode-or-SKU (Scan tab), or a Shopify product ID the
  // frontend already has in hand because the item came from a Search result the seller
  // clicked on. Same lookup-cache-generate flow either way from this point on.
  if ((!code || typeof code !== 'string') && (!productId || typeof productId !== 'string')) {
    res.status(400).json({ error: 'Missing scanned code' });
    return;
  }

  try {
    const product = productId
      ? await lookupProductById(productId)
      : await lookupProductByCode(code.trim());
    if (!product) {
      res.status(404).json({ error: `No product found for "${code || productId}"` });
      return;
    }

    let cached = getCached(product);

    if (!cached.core) {
      // First time this item has EVER been looked up (no core content cached yet) -- this one
      // request has to wait on real research, so it's kept as SMALL and FAST as possible: just
      // pronunciation, sales points, the condition-check walkthrough, the pairs-with suggestion,
      // and ONE script -- the 2-minute length, since that's what the app shows by default. The
      // other three lengths (20 sec / 1 min / 4 min) are generated afterward in the background
      // (see kickOffExtendedGeneration below) so they don't make the seller wait on a much
      // bigger, slower call just to see anything at all.
      const core = await generateCore(product.title, product.vendor);
      cached = {
        core: true,
        full: false,
        scripts: { sec20: '', min1: '', min2: core.script, min4: '' },
        conditionCheck: core.conditionCheck,
        pronunciation: core.pronunciation,
        brandPronunciation: core.brandPronunciation,
        salesPoints: core.salesPoints,
        pairsWith: core.pairsWith,
        pairsWithCategory: core.pairsWithCategory,
      };
      await cacheOnProduct(product.id, cached);
      kickOffExtendedGeneration(product, cached);
    } else if (!cached.full) {
      // Core is ready (fast to serve), but the 20-sec/1-min/4-min lengths never finished
      // generating (e.g. a previous visit's background job hadn't completed yet, or never got
      // kicked off). Serve what's cached instantly. Only kick off a (re)generation job for a
      // real lookup -- NOT for a `pollOnly` status check. The frontend polls this endpoint every
      // few seconds while it's waiting on the extended lengths (see pollExtended in index.html);
      // without this guard, every one of those polls used to kick off its OWN duplicate
      // background Claude call for the same item on top of whatever was already running, so a
      // single new item could fire five or more concurrent/overlapping extended-generation
      // requests in the first 20 seconds. Scanning a couple more new items while those were still
      // in flight was enough to trip Anthropic's rate limit and surface as "Something went wrong
      // looking that item up" on the 2nd/3rd item -- this is the fix for that.
      if (!pollOnly) {
        kickOffExtendedGeneration(product, cached);
      }
    } else if (!pollOnly) {
      // Everything is ready -- serve instantly, but keep it current: re-research the core facts
      // in the background on every real (non-poll) hit, and separately keep the three extended
      // lengths in sync with whatever core is cached. Neither of these blocks the response or
      // blocks each other. Skipped for pollOnly requests for the same reason as above -- a status
      // check should never itself trigger more background API work.
      waitUntil(
        generateCore(product.title, product.vendor)
          .then((freshCore) =>
            cacheOnProduct(product.id, {
              scripts: Object.assign({}, cached.scripts, { min2: freshCore.script }),
              conditionCheck: freshCore.conditionCheck,
              pronunciation: freshCore.pronunciation,
              brandPronunciation: freshCore.brandPronunciation,
              salesPoints: freshCore.salesPoints,
              pairsWith: freshCore.pairsWith,
              pairsWithCategory: freshCore.pairsWithCategory,
            })
          )
          .catch((err) => console.error('Background core refresh failed for', product.id, err))
      );
      kickOffExtendedGeneration(product, cached);
    }

    // Resolve the cached search-hint into a REAL, currently-in-stock item fresh on every
    // request (never cached -- see findPairsWithProduct above), so the suggestion always
    // reflects what's actually available right now, not what was in stock whenever the hint
    // was first generated.
    const pairsWithProduct = await findPairsWithProduct(cached.pairsWith, cached.pairsWithCategory, product.id);

    res.status(200).json({
      title: product.title,
      sku: product.sku,
      vendor: product.vendor,
      image: product.image,
      productType: product.productType,
      pronunciation: cached.pronunciation,
      brandPronunciation: cached.brandPronunciation, // just the vendor/brand name's own guide, shown next to the brand label
      askingPrice: product.askingPrice,
      flashPrice: product.flashPrice,
      redZonePrice: product.redZonePrice,
      staffCommission: computeStaffCommission(product.redZonePrice), // 1% of red zone price, staff-facing only
      salesPoints: cached.salesPoints,
      scripts: cached.scripts,       // { sec20, min1, min2, min4 } -- sec20/min1/min4 may be '' if still generating
      conditionCheck: cached.conditionCheck,
      pairsWithProduct,              // a real in-stock item {id,title,image,sku,askingPrice,flashPrice,redZonePrice}, or null
      extendedPending: !cached.full, // true => the 20s/1min/4min lengths aren't ready yet
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong looking that item up. Try scanning it again.' });
  }
};

// ---------------------------------------------------------------------------
// Shopify lookup (shopifyGraphQL now shared from ../lib/shopify.js)
// ---------------------------------------------------------------------------

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

function productNodeToRecord(p, askingPrice, sku) {
  return {
    id: p.id,
    title: p.title,
    sku: sku || null,
    vendor: p.vendor || null,
    image: p.featuredImage ? p.featuredImage.url : null,
    productType: p.productType || null,
    askingPrice,
    flashPrice: moneyValue(p.flashSale?.value),
    redZonePrice: moneyValue(p.redZoneNew?.value) ?? moneyValue(p.redZoneLegacy?.value),
    cachedPronunciation: p.pronunciation?.value || null,
    cachedBrandPronunciation: p.brandPronunciation?.value || null,
    cachedSalesPoints: p.salesPoints?.value || null,
    cachedScripts: {
      sec20: p.script20?.value || null,
      min1: p.script1?.value || null,
      min2: p.script2?.value || null,
      min4: p.script4?.value || null,
    },
    cachedConditionCheck: p.conditionCheck?.value || null,
    cachedPairsWith: p.pairsWith?.value || null,
    cachedPairsWithCategory: p.pairsWithCategory?.value || null,
  };
}

async function lookupProductByCode(code) {
  // Quoting forces an EXACT match — important for short codes like "A1620", which without
  // quotes could loosely match other SKUs that merely contain those characters.
  const safeCode = code.replace(/"/g, '');

  const query = `
    query FindVariant($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node {
            price
            sku
            product {
              id
              title
              vendor
              productType
              featuredImage { url }
              ${PRODUCT_METAFIELDS_GQL}
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { q: `sku:"${safeCode}" OR barcode:"${safeCode}"` });
  const edge = data.productVariants.edges[0];
  if (!edge) return null;

  return productNodeToRecord(edge.node.product, edge.node.price, edge.node.sku);
}

// Same shape as lookupProductByCode, but for when the frontend already knows the exact
// Shopify product ID (e.g. the seller clicked an item straight out of Search results) --
// skips the barcode/SKU search entirely and goes right to the product.
async function lookupProductById(productId) {
  const query = `
    query FindProduct($id: ID!) {
      product(id: $id) {
        id
        title
        vendor
        productType
        featuredImage { url }
        variants(first: 1) { edges { node { price sku } } }
        ${PRODUCT_METAFIELDS_GQL}
      }
    }
  `;
  const data = await shopifyGraphQL(query, { id: productId });
  const p = data.product;
  if (!p) return null;

  const variant = p.variants.edges[0] ? p.variants.edges[0].node : null;
  return productNodeToRecord(p, variant ? variant.price : null, variant ? variant.sku : null);
}

// Shopify Money-type metafields store a JSON string like {"amount":"309.00","currency_code":"USD"}
function moneyValue(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw).amount;
  } catch {
    return raw;
  }
}

// Two completeness levels, so a brand-new item only ever waits (synchronously) on the small
// "core" content -- the 2-minute script plus pronunciation/sales points/condition check/
// pairs-with. The other three lengths ("extended") are generated in the background and simply
// aren't ready yet on a fresh item; "core" being ready is enough to render the item view.
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
    return { core: false, full: false, scripts: null, conditionCheck: null, pronunciation: null, brandPronunciation: null, salesPoints: null, pairsWith: null };
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
    // pairsWith is now a short search-hint phrase (e.g. "black Taiga leather wallet"), not
    // prose -- see PAIRS_WITH_KEY comment above. pairsWithCategory is optional (the AI doesn't
    // always have a confident category), so it's never part of the core-completeness check.
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
      // Legacy field, kept in sync with the 4-minute (fullest) script for any other tool
      // that still reads this single field directly (e.g. the host dashboard).
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
// Script generation (Claude + web search) -- two phases, see the header comment.
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = 'claude-sonnet-4-5';
// Kept at the model's safe, universally-supported ceiling. The old single-call design pushed
// this to 16000 to fit four full scripts in one response -- that could silently exceed the
// account's real max_tokens limit (an outright Anthropic API error, "something went wrong looking
// that item up") or run out of room mid-response (a truncated, unparseable JSON blob). Splitting
// generation into two much smaller calls means neither one needs anywhere near this ceiling, so
// 8192 is comfortable headroom rather than a tight squeeze.
const CLAUDE_MAX_TOKENS = 8192;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One single call to Claude: requires a stop_reason that means "finished normally," and parses
// its response as JSON. Deliberately does NOT fall back to returning the raw/truncated text as
// if it were usable content -- that silent fallback is exactly how a seller used to end up
// staring at the model's own preamble and JSON syntax on screen. Any failure here throws (with
// `anthropicErrorType`/`httpStatus` attached when known) so callClaudeForJSON below can decide
// whether it's worth retrying.
async function callClaudeOnce({ prompt, useWebSearch }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // Check docs.claude.com for the current recommended model name/id before deploying --
      // this session's model list can move; pin whichever current model you're approved to use.
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
    // The model ran out of output room before it finished -- its response is cut off mid-JSON
    // and can't be trusted. Fail here rather than silently caching/serving a mangled half-blob.
    throw new Error('Claude response was cut off (hit max_tokens) before finishing');
  }

  const textBlock = [...data.content].reverse().find((b) => b.type === 'text');
  const raw = textBlock ? textBlock.text : '';

  // The prompt asks for raw JSON only, but strip a markdown code fence defensively in case the
  // model wraps its answer in one anyway (```json ... ```).
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : stripped);
  } catch (e) {
    throw new Error("Could not parse Claude's response as JSON: " + e.message);
  }
}

// Shared by generateCore and generateExtended: calls Claude, retrying transient failures --
// rate limits, momentary overload, a server error, a cut-off/malformed response -- with a short
// backoff between attempts. Fails immediately (no retry) on anything a retry can't fix, like a
// bad API key or a request Claude flatly rejects, so a real problem surfaces right away instead
// of just adding wait time. This is the fix for scans that worked the first time in a show but
// then failed on the 2nd/3rd item: back-to-back new-item scans mean several concurrent Anthropic
// calls in a short window, which is exactly when a plain rate-limit error used to have no retry
// and immediately became "Something went wrong looking that item up" on screen.
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
      const delayMs = 700 * attempt; // 700ms, then 1400ms
      console.error(`Claude call failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms:`, err.message);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

// PHASE 1 -- fast, synchronous, WITH web search. This is the only generation a seller ever
// waits on directly: pronunciation, sales points, the condition-check walkthrough, the
// pairs-with suggestion, and just the 2-minute script (the app's default view).
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

  // This is the one call a seller actually waits on -- callClaudeForJSON above retries transient
  // failures (rate limits, momentary hiccups) with backoff before giving up, so a busy show
  // scanning several new items in a row doesn't turn a temporary rate limit into a hard error.
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

// PHASE 2 -- background, no web search (reuses the facts phase 1 already researched, so it's
// both faster and cheaper than re-researching from scratch). Writes the three remaining script
// lengths, kept consistent with the already-written 2-minute script rather than inventing new facts.
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

// Kicks off phase 2 in the background (never awaited by the request handler) and caches the
// result once it lands. If it fails, nothing is lost -- the item just stays "core only" until
// the next lookup tries again (getCached's `full` check is what notices and retries).
function kickOffExtendedGeneration(product, coreCached) {
  waitUntil(
    generateExtended(product.title, {
      script: coreCached.scripts.min2,
      conditionCheck: coreCached.conditionCheck,
      salesPoints: coreCached.salesPoints,
    })
      .then((ext) =>
        cacheOnProduct(product.id, {
          scripts: { sec20: ext.sec20, min1: ext.min1, min2: coreCached.scripts.min2, min4: ext.min4 },
          conditionCheck: coreCached.conditionCheck,
          pronunciation: coreCached.pronunciation,
          brandPronunciation: coreCached.brandPronunciation,
          salesPoints: coreCached.salesPoints,
          pairsWith: coreCached.pairsWith,
          pairsWithCategory: coreCached.pairsWithCategory,
        })
      )
      .catch((err) => console.error('Background extended-script generation failed for', product.id, err))
  );
}

// ---------------------------------------------------------------------------
// "Pairs well with" -- resolves the cached search-hint phrase into a REAL, currently-in-stock
// item from this store's own inventory. Deliberately never cached: it runs fresh on every
// request (mirrors api/search.js's query-building approach) so the suggestion always reflects
// current stock, even though the hint text itself is part of the cached "core" content.
// ---------------------------------------------------------------------------
async function findPairsWithProduct(hint, category, excludeProductId) {
  if (!hint) return null;

  const clauses = ['status:active'];
  if (category) {
    clauses.push(`product_type:"${category.replace(/"/g, '')}"`);
  }
  const words = hint.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"`);
  if (words.length) clauses.push('(' + words.join(' OR ') + ')');
  const searchQuery = clauses.join(' AND ');

  const gql = `
    query PairsWithSearch($q: String!, $n: Int!) {
      products(first: $n, query: $q) {
        edges {
          node {
            id
            title
            featuredImage { url }
            totalInventory
            variants(first: 1) { edges { node { price sku } } }
            flashSale: metafield(namespace: "${NS}", key: "${FLASH_SALE_KEY}") { value }
            redZoneNew: metafield(namespace: "${NS}", key: "${RED_ZONE_KEY_NEW}") { value }
            redZoneLegacy: metafield(namespace: "${NS}", key: "${RED_ZONE_KEY_LEGACY}") { value }
          }
        }
      }
    }
  `;

  let data;
  try {
    data = await shopifyGraphQL(gql, { q: searchQuery, n: 10 });
  } catch (err) {
    // A failed lookup here should never take down the whole item view -- "pairs well with" is a
    // nice-to-have suggestion, not core content. Log it and just show nothing.
    console.error('findPairsWithProduct search failed:', err);
    return null;
  }
  const edges = (data.products && data.products.edges) || [];

  const match = edges
    .map(({ node: p }) => ({
      id: p.id,
      title: p.title,
      image: p.featuredImage ? p.featuredImage.url : null,
      sku: p.variants && p.variants.edges[0] ? p.variants.edges[0].node.sku : null,
      inStock: (p.totalInventory || 0) > 0,
      askingPrice: p.variants && p.variants.edges[0] ? p.variants.edges[0].node.price : null,
      flashPrice: moneyValue(p.flashSale && p.flashSale.value),
      redZonePrice:
        moneyValue(p.redZoneNew && p.redZoneNew.value) ?? moneyValue(p.redZoneLegacy && p.redZoneLegacy.value),
    }))
    .find((item) => item.id !== excludeProductId && item.inStock);

  return match || null;
}
