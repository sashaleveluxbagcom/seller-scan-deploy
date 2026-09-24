/**
 * LeveLux Seller Scan — login log endpoint (Vercel serverless).
 *
 * Records who logged into the tool and when, so there's a real answer to "who was
 * using this and when" -- something the old anonymous STAFF_CODES array (see
 * api/_passcode.js) couldn't support, since it had no idea which code belonged to
 * which person. Now that every passcode is tied to a name via SELLER_STAFF_CODES,
 * this endpoint can resolve that name server-side and log it.
 *
 * This is a SEPARATE log from api/seller-log.js -- that one is staff self-reporting
 * their own name per item scanned, for commission tracking, and already works fine.
 * This one is login/auth: one entry per successful passcode entry at the gate
 * screen, not per scan. Don't conflate the two.
 *
 * Storage: same pattern as show-log.js / seller-log.js -- a single JSON array on a
 * SHOP-level metafield (custom.login_log). Read-modify-written on every login;
 * fine at LeveLux's current scale, but two simultaneous logins could in principle
 * race and clobber each other's write, same caveat as seller-log.js.
 *
 * POST body: { passcode }
 *   -> resolves the name behind that passcode (api/_passcode.js#resolveStaffName),
 *      appends { name, at } to the log, and returns { ok: true, name, loggedAt }.
 *   -> 401 if the passcode doesn't match anyone.
 *   The frontend fires this fire-and-forget once per page load, right after the
 *   passcode gate is passed -- see tryEnter() in index.html. Not on every scan.
 *
 * GET /api/login-log?passcode=...
 *   -> any valid staff passcode can view the recent login history (this tool's
 *      "admin view" is deliberately just readable JSON, matching how lightweight
 *      the rest of Seller Scan already is -- see also GET being used here instead
 *      of POST, purely so a manager can pull this up by just visiting the URL).
 *   -> { entries: [{ name, at }, ...], generatedAt }
 *   -> 401 if the passcode doesn't match anyone.
 *
 * Shares the same SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN env vars as the rest
 * of Seller Scan -- no new Shopify credentials needed to deploy this.
 */

const passcodeMatches = require('./_passcode.js');
const resolveStaffName = passcodeMatches.resolveStaffName;

const SHOPIFY_API_VERSION = '2024-10';
const NS = 'custom';
const LOGIN_LOG_KEY = 'login_log';

// Keep the log from growing forever, same reasoning as MAX_ENTRIES_KEPT in
// seller-log.js -- plenty for any reasonable recent stretch of logins.
const MAX_ENTRIES_KEPT = 2000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.STOREFRONT_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'POST') {
      const { passcode } = req.body || {};
      const name = resolveStaffName(passcode);
      if (!name) {
        res.status(401).json({ error: 'Not authorized' });
        return;
      }
      const loggedAt = new Date().toISOString();
      const log = await readLoginLog();
      log.push({ name, at: loggedAt });
      await writeLoginLog(trimLog(log));
      res.status(200).json({ ok: true, name, loggedAt });
      return;
    }

    if (req.method === 'GET') {
      const passcode = (req.query && req.query.passcode) || '';
      if (!passcodeMatches(passcode)) {
        res.status(401).json({ error: 'Not authorized' });
        return;
      }
      const log = await readLoginLog();
      // Most recent first -- that's what a manager pulling this up actually wants.
      const entries = log.slice().reverse();
      res.status(200).json({ entries, generatedAt: new Date().toISOString() });
      return;
    }

    res.status(405).json({ error: 'Use GET or POST' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong with the login log.' });
  }
};

function trimLog(log) {
  if (log.length <= MAX_ENTRIES_KEPT) return log;
  return log.slice(log.length - MAX_ENTRIES_KEPT);
}

// ---------------------------------------------------------------------------
// Shopify: shop-level metafield read/write (same helpers as show-log.js / seller-log.js)
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

async function readLoginLog() {
  const data = await shopifyGraphQL(
    `query LoginLog($ns: String!, $key: String!) {
      shop { metafield(namespace: $ns, key: $key) { value } }
    }`,
    { ns: NS, key: LOGIN_LOG_KEY }
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

async function writeLoginLog(log) {
  const shopId = await getShopId();
  const mutation = `
    mutation SetLoginLog($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, {
    metafields: [
      { ownerId: shopId, namespace: NS, key: LOGIN_LOG_KEY, type: 'json', value: JSON.stringify(log) },
    ],
  });
}
