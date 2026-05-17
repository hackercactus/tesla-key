/**
 * BLE Manager for Tesla passive entry.
 *
 * Protocol framing (Tesla BLE spec):
 *   Write path:  [ length_high, length_low, ...proto_bytes ]
 *                chunked into (negotiatedMTU - 3 - 1) byte payloads,
 *                each chunk prefixed with a 1-byte header:
 *                  0x02 = first chunk
 *                  0x00 = middle chunk
 *                  0x01 = last chunk
 *                  0x03 = only chunk (first + last)
 *
 *   Read path:   notifications arrive with the same framing; reassemble
 *                before passing to protobuf decoder.
 */

import { BleManager, State } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { Buffer } from 'buffer';

// ─── Constants ───────────────────────────────────────────────────────────────

export const TESLA_SERVICE_UUID  = '00000211-b2d1-43f0-9b88-960cebf8b91e';
export const WRITE_CHAR_UUID     = '00000212-b2d1-43f0-9b88-960cebf8b91e';
export const READ_CHAR_UUID      = '00000213-b2d1-43f0-9b88-960cebf8b91e';

const TARGET_MTU      = 512;  // Negotiate maximum; stack will cap at device limit
const ATT_OVERHEAD    = 3;    // ATT protocol overhead per packet
const FRAME_HEADER    = 1;    // Our 1-byte chunk header
const CONNECT_TIMEOUT = 15000;
const RESPONSE_TIMEOUT = 10000;

// ─── Singleton BLE manager ────────────────────────────────────────────────────

let _bleManager = null;

export function getBLEManager() {
  if (!_bleManager) _bleManager = new BleManager();
  return _bleManager;
}

export function destroyBLEManager() {
  if (_bleManager) {
    _bleManager.destroy();
    _bleManager = null;
  }
}

// ─── Permissions ─────────────────────────────────────────────────────────────

/**
 * Request BLE permissions on Android. On iOS, the system dialog fires
 * automatically when BLE is first used; no runtime permission call needed.
 */
export async function requestBLEPermissions() {
  if (Platform.OS !== 'android') return true;

  const grants = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);

  return Object.values(grants).every(
    (r) => r === PermissionsAndroid.RESULTS.GRANTED,
  );
}

/**
 * Wait for the BLE adapter to be powered on.
 * @param {number} timeoutMs
 */
export async function waitForBLEReady(timeoutMs = 10000) {
  const manager = getBLEManager();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('BLE adapter timeout')),
      timeoutMs,
    );

    const sub = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        clearTimeout(timer);
        sub.remove();
        resolve();
      } else if (state === State.Unsupported || state === State.Unauthorized) {
        clearTimeout(timer);
        sub.remove();
        reject(new Error(`BLE not available: ${state}`));
      }
    }, true);
  });
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

/**
 * Scan for Tesla vehicles advertising the vehicle-command service.
 *
 * @param {object} opts
 * @param {(device: object) => void} opts.onDevice   called for each discovered device
 * @param {boolean} [opts.allowDuplicates=true]       set false for battery efficiency
 * @returns {() => void}  call to stop scanning
 */
export function startTeslaScan({ onDevice, allowDuplicates = true }) {
  const manager = getBLEManager();

  manager.startDeviceScan(
    [TESLA_SERVICE_UUID],
    { allowDuplicates },
    (error, device) => {
      if (error) {
        console.error('[BLE] Scan error:', error.message);
        return;
      }
      if (device) onDevice(device);
    },
  );

  return () => manager.stopDeviceScan();
}

// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * Connect to a Tesla BLE peripheral, negotiate MTU, and discover all
 * services and characteristics. Returns the connected device object.
 *
 * @param {string} deviceId
 * @returns {Promise<Device>}
 */
export async function connectToVehicle(deviceId) {
  const manager = getBLEManager();

  let device = await Promise.race([
    manager.connectToDevice(deviceId, { autoConnect: false }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), CONNECT_TIMEOUT),
    ),
  ]);

  // Request a large MTU to avoid excessive chunking.
  try {
    device = await device.requestMTU(TARGET_MTU);
  } catch (_) {
    // MTU negotiation failure is non-fatal; fall through with default MTU.
  }

  await device.discoverAllServicesAndCharacteristics();
  return device;
}

/**
 * Safely disconnect from a device if it is still connected.
 */
export async function disconnectFromVehicle(deviceId) {
  try {
    const manager = getBLEManager();
    const connected = await manager.isDeviceConnected(deviceId);
    if (connected) await manager.cancelDeviceConnection(deviceId);
  } catch (e) {
    console.warn('[BLE] Disconnect error (may already be disconnected):', e.message);
  }
}

