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
/**
 * Shared passcode check used by every endpoint (scan, search, profit, show-log).
 * Trims whitespace, ignores case, and strips internal spaces before comparing.
 * One passcode per person -- add or remove people by editing the list.
 */
/**
 * Shared passcode check used by every endpoint.
 * OWNER_CODES work on any device. STAFF_CODES work ONLY on approved shop devices.
 * To revoke a device, delete its line from APPROVED_DEVICES.
 */
var crypto = require('crypto');

var OWNER_CODES = ["2864367"]; // Sasha (owner) -- any device

// Diana, Alexie, Megan, Vanessa, Michael, Carolina -- shop devices only
var STAFF_CODES = ["1249", "7134", "9032", "6193", "3910", "4471"];

var APPROVED_DEVICES = [
  "925676244c813cc49456494fcd5369c622bf3ab3ff51ccdb35e723998ab551ea", // Device 1
  "594e3c8d129e1bcc291d219b6b52672b177dc50082f453f982c659019bbba363", // Device 2
  "482e26fabe02e2dcb106ca0910229cc790f5931702b1f3e13e5e746be3c26703", // Device 3
  "b14a4369cde957b8700cf2d03abe88ff7fd5a9c1e2af32a3942d21157f1596ec", // Device 4
  "2fd495a036c3048e693d8e9aaae86bbdd12de1a15d33496cd5a7657efedc4d33", // Device 5
  "7e912ed2a0ecfb05f0c6ec0ce21d923cc8c3eaedb66936615c037cdabf52659b", // Device 6
  "785c64a9281dfc3b82090496365bdcaefa6afcfc22a66e0a22ffc8033c937c6e", // Device 7
  "e6edd1b91ecb4b10af34b6c04135c306bbd54da0dce76b4f40532720cdd4dbf3", // Device 8
  "6043b3065b0d80ce3f7ea93e9355b1243dfb9f899530d128da82a88f55cdfcb0", // Device 9
  "df1caa4e026da4e0164543c2359524f23987966a8ebf25e46e47ffcd83d8770d", // Device 10
  "8db3d89d8f2c666cb12b413bb4b72c415509e856b348a16ed7bf092dc460146c", // Device 11
  "e534ea92a6cc117bf739143d8d9c2a90e4804156530cdd512ddcfea943701f07", // Device 12
  "5ef88caa4da4087923dd69cb96e2c57d5f6fddd16c30a347d9fa6bf55f93a45f", // Device 13
  "cc138b429562bf499feeae4a33fcf7a048b5342c6a7b3b3f019467ead95ca47a", // Device 14
  "e95f7420f4e91296302991f1b094bb4ac7ae89c3355395ae1da6942de90b0c5f", // Device 15
];

module.exports = function passcodeMatches(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  var parts = candidate.split('|');
  var code = normalize(parts[0]);
  var device = normalize(parts[1] || '');
  if (OWNER_CODES.some(function (c) { return normalize(c) === code; })) return true;
  if (!STAFF_CODES.some(function (c) { return normalize(c) === code; })) return false;
  if (!device) return false;
  var hash = crypto.createHash('sha256').update(device).digest('hex');
  return APPROVED_DEVICES.indexOf(hash) !== -1;
};

function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '');
}
