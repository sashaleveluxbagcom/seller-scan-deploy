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
 * One numeric passcode per staff member (see STAFF_CODES below) rather than a
 * single shared code -- add or remove people by editing the list.
 */
var STAFF_CODES = ["1", "2", "3", "4", "5", "6", "7", "842525"]; // Alexie, Carolina, Diana, Jason, Mariela, Megan, Vanessa, Sasha (owner)

module.exports = function passcodeMatches(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  var norm = normalize(candidate);
  return STAFF_CODES.some(function (code) { return norm === normalize(code); });
};

function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '');
}