// ─── Framing ──────────────────────────────────────────────────────────────────

/**
 * Frame a raw protobuf message for BLE transmission and return an array
 * of BLE packets, each ready to write as a single ATT Write command.
 *
 * @param {Uint8Array} protoBytes
 * @param {number}     mtu         negotiated ATT MTU (default 23, min BLE 4.0)
 * @returns {Uint8Array[]}
 */
export function frameMessage(protoBytes, mtu = 23) {
  const payloadPerChunk = mtu - ATT_OVERHEAD - FRAME_HEADER;

  // Prepend 2-byte big-endian total length.
  const lengthPrefix = new Uint8Array(2);
  new DataView(lengthPrefix.buffer).setUint16(0, protoBytes.length, false);

  const framed = new Uint8Array(2 + protoBytes.length);
  framed.set(lengthPrefix, 0);
  framed.set(protoBytes, 2);

  const packets = [];
  let offset = 0;
  const totalLength = framed.length;

  while (offset < totalLength) {
    const isFirst = offset === 0;
    const chunk = framed.slice(offset, offset + payloadPerChunk);
    offset += chunk.length;
    const isLast = offset >= totalLength;

    let header = 0x00;
    if (isFirst) header |= 0x02;
    if (isLast)  header |= 0x01;

    const packet = new Uint8Array(1 + chunk.length);
    packet[0] = header;
    packet.set(chunk, 1);
    packets.push(packet);
  }

  return packets;
}

/**
 * Reassemble chunked BLE notification data into a raw protobuf payload.
 * Strips both the chunk headers and the 2-byte length prefix.
 *
 * Call this with the accumulated raw notification bytes, not individual chunks.
 *
 * @param {Uint8Array[]} chunks  ordered array of raw notification payloads
 * @returns {Uint8Array}        deframed protobuf bytes
 */
export function deframeChunks(chunks) {
  // Strip the 1-byte header from each chunk and concatenate payload bytes.
  const payloadParts = chunks.map((c) => c.slice(1));
  const totalLen = payloadParts.reduce((n, p) => n + p.length, 0);

  const assembled = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of payloadParts) {
    assembled.set(part, offset);
    offset += part.length;
  }

  // Strip the 2-byte length prefix.
  const expectedLen = new DataView(assembled.buffer).getUint16(0, false);
  const proto = assembled.slice(2, 2 + expectedLen);

  if (proto.length < expectedLen) {
    console.warn(`[BLE] Deframe: expected ${expectedLen} bytes, got ${proto.length}`);
  }

  return proto;
}

// ─── Write + Read ─────────────────────────────────────────────────────────────

/**
 * Write a protobuf payload to the Tesla write characteristic and wait for
 * a notification on the read characteristic.
 *
 * @param {Device}     device
 * @param {Uint8Array} protoBytes
 * @returns {Promise<Uint8Array>}  deframed response protobuf bytes
 */
export async function writeAndRead(device, protoBytes) {
  // Determine actual negotiated MTU from the device object (ble-plx exposes this).
  const mtu = device.mtu ?? 23;
  const packets = frameMessage(protoBytes, mtu);

  // Set up the notification listener BEFORE writing to avoid a race condition.
  const responsePromise = new Promise((resolve, reject) => {
    const accumulator = [];
    const timer = setTimeout(
      () => reject(new Error('BLE response timeout')),
      RESPONSE_TIMEOUT,
    );

    const subscription = device.monitorCharacteristicForService(
      TESLA_SERVICE_UUID,
      READ_CHAR_UUID,
      (error, characteristic) => {
        if (error) {
          clearTimeout(timer);
          subscription.remove();
          reject(error);
          return;
        }

        const chunk = Buffer.from(characteristic.value, 'base64');
        const header = chunk[0];
        accumulator.push(new Uint8Array(chunk));

        const isLast = (header & 0x01) !== 0;
        if (isLast) {
          clearTimeout(timer);
          subscription.remove();
          try {
            resolve(deframeChunks(accumulator));
          } catch (e) {
            reject(e);
          }
        }
      },
    );
  });

  // Write each packet sequentially. WriteWithResponse ensures ordering.
  for (const packet of packets) {
    const b64 = Buffer.from(packet).toString('base64');
    await device.writeCharacteristicWithResponseForService(
      TESLA_SERVICE_UUID,
      WRITE_CHAR_UUID,
      b64,
    );
  }

  return responsePromise;
}