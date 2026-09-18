/**
 * LeveLux Seller Scan — seller attribution log endpoint (Vercel serverless).
 *
 * Records which staff member pulled up which item, so the CEO Dashboard can show "who sold
 * what, where, and how much they'll earn" per seller (Sasha, 2026-09-18). Attribution is
 * captured on every item scanned or pulled up -- not just once per show -- so two people
 * trading off mid-show each get credit for their own items. The frontend fires this
 * fire-and-forget right after a successful scan/lookup; see logSellerActivity() in index.html.
 *
 * This is a LIVE ESTIMATE, same as the commission banner already shown to staff in the tool
 * itself: every item a seller pulls up counts, whether or not it actually sells. It is NOT
 * matched against real Whatnot/eBay/TikTok sales the way api/profit.js matches show-log.js
 * items against real Shopify orders -- Sasha's call, so this data is available same-day with no
 * extra reconciliation step. If payroll ever needs commission tied to confirmed sales only,
 * that would mean teaching this endpoint the same order-matching technique api/profit.js
 * already uses.
 *
 * Storage: same pattern as show-log.js -- a single JSON array on a SHOP-level metafield
 * (custom.seller_log). Read-modify-written on every entry; fine at LeveLux's current scale, but
 * two simultaneous scans could race and clobber each other's write. Revisit with a real
 * datastore if that becomes a problem.
 *
 * POST body:
 *   { action: 'log', passcode, sellerName, itemId, sku, title, redZonePrice, staffCommission }
 *     -> { ok: true, loggedAt }
 *   { action: 'report', passcode }
 *     -> { sellers: [{ sellerName, itemCount, totalCommission }], entries: [...], generatedAt }
 *       -- sellers is sorted by totalCommission descending; pull this whenever the CEO Dashboard
 *       gets its next refresh, to fill in the per-seller commission section.
 *
 * Shares the same SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN / SCAN_PASSCODE env vars as the
 * rest of Seller Scan -- no new environment variables needed to deploy this.
 */

const passcodeMatches = require('./_passcode.js');

const SHOPIFY_API_VERSION = '2024-10';
const NS = 'custom';
const SELLER_LOG_KEY = 'seller_log';

// Keep the log from growing forever, same reasoning as MAX_SHOWS_KEPT in show-log.js -- plenty
// for any reasonable recent stretch of per-item scans; older entries just age out.
const MAX_ENTRIES_KEPT = 8000;

module.exports = async function handler(req, res) {
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

  const { action, passcode, sellerName, itemId, sku, title, redZonePrice, staffCommission } = req.body || {};

  if (!passcodeMatches(passcode)) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }

  try {
    if (action === 'log') {
      const name = (sellerName || '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing sellerName' });
        return;
      }
      const loggedAt = new Date().toISOString();
      const log = await readSellerLog();
      log.push({
        sellerName: name,
        itemId: itemId || null,
        sku: sku || null,
        title: title || null,
        redZonePrice: redZonePrice != null ? String(redZonePrice) : null,
        staffCommission: staffCommission != null ? String(staffCommission) : null,
        loggedAt,
      });
      await writeSellerLog(trimLog(log));
      res.status(200).json({ ok: true, loggedAt });
      return;
    }

    if (action === 'report') {
      const log = await readSellerLog();
      const bySeller = new Map();
      for (const entry of log) {
        const key = entry.sellerName || 'Unknown';
        if (!bySeller.has(key)) bySeller.set(key, { sellerName: key, itemCount: 0, totalCommission: 0 });
        const row = bySeller.get(key);
        row.itemCount += 1;
        const commission = parseFloat(entry.staffCommission);
        if (isFinite(commission)) row.totalCommission += commission;
      }
      const sellers = Array.from(bySeller.values()).sort((a, b) => b.totalCommission - a.totalCommission);
      res.status(200).json({ sellers, entries: log, generatedAt: new Date().toISOString() });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong with the seller log.' });
  }
};

function trimLog(log) {
  if (log.length <= MAX_ENTRIES_KEPT) return log;
  return log.slice(log.length - MAX_ENTRIES_KEPT);
}

// ---------------------------------------------------------------------------
// Shopify: shop-level metafield read/write (same helpers as show-log.js)
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

let cachedShopId = null;
async function getShopId() {
  if (cachedShopId) return cachedShopId;
  const data = await shopifyGraphQL(`query { shop { id } }`, {});
  cachedShopId = data.shop.id;
  return cachedShopId;
}

async function readSellerLog() {
  const data = await shopifyGraphQL(
    `query SellerLog($ns: String!, $key: String!) {
      shop { metafield(namespace: $ns, key: $key) { value } }
    }`,
    { ns: NS, key: SELLER_LOG_KEY }
  );
  const raw = data.shop && data.shop.metafield ? data.shop.metafield.value : null;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeSellerLog(log) {
  const shopId = await getShopId();
  const mutation = `
    mutation SetSellerLog($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    metafields: [
      { ownerId: shopId, namespace: NS, key: SELLER_LOG_KEY, type: 'json', value: JSON.stringify(log) },
    ],
  });
}

module.exports.readSellerLog = readSellerLog;
