/**
 * Cryptographic utilities for Tesla BLE passive entry.
 *
 * Signing algorithm: ECDSA P-256 (secp256r1) with SHA-256.
 * Key format input: standard OpenSSL PEM files.
 *   - private_key.pem → PKCS#8 PrivateKeyInfo DER
 *   - public_key.pem  → SubjectPublicKeyInfo (SPKI) DER
 *
 * The key ID sent in every SignedMessage is SHA1(uncompressedPubKey)[0..3].
 *
 * Signing input format for VCSEC SignedMessage (reconstructed from
 * vehicle-command Go source; verify against upstream if behaviour changes):
 *
 *   SHA-256( counter_BE4 || epoch || expiresAt_BE4 || unsignedMsgBytes )
 *
 * The resulting hash is passed directly to p256.sign() (which does NOT
 * double-hash — it signs the 32-byte digest you provide).
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { sha1 }   from '@noble/hashes/sha1';
import { concat } from '../proto/encoder';

// ─── PEM → DER ───────────────────────────────────────────────────────────────

/**
 * Strip PEM armour and decode base64 to raw DER bytes.
 * @param {string} pem
 * @returns {Uint8Array}
 */
function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Minimal DER parser ───────────────────────────────────────────────────────

function derParser(buf) {
  let pos = 0;

  function readTag() { return buf[pos++]; }

  function readLength() {
    const first = buf[pos++];
    if (first < 0x80) return first;
    const numBytes = first & 0x7f;
    let len = 0;
    for (let i = 0; i < numBytes; i++) len = (len << 8) | buf[pos++];
    return len;
  }

  function readBytes(len) {
    const slice = buf.slice(pos, pos + len);
    pos += len;
    return slice;
  }

  function expectTag(expected) {
    const actual = readTag();
    if (actual !== expected) {
      throw new Error(`DER parse: expected tag 0x${expected.toString(16)}, got 0x${actual.toString(16)} at offset ${pos - 1}`);
    }
  }

  function skipTLV() {
    readTag();
    const len = readLength();
    pos += len;
  }

  return { readTag, readLength, readBytes, expectTag, skipTLV, getPos: () => pos };
}

// ─── Key extraction ───────────────────────────────────────────────────────────

/**
 * Parse a PKCS#8 PrivateKeyInfo DER and return the 32-byte EC scalar.
 *
 * Structure:
 *   SEQUENCE {
 *     INTEGER 0                  // version
 *     SEQUENCE { OID OID }       // algorithm (ecPublicKey + secp256r1)
 *     OCTET STRING {
 *       SEQUENCE {               // ECPrivateKey (RFC 5915)
 *         INTEGER 1              // version
 *         OCTET STRING <32B>     // privateKey
 *       }
 *     }
 *   }
 *
 * @param {Uint8Array} der
 * @returns {Uint8Array} 32-byte private key scalar
 */
function extractPrivateKeyFromPKCS8(der) {
  const p = derParser(der);

  p.expectTag(0x30); p.readLength(); // outer SEQUENCE
  p.skipTLV();                       // version INTEGER 0
  p.skipTLV();                       // algorithm SEQUENCE

  p.expectTag(0x04); p.readLength(); // privateKey OCTET STRING
  p.expectTag(0x30); p.readLength(); // ECPrivateKey SEQUENCE
  p.skipTLV();                       // version INTEGER 1

  p.expectTag(0x04);                 // privateKey OCTET STRING (the actual key)
  const keyLen = p.readLength();
  return p.readBytes(keyLen);        // 32 bytes for P-256
}

/**
 * Parse a SubjectPublicKeyInfo DER and return the 65-byte uncompressed EC point.
 *
 * Structure:
 *   SEQUENCE {
 *     SEQUENCE { OID OID }   // algorithm
 *     BIT STRING { 0x00 04 <32B x> <32B y> }
 *   }
 *
 * @param {Uint8Array} der
 * @returns {Uint8Array} 65-byte uncompressed EC point (0x04 || x || y)
 */
function extractPublicKeyFromSPKI(der) {
  const p = derParser(der);

  p.expectTag(0x30); p.readLength(); // outer SEQUENCE
  p.skipTLV();                       // algorithm SEQUENCE

  p.expectTag(0x03);                 // BIT STRING
  const bitLen = p.readLength();
  p.readBytes(1);                    // skip "unused bits" byte (always 0x00)

  return p.readBytes(bitLen - 1);   // 65 bytes: 0x04 || x || y
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and parse PEM key files.
 *
 * @param {string} privatePem  contents of private_key.pem
 * @param {string} publicPem   contents of public_key.pem
 * @returns {{ privateKeyBytes: Uint8Array, publicKeyBytes: Uint8Array, keyId: Uint8Array }}
 */
export function loadKeys(privatePem, publicPem) {
  const privateKeyBytes = extractPrivateKeyFromPKCS8(pemToDer(privatePem));
  const publicKeyBytes  = extractPublicKeyFromSPKI(pemToDer(publicPem));

  // Validate the keypair is consistent.
  const derivedPub = p256.getPublicKey(privateKeyBytes, false); // uncompressed
  if (!derivedPub.every((b, i) => b === publicKeyBytes[i])) {
    throw new Error('Key mismatch: public_key.pem does not match private_key.pem');
  }

  // Key ID: first 4 bytes of SHA-1(uncompressed public key).
  const keyId = sha1(publicKeyBytes).slice(0, 4);

  return { privateKeyBytes, publicKeyBytes, keyId };
}

/**
 * Sign an UnsignedMessage for VCSEC's SignedMessage wrapper.
 *
 * Signing input (all big-endian where applicable):
 *   counter_BE4 (4 bytes) || epoch (variable) || expiresAt_BE4 (4 bytes) || unsignedMsgBytes
 *
 * The SHA-256 digest of that concatenation is signed with ECDSA P-256.
 * @noble/curves p256.sign() accepts a pre-hashed 32-byte digest directly.
 *
 * @param {Uint8Array} unsignedMsgBytes  serialised vcsec UnsignedMessage
 * @param {Uint8Array} privateKeyBytes   32-byte EC scalar
 * @param {number}     counter           session counter (vehicle counter + 1)
 * @param {Uint8Array} epoch             session epoch from vehicle
 * @param {number}     expiresAt         unix timestamp
 * @returns {Uint8Array} DER-encoded ECDSA signature
 */
export function signVCSECMessage({ unsignedMsgBytes, privateKeyBytes, counter, epoch, expiresAt }) {
  const counterBytes   = uint32BE(counter);
  const expiresAtBytes = uint32BE(expiresAt);

  const toSign = concat(counterBytes, epoch, expiresAtBytes, unsignedMsgBytes);
  const digest = sha256(toSign);

  const sig = p256.sign(digest, privateKeyBytes, { lowS: true });
  return sig.toDERRawBytes();
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function uint32BE(value) {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, value >>> 0, false); // big-endian
  return buf;
}