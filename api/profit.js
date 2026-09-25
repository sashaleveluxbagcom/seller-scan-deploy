/**
 * LeveLux Seller Scan — profit endpoint (Vercel serverless).
 *
 * Answers "how much did we make" for a given day, broken down by each show that ran that day
 * (see the Show Lineup feature in index.html + api/show-log.js) plus the day's overall total
 * (which also counts any sale that happened outside of a formally-started show, e.g. a single
 * item scanned and sold on the spot).
 *
 * HOW IT WORKS:
 *   1. Reads real Shopify ORDERS for the requested day (any status) -- this is real revenue,
 *      not the asking/flash/red-zone prices shown on the scan tool, since an item can sell for
 *      whatever it actually went for live.
 *   2. Reads each sold line item's COST from Shopify's own per-variant "Cost per item" field
 *      (set on a product's variant in Shopify Admin). Revenue minus cost = profit, per line
 *      item.
 *   3. Reads the show log (api/show-log.js) for shows that started on the requested day, and
 *      matches each show's item list (by SKU) against the day's sold line items to build a
 *      per-show breakdown: which of that show's items sold, for how much, and the show's total
 *      profit. Items in a show that didn't sell that day are listed too (sold: false).
 *
 * REQUIRES two Shopify Admin API scopes beyond what api/scan.js already needs:
 *   read_orders     -- to read order/line-item data at all
 *   read_inventory  -- to read each variant's "Cost per item" (InventoryItem.unitCost)
 *   Add these yourself in Shopify Admin -> Settings -> Apps and sales channels -> Develop apps
 *   -> Levelux -> Configuration -> Admin API access scopes -> Save (reinstall/update access if
 *   prompted). If this endpoint starts 403ing, that's the first thing to check -- I can't grant
 *   API scopes on your behalf, that has to happen in your own Shopify Admin.
 *
 * LIMITATIONS (good enough for a first version, worth knowing about):
 *   - "Cost per item" has to actually be filled in on a variant in Shopify for its profit to be
 *     accurate; a blank cost is treated as $0 cost (so profit = full revenue), which will look
 *     too high for anything you haven't entered a cost for yet.
 *   - Refunds/returns aren't subtracted back out -- a refunded sale still counts as revenue for
 *     the day it was originally sold.
 *   - Matching a show's items to sales is done by SKU within the same calendar day, not by
 *     exact show start/end time -- if the very same SKU is sold more than once in one day
 *     across different shows, sales are attributed to shows in the order they're checked, which
 *     is a reasonable guess but not guaranteed exact.
 *
 * POST body: { passcode, date: "YYYY-MM-DD" }  (date is a UTC calendar day; omit for today UTC)
 */

const { readShowLog } = require('./show-log.js');
const passcodeMatches = require('./_passcode.js');
const { shopifyGraphQL } = require('../lib/shopify.js');

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

  const { passcode, date } = req.body || {};
  if (!passcodeMatches(passcode)) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }

  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);

  try {
    const [lineItems, showLog] = await Promise.all([fetchLineItemsForDay(day), readShowLog()]);
    res.status(200).json(buildProfitReport(day, lineItems, showLog));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong calculating profit: ' + err.message });
  }
};

// Pulled out so it can be unit-tested directly against fake line-items/show-log data without
// touching the network.
function buildProfitReport(day, lineItems, showLog) {
  const bySku = {};
  let dayRevenue = 0;
  let dayCost = 0;
  for (const li of lineItems) {
    dayRevenue += li.revenue;
    dayCost += li.cost;
    if (li.sku) {
      if (!bySku[li.sku]) bySku[li.sku] = [];
      bySku[li.sku].push(li);
    }
  }

  const showsForDay = showLog.filter((s) => (s.startedAt || '').slice(0, 10) === day);

  const shows = showsForDay.map((show) => {
    let revenue = 0;
    let cost = 0;
    let soldCount = 0;
    const items = (show.items || []).map((it) => {
      const matches = it.sku ? bySku[it.sku] : null;
      if (matches && matches.length) {
        // If the same SKU shows up more than once in the day's sales, attribute the first
        // still-unclaimed one to this item -- good enough for one-of-a-kind resale inventory.
        const li = matches.shift();
        revenue += li.revenue;
        cost += li.cost;
        soldCount += 1;
        return { title: it.title, sku: it.sku, sold: true, revenue: round2(li.revenue), cost: round2(li.cost), profit: round2(li.revenue - li.cost) };
      }
      return { title: it.title, sku: it.sku, sold: false };
    });
    return {
      id: show.id,
      startedAt: show.startedAt,
      endedAt: show.endedAt,
      itemCount: items.length,
      soldCount,
      revenue: round2(revenue),
      cost: round2(cost),
      profit: round2(revenue - cost),
      items,
    };
  });

  return {
    date: day,
    dayTotal: {
      revenue: round2(dayRevenue),
      cost: round2(dayCost),
      profit: round2(dayRevenue - dayCost),
      orderLineItems: lineItems.length,
    },
    shows,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// shopifyGraphQL now shared from ../lib/shopify.js

async function fetchLineItemsForDay(day) {
  const nextDay = addOneDay(day);
  // status:any so cancelled orders are included too rather than silently dropped -- "read
  // everything" per how this feature was scoped, rather than quietly filtering some out.
  const searchQuery = `created_at:>='${day}' created_at:<'${nextDay}' AND status:any`;

  const gql = `
    query OrdersForDay($q: String!, $cursor: String) {
      orders(first: 100, after: $cursor, query: $q) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            lineItems(first: 50) {
              edges {
                node {
                  sku
                  quantity
                  discountedTotalSet { shopMoney { amount } }
                  variant { inventoryItem { unitCost { amount } } }
                }
              }
            }
          }
        }
      }
    }
  `;

  const lineItems = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await shopifyGraphQL(gql, { q: searchQuery, cursor });
    const conn = data.orders;
    for (const edge of conn.edges) {
      for (const liEdge of edge.node.lineItems.edges) {
        const li = liEdge.node;
        const revenue = Number(
          (li.discountedTotalSet && li.discountedTotalSet.shopMoney && li.discountedTotalSet.shopMoney.amount) || 0
        );
        const unitCost = Number(
          (li.variant && li.variant.inventoryItem && li.variant.inventoryItem.unitCost && li.variant.inventoryItem.unitCost.amount) || 0
        );
        lineItems.push({
          sku: li.sku || null,
          quantity: li.quantity,
          revenue,
          cost: unitCost * (li.quantity || 1),
        });
      }
    }
    hasNextPage = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }
  return lineItems;
}

function addOneDay(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports.buildProfitReport = buildProfitReport;
