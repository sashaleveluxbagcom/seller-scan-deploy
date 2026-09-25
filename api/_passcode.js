/**
 * Shared passcode check used by every endpoint (scan, search, profit, show-log).
 *
 * Trims whitespace, ignores case, and strips internal spaces before comparing --
 * staff often type or dictate the passcode on a phone (auto-capitalize, a stray
 * leading/trailing space, voice-to-text turning "catscatscats" into "cats cats
 * cats"). This is a light gate to keep the tool off Google's index and out of
 * casual hands, not a real security boundary, so being forgiving about exactly
 * how it's typed is a straightforward win with no real downside.
 *
 * Codes come from SELLER_STAFF_CODES (Vercel env var), a comma-separated list of
 * "name-code" pairs -- e.g. "firstname-1234,lastname-5678" -- the same format
 * already used elsewhere in this business (each staff member's passcode here is
 * meant to match their existing Scan Station PIN, so nobody has to remember a
 * second number). Each entry is split on the FIRST hyphen only, so a hyphenated
 * name (e.g. "ramirez-salazar-5678") still works. This is deliberately NOT
 * hardcoded in source -- unlike the old STAFF_CODES array, real passcodes never
 * belong in git history, including as "example" values in a comment. If the env
 * var is unset or empty, every passcode is rejected (fail closed) rather than
 * silently falling back to any old list.
 *
 * Having a name attached to every code (rather than the old flat, anonymous list)
 * is also what makes the login log in api/login-log.js possible -- resolveStaffName()
 * below is how that endpoint finds out who just logged in.
 */

function parseStaffCodes() {
  var raw = process.env.SELLER_STAFF_CODES;
  var map = Object.create(null); // normalized code -> display name
  if (!raw || typeof raw !== 'string') return map;
  raw.split(',').forEach(function (pair) {
    var entry = pair.trim();
    if (!entry) return;
    var idx = entry.indexOf('-');
    if (idx === -1) return; // malformed entry, skip rather than throw
    var name = entry.slice(0, idx).trim();
    var code = entry.slice(idx + 1).trim();
    if (!name || !code) return;
    map[normalize(code)] = name;
  });
  return map;
}

function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '');
}

module.exports = function passcodeMatches(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  var codes = parseStaffCodes();
  return Object.prototype.hasOwnProperty.call(codes, normalize(candidate));
};

// Returns the staff member's name for a matching passcode, or null if it doesn't
// match anyone. Used by api/login-log.js to record who logged in.
function resolveStaffName(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  var codes = parseStaffCodes();
  var norm = normalize(candidate);
  return Object.prototype.hasOwnProperty.call(codes, norm) ? codes[norm] : null;
}

module.exports.resolveStaffName = resolveStaffName;
