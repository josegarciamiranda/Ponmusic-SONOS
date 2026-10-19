const crypto = require('crypto');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    let chunk = bits.substring(i, i + 5);
    if (chunk.length < 5) chunk = chunk.padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return output;
}
function base32Decode(str) {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of str) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substring(i, i + 8), 2));
  return Buffer.from(bytes);
}
function generateSecret(len = 20) { return base32Encode(crypto.randomBytes(len)); }
function generateTOTP(base32Secret, forTime, step = 30, digits = 6) {
  const key = base32Decode(base32Secret);
  const time = forTime === undefined ? Date.now() : forTime;
  const counter = Math.floor(time / 1000 / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binCode = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset+1] & 0xff) << 16) | ((hmac[offset+2] & 0xff) << 8) | (hmac[offset+3] & 0xff);
  return (binCode % (10 ** digits)).toString().padStart(digits, '0');
}
function verifyTOTP(base32Secret, token, windowSteps = 3, step = 30) {
  if (!token || !/^\d{6}$/.test(String(token))) return false;
  const now = Date.now();
  for (let w = -windowSteps; w <= windowSteps; w++) {
    if (generateTOTP(base32Secret, now + w*step*1000, step) === String(token)) return true;
  }
  return false;
}
module.exports = { generateSecret, generateTOTP, verifyTOTP, base32Encode, base32Decode };

function buildOtpAuthUri(secret, accountLabel, issuer) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(accountLabel)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
module.exports.buildOtpAuthUri = buildOtpAuthUri;
module.exports.generateDeviceToken = function(){ return require('crypto').randomBytes(32).toString('hex'); };
