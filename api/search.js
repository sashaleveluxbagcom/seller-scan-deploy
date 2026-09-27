/**
 * LeveLux Seller Scan — inventory search endpoint (Vercel serverless).
 *
 * Lets staff search live Shopify inventory by brand/title keyword and product type/category,
 * optionally limited to in-stock items, and returns each match's title, photo, and the same
 * three price tiers used by the barcode-scan endpoint (see the FIELD MAPPING notes at the top
 * of api/scan.js -- this file reads the exact same fields, so the two stay consistent).
 *
 * Deliberately lightweight: this does NOT generate a full sales script per result (that would
 * mean an expensive Claude research call for every item in a list of results). Search is for
 * browsing price/availability across many items at once; scanning a single item's barcode/SKU
 * on the Scan tab is still how staff pull that item's full script and condition-check walkthrough.
 *
 * Shares the SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN / SCAN_PASSCODE / STOREFRONT_ORIGIN env
 * vars already set up for api/scan.js in your Vercel project -- no new environment variables
 * needed to deploy this alongside it.
 */

const passcodeMatches = require('./_passcode.js');
const { shopifyGraphQL } = require('../lib/shopify.js');

const NS = 'custom';
const RED_ZONE_KEY_NEW = 'red_zone_price';
const RED_ZONE_KEY_LEGACY = 'flash_price';
const FLASH_SALE_KEY = 'preferred_price';

const MAX_RESULTS = 24;

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

  const { query, category, inStockOnly, passcode } = req.body || {};

  if (!passcodeMatches(passcode)) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }

  try {
    const items = await searchProducts({
      query: (query || '').trim(),
      category: (category || '').trim(),
      inStockOnly: !!inStockOnly,
    });
    res.status(200).json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong searching inventory.' });
  }
};

// ---------------------------------------------------------------------------
// Shopify lookup
// ---------------------------------------------------------------------------

// Shopify Money-type metafields store a JSON string like {"amount":"309.00","currency_code":"USD"}
function moneyValue(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw).amount;
  } catch {
    return raw;
  }
}

async function searchProducts({ query, category, inStockOnly }) {
  // Build a Shopify search-syntax query string. Free text (no field prefix) matches across
  // title, vendor, product type and tags. Each word is quoted and AND-ed together so a
  // multi-word brand like "Louis Vuitton" has to match as a phrase-ish combination rather than
  // splitting into a loose OR of unrelated single words.
  const clauses = ['status:active'];
  if (category) {
    clauses.push(`product_type:"${category.replace(/"/g, '')}"`);
  }
  if (query) {
    const words = query.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"`);
    if (words.length) clauses.push('(' + words.join(' AND ') + ')');
  }
  const searchQuery = clauses.join(' AND ');

  const gql = `
    query SearchProducts($q: String!, $n: Int!) {
      products(first: $n, query: $q) {
        edges {
          node {
            id
            title
            vendor
            productType
            totalInventory
            featuredImage { url }
            priceRangeV2 { minVariantPrice { amount } }
            variants(first: 1) { edges { node { sku } } }
            flashSale: metafield(namespace: "${NS}", key: "${FLASH_SALE_KEY}") { value }
            redZoneNew: metafield(namespace: "${NS}", key: "${RED_ZONE_KEY_NEW}") { value }
            redZoneLegacy: metafield(namespace: "${NS}", key: "${RED_ZONE_KEY_LEGACY}") { value }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(gql, { q: searchQuery, n: MAX_RESULTS });
  const edges = (data.products && data.products.edges) || [];

  return edges
    .map(({ node: p }) => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      productType: p.productType,
      sku: p.variants && p.variants.edges[0] ? p.variants.edges[0].node.sku : null,
      image: p.featuredImage ? p.featuredImage.url : null,
      inStock: (p.totalInventory || 0) > 0,
      askingPrice: p.priceRangeV2 && p.priceRangeV2.minVariantPrice ? p.priceRangeV2.minVariantPrice.amount : null,
      flashPrice: moneyValue(p.flashSale && p.flashSale.value),
      redZonePrice:
        moneyValue(p.redZoneNew && p.redZoneNew.value) ?? moneyValue(p.redZoneLegacy && p.redZoneLegacy.value),
    }))
    .filter((item) => !inStockOnly || item.inStock);
}
