// Manual protobuf binary encoder for Tesla's BLE protocol.
// Avoids the buf-generate build step entirely — correctness is verifiable by inspection.
// Wire types: 0 = varint, 2 = length-delimited (embedded message, bytes, string)

/**
 * Encode an unsigned integer as a protobuf varint.
 * @param {number} value
 * @returns {Uint8Array}
 */
export function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0; // treat as uint32
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

/**
 * Encode a protobuf field tag (field_number << 3 | wire_type).
 */
function tag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/**
 * Encode a varint field. Omits the field if value is 0 (proto3 default).
 * @param {number} fieldNumber
 * @param {number} value
 */
export function varintField(fieldNumber, value) {
  if (value === 0) return new Uint8Array(0);
  return concat(tag(fieldNumber, 0), encodeVarint(value));
}

/**
 * Encode a bytes/embedded-message field (wire type 2).
 * @param {number} fieldNumber
 * @param {Uint8Array} bytes
 */
export function bytesField(fieldNumber, bytes) {
  if (!bytes || bytes.length === 0) return new Uint8Array(0);
  return concat(tag(fieldNumber, 2), encodeVarint(bytes.length), bytes);
}

/**
 * Alias — makes call sites that encode embedded messages self-documenting.
 */
export const messageField = bytesField;

/**
 * Concatenate multiple Uint8Arrays.
 * @param {...Uint8Array} arrays
 * @returns {Uint8Array}
 */
export function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + (a ? a.length : 0), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    if (a && a.length) {
      out.set(a, offset);
      offset += a.length;
    }
  }
  return out;
}

// ─── Minimal response decoder ───────────────────────────────────────────────

/**
 * Walk a raw protobuf binary and return a field map.
 * Values: varint → number, length-delimited → Uint8Array.
 * Does not recurse automatically — callers decode nested messages explicitly.
 * @param {Uint8Array} bytes
 * @returns {Object.<number, number|Uint8Array>}
 */
export function decodeProto(bytes) {
  const fields = {};
  let pos = 0;

  function readVarint() {
    let result = 0, shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  while (pos < bytes.length) {
    const tagVal = readVarint();
    const fieldNum = tagVal >>> 3;
    const wireType = tagVal & 0x07;

    if (wireType === 0) {
      fields[fieldNum] = readVarint();
    } else if (wireType === 2) {
      const len = readVarint();
      fields[fieldNum] = bytes.slice(pos, pos + len);
      pos += len;
    } else {
      // Wire types 1, 5 (fixed64, fixed32) are unused by Tesla's protos.
      // If encountered, the parse position is corrupt — bail out.
      console.warn(`[Proto] Unexpected wire type ${wireType} at field ${fieldNum}, aborting decode`);
      break;
    }
  }

  return fields;
}