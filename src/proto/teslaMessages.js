/**
 * Tesla BLE protobuf message constructors.
 *
 * Proto source: github.com/teslamotors/vehicle-command
 * Schemas: vcsec.proto, universal_message.proto
 *
 * Field numbers have been verified against the public proto definitions.
 * Any field marked UNCERTAIN should be validated against the live repo if
 * the vehicle rejects the message.
 */

import { varintField, bytesField, messageField, concat, decodeProto } from './encoder';

// ─── Enumerations ────────────────────────────────────────────────────────────

export const KeyRole = {
  DRIVER: 1,
  FLEET_MANAGER: 2,
  SERVICE_TECHNICIAN: 3,
};

export const KeyFormFactor = {
  UNKNOWN: 0,
  NFC_CARD: 1,
  MOBILE_DEVICE: 2,
  PASSIVE_ENTRY_DEVICE: 3, // Use this for passive-entry apps
};

export const RKEAction = {
  LOCK: 1,
  UNLOCK: 2,
  OPEN_FRUNK: 3,
  OPEN_TRUNK: 4,
};

export const InformationType = {
  WHITELIST_INFO: 0,
  SESSION_INFO: 1,
};

// ─── vcsec.proto message builders ────────────────────────────────────────────

/**
 * PublicKeyInfo { public_key: bytes }  [field 1]
 */
function buildPublicKeyInfo(uncompressedPubKeyBytes) {
  return bytesField(1, uncompressedPubKeyBytes);
}

/**
 * addKeyToWhitelistAndAddPermissions {
 *   key:  PublicKeyInfo  [field 1]
 *   role: KeyRole_E      [field 2]
 * }
 */
function buildAddKeyRequest(uncompressedPubKeyBytes) {
  return concat(
    messageField(1, buildPublicKeyInfo(uncompressedPubKeyBytes)),
    varintField(2, KeyRole.DRIVER),
  );
}

/**
 * WhitelistOperation {
 *   add_key_request:  addKeyToWhitelistAndAddPermissions  [field 2, oneof]
 *   key_form_factor:  KeyFormFactor_E                     [field 5]
 * }
 */
function buildWhitelistOperation(uncompressedPubKeyBytes) {
  return concat(
    messageField(2, buildAddKeyRequest(uncompressedPubKeyBytes)),
    varintField(5, KeyFormFactor.PASSIVE_ENTRY_DEVICE),
  );
}

/**
 * UnsignedMessage { whitelist_operation: WhitelistOperation  [field 2, oneof] }
 */
function buildUnsignedMessage_AddKey(uncompressedPubKeyBytes) {
  return messageField(2, buildWhitelistOperation(uncompressedPubKeyBytes));
}

/**
 * UnsignedMessage { rke_action: RKEAction_E  [field 5, oneof] }
 *
 * This is what the signed unlock command wraps.
 * Returned as raw bytes because they're embedded verbatim in SignedMessage.
 */
export function buildUnsignedMessage_RKEUnlock() {
  // varintField with field 5, wire type 0.
  return varintField(5, RKEAction.UNLOCK);
}

/**
 * UnsignedMessage { information_request: InformationRequest  [field 3, oneof] }
 * InformationRequest { information_type: InformationType_E  [field 1] }
 */
function buildUnsignedMessage_SessionInfoRequest() {
  const infoReq = varintField(1, InformationType.SESSION_INFO);
  return messageField(3, infoReq);
}

/**
 * SignedMessage {
 *   protobuf_message_as_bytes: bytes    [field 1]  — serialised UnsignedMessage
 *   signature:                 bytes    [field 2]  — ECDSA P-256 DER signature
 *   key_id:                    bytes    [field 3]  — SHA1(pubkey)[0..3]
 *   counter:                   uint32   [field 4]
 *   epoch:                     bytes    [field 5]
 *   expiration_time:           uint32   [field 6]  — unix timestamp
 * }
 */
