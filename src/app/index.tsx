/**
 * Tesla BLE Passive Entry — App.js
 *
 * Two functions:
 *   1. Enroll Key   — sends unauthenticated addKey payload; car prompts NFC tap
 *   2. Passive Mode — continuously scans; if RSSI > -60 dBm, signs and sends
 *                     RKE_UNLOCK via VCSEC with a 30-second cooldown
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, AppState,
} from 'react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';

import {
  getBLEManager,
  destroyBLEManager,
  requestBLEPermissions,
  waitForBLEReady,
  startTeslaScan,
  connectToVehicle,
  disconnectFromVehicle,
  writeAndRead,
  TESLA_SERVICE_UUID,
} from '../ble/BLEManager';

import {
  buildAddKeyMessage,
  buildSessionInfoRequestMessage,
  buildUnlockMessage,
  parseSessionInfoResponse,
  buildUnsignedMessage_RKEUnlock,
} from '../proto/teslaMessages';

import { loadKeys, signVCSECMessage } from '../crypto/CryptoUtils';

// Adjusted paths to reach the root assets folder
const PRIVATE_KEY_ASSET = require('../../assets/private_key.pem');
const PUBLIC_KEY_ASSET  = require('../../assets/public_key.pem');

// ─── Configuration ────────────────────────────────────────────────────────────
const RSSI_THRESHOLD    = -60;   // dBm — only trigger when closer than ~3–5m
const UNLOCK_COOLDOWN   = 30000; // ms — minimum gap between unlock commands
const SCAN_RESTART_DELAY = 2000; // ms — brief pause before restarting scan

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [status, setStatus]         = useState('Idle');
  const [log, setLog]               = useState([]);
  const [passiveActive, setPassiveActive] = useState(false);
  const [isEnrolling, setIsEnrolling]     = useState(false);

  const keysRef            = useRef(null);   // { privateKeyBytes, publicKeyBytes, keyId }
  const stopScanRef        = useRef(null);   // () => void  — stops active scan
  const cooldownRef        = useRef(false);  // true during 30s post-unlock cooldown
  const cooldownTimerRef   = useRef(null);
  const passiveActiveRef   = useRef(false);  // mirror of state for use in callbacks

  const addLog = useCallback((msg) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  // ─── Initialise ──────────────────────────────────────────────────────────

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const granted = await requestBLEPermissions();
        if (!granted) throw new Error('BLE permissions denied');

        await waitForBLEReady();

        // Load PEM files from the asset bundle.
        const [privAsset, pubAsset] = await Asset.loadAsync([PRIVATE_KEY_ASSET, PUBLIC_KEY_ASSET]);

        const privatePem = await FileSystem.readAsStringAsync(privAsset.localUri);
        const publicPem  = await FileSystem.readAsStringAsync(pubAsset.localUri);

        keysRef.current = loadKeys(privatePem, publicPem);

        if (mounted) {
          setStatus('Ready');
          addLog('Keys loaded and verified. BLE adapter ready.');
        }
      } catch (e) {
        if (mounted) {
          setStatus(`Init error: ${e.message}`);
          addLog(`❌ Init: ${e.message}`);
        }
      }
    })();

    // Tear down on unmount.
    return () => {
      mounted = false;
      stopPassiveMode();
      destroyBLEManager();
    };
  }, []);

  // ─── Enroll Key ──────────────────────────────────────────────────────────

  const enrollKey = useCallback(async () => {
    if (!keysRef.current) return Alert.alert('Error', 'Keys not loaded yet');
    if (isEnrolling) return;

    setIsEnrolling(true);
    setStatus('Scanning for vehicle…');
    addLog('Starting key enrollment scan…');

    let device = null;

    try {
      // Find the vehicle.
      device = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          stopScan();
          reject(new Error('Vehicle not found within 20 seconds'));
        }, 20000);

        const stopScan = startTeslaScan({
          onDevice: (d) => {
            clearTimeout(timer);
            stopScan();
            resolve(d);
          },
          allowDuplicates: false,
        });
      });

      addLog(`Found vehicle: ${device.name ?? device.id}`);
      setStatus('Connecting…');

      device = await connectToVehicle(device.id);
      addLog('Connected. Sending addKey payload…');
      setStatus('Sending add-key request…');

      const payload = buildAddKeyMessage(keysRef.current.publicKeyBytes);
      // The add-key message is unauthenticated; the vehicle does not respond
      // with structured data — it displays the NFC prompt on the touchscreen.
      // Write without waiting for a meaningful response.
      await writeAndRead(device, payload).catch(() => {
        // Ignore timeout — car may not send a response for addKey
      });

      setStatus('✅ Awaiting NFC tap on car touchscreen');
      addLog('addKey sent. Ask the driver to tap their NFC Key Card on the car\'s centre console.');

      Alert.alert(
        'Key Enrollment Sent',
        'The car should now be showing a prompt to tap your NFC Key Card. ' +
        'Hold a paired key card on the centre console to authorise this key.',
      );
    } catch (e) {
      addLog(`❌ Enroll failed: ${e.message}`);
      setStatus(`Enrollment failed: ${e.message}`);
    } finally {
      if (device) await disconnectFromVehicle(device.id);
      setIsEnrolling(false);
    }
  }, [isEnrolling, addLog]);

  // ─── Passive Mode ────────────────────────────────────────────────────────

  const startPassiveMode = useCallback(() => {
    if (!keysRef.current) return Alert.alert('Error', 'Keys not loaded yet');
    if (passiveActiveRef.current) return;

    passiveActiveRef.current = true;
    setPassiveActive(true);
    setStatus('Passive mode active — scanning…');
    addLog('Passive proximity mode started.');

    scheduleNextScan();
  }, [addLog]);

  const stopPassiveMode = useCallback(() => {
    passiveActiveRef.current = false;
    setPassiveActive(false);

    if (stopScanRef.current) {
      stopScanRef.current();
      stopScanRef.current = null;
    }
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
    cooldownRef.current = false;
    setStatus('Idle');
    addLog('Passive mode stopped.');
  }, [addLog]);

  const scheduleNextScan = useCallback((delay = 0) => {
    setTimeout(() => {
      if (!passiveActiveRef.current) return;
      runProximityScan();
    }, delay);
  }, []);

  const runProximityScan = useCallback(() => {
    if (!passiveActiveRef.current) return;

    const stopScan = startTeslaScan({
      allowDuplicates: true,
      onDevice: async (device) => {
        const rssi = device.rssi ?? -999;

        if (rssi <= RSSI_THRESHOLD || cooldownRef.current) return;

        // Immediately stop scanning and engage cooldown to prevent
        // re-entrant unlock calls during the connection window.
        stopScan();
        stopScanRef.current = null;
        cooldownRef.current = true;

        addLog(`RSSI ${rssi} dBm > threshold. Initiating unlock…`);
        setStatus(`RSSI ${rssi} dBm — unlocking…`);

        try {
          await performUnlock(device.id);
          addLog('✅ Unlock command sent successfully.');
          setStatus('Unlocked — cooling down…');
        } catch (e) {
          addLog(`❌ Unlock failed: ${e.message}`);
          setStatus(`Unlock failed: ${e.message}`);
        }

        // Start cooldown then resume scanning.
        cooldownTimerRef.current = setTimeout(() => {
          cooldownRef.current = false;
          if (passiveActiveRef.current) {
            setStatus('Passive mode active — scanning…');
            addLog('Cooldown elapsed. Resuming scan.');
            scheduleNextScan();
          }
        }, UNLOCK_COOLDOWN);
      },
    });

    stopScanRef.current = stopScan;
  }, [addLog, scheduleNextScan]);

  const performUnlock = useCallback(async (deviceId) => {
    const { privateKeyBytes, keyId } = keysRef.current;
    let device = null;

    try {
      device = await connectToVehicle(deviceId);
      addLog('Connected for unlock. Requesting session info…');

      // 1. Request session info to get epoch and counter.
      const sessionRequestPayload = buildSessionInfoRequestMessage();
      const sessionResponseBytes  = await writeAndRead(device, sessionRequestPayload);
      const { epoch, counter }    = parseSessionInfoResponse(sessionResponseBytes);

      addLog(`Session: counter=${counter}, epoch=${Buffer.from(epoch).toString('hex')}`);

      // 2. Build and sign the unlock command.
      const expiresAt        = Math.floor(Date.now() / 1000) + 30;
      const unsignedMsgBytes = buildUnsignedMessage_RKEUnlock();

      const signature = signVCSECMessage({
        unsignedMsgBytes,
        privateKeyBytes,
        counter: counter + 1,
        epoch,
        expiresAt,
      });

      // 3. Assemble and send the SignedMessage.
      const unlockPayload = buildUnlockMessage({
        signature,
        keyId,
        counter: counter + 1,
        epoch,
        expiresAt,
      });

      const response = await writeAndRead(device, unlockPayload);
      addLog(`Unlock response (${response.length} bytes) received.`);
    } finally {
      if (device) await disconnectFromVehicle(deviceId);
    }
  }, [addLog]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Tesla Passive Entry</Text>

      <View style={styles.statusBox}>
        <Text style={styles.statusLabel}>Status</Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {/* Enroll Key */}
      <TouchableOpacity
        style={[styles.button, styles.enrollButton, isEnrolling && styles.buttonDisabled]}
        onPress={enrollKey}
        disabled={isEnrolling}
      >
        {isEnrolling
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>🔑  Enroll Key</Text>
        }
      </TouchableOpacity>

      <Text style={styles.hint}>
        Enroll sends your public key to the car. Tap your NFC Key Card on the
        console when prompted to authorise it.
      </Text>

      {/* Passive Mode */}
      <TouchableOpacity
        style={[
          styles.button,
          passiveActive ? styles.stopButton : styles.passiveButton,
        ]}
        onPress={passiveActive ? stopPassiveMode : startPassiveMode}
      >
        <Text style={styles.buttonText}>
          {passiveActive ? '⏹  Stop Passive Mode' : '📡  Start Passive Mode'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        Passive mode scans continuously. When RSSI {'>'} {RSSI_THRESHOLD} dBm, it
        authenticates and sends the unlock command, then waits{' '}
        {UNLOCK_COOLDOWN / 1000}s before scanning again.
      </Text>

      {/* Log */}
      <View style={styles.logContainer}>
        {log.map((entry, i) => (
          <Text key={i} style={styles.logEntry} numberOfLines={2}>
            {entry}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    paddingHorizontal: 24,
    paddingTop: 60,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 20,
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  statusBox: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  statusLabel: {
    fontSize: 11,
    color: '#666',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  statusText: {
    fontSize: 15,
    color: '#e0e0e0',
    fontFamily: 'monospace',
  },
  button: {
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 8,
  },
  enrollButton:  { backgroundColor: '#1e3a5f' },
  passiveButton: { backgroundColor: '#1a4731' },
  stopButton:    { backgroundColor: '#5c1a1a' },
  buttonDisabled:{ opacity: 0.5 },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    color: '#555',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 20,
    textAlign: 'center',
  },
  logContainer: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 12,
  },
  logEntry: {
    color: '#7a9e7a',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 18,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1f1f1f',
    paddingVertical: 3,
  },
});