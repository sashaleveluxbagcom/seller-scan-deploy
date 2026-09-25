/**
 * LeveLux Seller Scan — show log endpoint (Vercel serverless).
 *
 * Records when a "show" (a run through a planned lineup, see the Show Lineup feature in
 * index.html) starts and ends, and which items were queued up in it. This is what lets
 * api/profit.js answer "how did each show do" instead of only "how did today do overall".
 *
 * Storage: a single JSON array kept on a SHOP-level metafield (custom.show_log). Shows are
 * read-modify-written into that array. This is a shared, simple store — fine for a business
 * running one live show at a time, but two shows started at the exact same moment on two
 * different devices could race and clobber each other's write. Acceptable trade-off for now;
 * revisit with a real datastore if LeveLux ever runs simultaneous multi-host shows.
 *
 * POST body:
 *   { action: 'start', passcode, items: [{ id, title, sku }] }
 *     -> { showId, startedAt }
 *   { action: 'end', passcode, showId }
 *     -> { ok: true }
 *
 * Shares the same SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN / SCAN_PASSCODE env vars as
 * api/scan.js and api/search.js — no new environment variables needed to deploy this.
 */

const passcodeMatches = require('./_passcode.js');
const { shopifyGraphQL } = require('../lib/shopify.js');

const NS = 'custom';
const SHOW_LOG_KEY = 'show_log';

// Keep the log from growing forever -- only the most recent N shows are kept. Plenty for
// "look at every show and every day" over any reasonable recent stretch; older shows just age
// out rather than being fetched and re-written every single time (Shopify metafields have a
// size ceiling too).
const MAX_SHOWS_KEPT = 500;

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

  const { action, passcode, items, showId } = req.body || {};

  if (!passcodeMatches(passcode)) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }

  try {
    if (action === 'start') {
      const startedAt = new Date().toISOString();
      const newShowId = 'show_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const log = await readShowLog();
      log.push({
        id: newShowId,
        startedAt,
        endedAt: null,
        items: Array.isArray(items) ? items.map((it) => ({ id: it.id, title: it.title, sku: it.sku || null })) : [],
      });
      await writeShowLog(trimLog(log));
      res.status(200).json({ showId: newShowId, startedAt });
      return;
    }

    if (action === 'end') {
      if (!showId) {
        res.status(400).json({ error: 'Missing showId' });
        return;
      }
      const endedAt = new Date().toISOString();
      const log = await readShowLog();
      const show = log.find((s) => s.id === showId);
      if (show) {
        show.endedAt = endedAt;
        await writeShowLog(log);
      }
      res.status(200).json({ ok: true, endedAt });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong logging the show.' });
  }
};

function trimLog(log) {
  if (log.length <= MAX_SHOWS_KEPT) return log;
  return log.slice(log.length - MAX_SHOWS_KEPT);
}

// ---------------------------------------------------------------------------
// Shopify: shop-level metafield read/write (shopifyGraphQL shared from ../lib/shopify.js)
// ---------------------------------------------------------------------------

let cachedShopId = null;
async function getShopId() {
  if (cachedShopId) return cachedShopId;
  const data = await shopifyGraphQL(`query { shop { id } }`, {});
  cachedShopId = data.shop.id;
  return cachedShopId;
}

async function readShowLog() {
  const data = await shopifyGraphQL(
    `query ShowLog($ns: String!, $key: String!) {
      shop { metafield(namespace: $ns, key: $key) { value } }
    }`,
    { ns: NS, key: SHOW_LOG_KEY }
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

async function writeShowLog(log) {
  const shopId = await getShopId();
  const mutation = `
    mutation SetShowLog($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    metafields: [
      { ownerId: shopId, namespace: NS, key: SHOW_LOG_KEY, type: 'json', value: JSON.stringify(log) },
    ],
  });
}

module.exports.readShowLog = readShowLog;