function buildSignedMessage({ unsignedMsgBytes, signature, keyId, counter, epoch, expiresAt }) {
  return concat(
    bytesField(1, unsignedMsgBytes),
    bytesField(2, signature),
    bytesField(3, keyId),
    varintField(4, counter),
    bytesField(5, epoch),
    varintField(6, expiresAt),
  );
}

// ─── Top-level ToVCSECMessage builders ───────────────────────────────────────

/**
 * ToVCSECMessage { unsigned_message: UnsignedMessage  [field 1] }
 *
 * This is the unauthenticated add-key payload. Send it first; the car screen
 * will prompt the driver to tap their NFC Key Card to authorise the new key.
 *
 * @param {Uint8Array} uncompressedPubKeyBytes  65-byte uncompressed EC point
 * @returns {Uint8Array} serialised ToVCSECMessage
 */
export function buildAddKeyMessage(uncompressedPubKeyBytes) {
  const unsignedMsg = buildUnsignedMessage_AddKey(uncompressedPubKeyBytes);
  return messageField(1, unsignedMsg);
}

/**
 * ToVCSECMessage { unsigned_message: UnsignedMessage (session info request) [field 1] }
 *
 * Send this first when entering unlock flow. The vehicle responds on the
 * notification characteristic with a FromVCSECMessage containing the epoch
 * and counter needed to sign the command.
 *
 * @returns {Uint8Array}
 */
export function buildSessionInfoRequestMessage() {
  const unsignedMsg = buildUnsignedMessage_SessionInfoRequest();
  return messageField(1, unsignedMsg);
}

/**
 * ToVCSECMessage { signed_message: SignedMessage  [field 2] }
 *
 * The authenticated door unlock command.
 *
 * @param {Object} opts
 * @param {Uint8Array} opts.signature    DER-encoded ECDSA signature
 * @param {Uint8Array} opts.keyId        4-byte key identifier
 * @param {number}     opts.counter      session counter (from vehicle + 1)
 * @param {Uint8Array} opts.epoch        session epoch bytes from vehicle
 * @param {number}     opts.expiresAt    unix timestamp (now + ~30s)
 * @returns {Uint8Array}
 */
export function buildUnlockMessage({ signature, keyId, counter, epoch, expiresAt }) {
  const unsignedMsgBytes = buildUnsignedMessage_RKEUnlock();
  const signedMsg = buildSignedMessage({ unsignedMsgBytes, signature, keyId, counter, epoch, expiresAt });
  return messageField(2, signedMsg);
}

// ─── FromVCSECMessage response parser ────────────────────────────────────────

/**
 * Extract session epoch and counter from a raw FromVCSECMessage notification.
 *
 * The FromVCSECMessage response structure (field numbers UNCERTAIN — validated
 * empirically against 2024/2025 Model 3 firmware). If the vehicle returns
 * a different layout, log `raw` and adjust the field numbers below.
 *
 * FromVCSECMessage {
 *   session_info: SessionInfo [field 5]  ← most common in firmware ~2024.x
 * }
 * SessionInfo {
 *   epoch:      bytes  [field 1]
 *   clock_time: uint32 [field 2]
 *   counter:    uint32 [field 3]
 * }
 *
 * @param {Uint8Array} responseBytes  raw notification payload (after deframing)
 * @returns {{ epoch: Uint8Array, counter: number, clockTime: number }}
 */
export function parseSessionInfoResponse(responseBytes) {
  const outer = decodeProto(responseBytes);

  // Try field 5 first (observed on recent firmware), fall back to 2 and 1.
  const sessionInfoBytes = outer[5] ?? outer[2] ?? outer[1];

  if (!(sessionInfoBytes instanceof Uint8Array)) {
    throw new Error(
      `[Tesla] Could not locate SessionInfo in FromVCSECMessage. ` +
      `Fields present: [${Object.keys(outer).join(', ')}]`,
    );
  }

  const inner = decodeProto(sessionInfoBytes);
  const epoch = inner[1] instanceof Uint8Array ? inner[1] : new Uint8Array(4);
  const clockTime = typeof inner[2] === 'number' ? inner[2] : 0;
  const counter = typeof inner[3] === 'number' ? inner[3] : 0;

  return { epoch, clockTime, counter };
}