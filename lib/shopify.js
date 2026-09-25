/**
 * Shared Shopify Admin GraphQL helper for every endpoint in this app.
 *
 * Previously this exact function was copy-pasted into 7 files (scan.js,
 * search.js, profit.js, seller-log.js, backfill.js, login-log.js,
 * show-log.js) with no retry handling at all -- a single Shopify rate-limit
 * response (a real risk when several staff are scanning/searching at once
 * during a live show) surfaced straight through as a generic 500
 * ("Something went wrong..."). This version retries on a throttled response
 * before giving up, and is the one place all seven endpoints now import
 * from instead of keeping their own copy.
 */

const SHOPIFY_API_VERSION = '2024-10';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(json) {
  return (
    Array.isArray(json.errors) &&
    json.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED')
  );
}

async function shopifyGraphQL(query, variables) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(BASE_DELAY_MS * attempt);
    }

    let resp;
    try {
      resp = await fetch(
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
    } catch (networkErr) {
      // fetch itself threw (DNS blip, connection reset, etc.) -- worth a retry.
      lastErr = networkErr;
      continue;
    }

    if (resp.status === 429) {
      lastErr = new Error('Shopify API rate limited (429)');
      continue;
    }

    const json = await resp.json();

    if (json.errors) {
      if (isThrottled(json)) {
        lastErr = new Error('Shopify API throttled (query cost)');
        continue;
      }
      // A real GraphQL error (bad query, missing scope, etc.) -- retrying
      // won't help, fail immediately with the original message.
      throw new Error('Shopify API error: ' + JSON.stringify(json.errors));
    }

    return json.data;
  }
  throw lastErr || new Error('Shopify API request failed after retries');
}

module.exports = { shopifyGraphQL, SHOPIFY_API_VERSION };
