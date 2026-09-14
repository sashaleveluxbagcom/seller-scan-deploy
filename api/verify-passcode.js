/**
 * LeveLux Seller Scan — passcode verification endpoint (Vercel serverless).
 *
 * Used ONLY at the gate screen, the moment someone submits a passcode, so they find out
 * immediately whether it's right -- instead of the old behavior, where the app would let
 * anyone straight into the Scan/Search screen and only discover a wrong passcode later, the
 * first time they tried to actually scan or search something (which showed up as a confusing
 * "wrong passcode" message after already looking like it worked).
 *
 * Deliberately does nothing else: no Shopify call, no Anthropic call -- just checks the
 * passcode as fast as possible so the gate feels instant. The real per-request check on
 * api/scan.js, api/search.js, etc. is unchanged and still runs on every real request; this
 * endpoint is purely a faster, clearer front door.
 *
 * POST body: { passcode }  ->  200 { ok: true }  or  401 { error: 'Not authorized' }
 */

const passcodeMatches = require('./_passcode.js');

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

  const { passcode } = req.body || {};
  if (!passcodeMatches(passcode)) {
    res.status(401).json({ error: 'Not authorized' });
    return;
  }
  res.status(200).json({ ok: true });
};
