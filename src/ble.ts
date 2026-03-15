/**
 * Web Bluetooth transport for NaughtBot captcha.
 * Connects to NaughtBot phone as a BLE Central, discovers the captcha
 * GATT service, and exchanges ephemeral keys + encrypted challenge/response
 * without going through the relay.
 *
 * Requires a user gesture to trigger device selection.
 * Only works in secure contexts (HTTPS).
 */

import {
  generateKeyPair,
  deriveRequestKey,
  deriveResponseKey,
  encrypt,
  decrypt,
  requestIdToBytes,
} from "@ackagent/web-sdk";
import { base64urlEncode, base64urlDecode, generateUuid } from "@ackagent/web-sdk";
import type {
  CaptchaOptions,
  CaptchaResult,
  CaptchaSessionState,
  CaptchaChallenge,
  CaptchaResponse,
  SASDisplay,
} from "./types.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";
import type { CaptchaSession } from "./captcha.js";
import {
  fragmentMessage,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_FLAG_FIRST,
  FRAGMENT_FLAG_LAST,
  MAX_REASSEMBLY_BYTES,
} from "./ble-fragmentation.js";

// NaughtBot-specific BLE UUIDs (must match iOS BLECaptchaPeripheralService)
const NAUGHTBOT_SERVICE_UUID = "0a097b07-ca9c-4a5b-8c7d-000000000001";
const REQUEST_CHARACTERISTIC_UUID = "0a097b07-ca9c-4a5b-8c7d-000000000002";
const RESPONSE_CHARACTERISTIC_UUID = "0a097b07-ca9c-4a5b-8c7d-000000000003";

/** Check if Web Bluetooth is supported in this environment */
export function isBLESupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "bluetooth" in navigator &&
    navigator.bluetooth !== undefined &&
    typeof navigator.bluetooth.requestDevice === "function"
  );
}

/**
 * Check if Web Bluetooth is available and enabled.
 * Unlike isBLESupported() (which only checks API presence),
 * this calls getAvailability() to verify the adapter is enabled.
 */
export async function isBLEAvailable(): Promise<boolean> {
  if (!isBLESupported()) return false;
  try {
    return (await navigator.bluetooth?.getAvailability()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Create a BLE-based captcha session.
 * Must be called from a user gesture (click handler) because
 * Web Bluetooth requires a user activation to show the device picker.
 */
export async function createBLESession(options: CaptchaOptions): Promise<CaptchaSession> {
  const { nonce, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!isBLESupported()) {
    throw new Error("Web Bluetooth is not supported in this browser");
  }

  const bluetooth = navigator.bluetooth;
  if (!bluetooth) {
    throw new Error("Web Bluetooth is not available");
  }

  // Request device from user (shows system picker dialog)
  console.debug("[NaughtBot BLE]", "Requesting NaughtBot device...");
  const device = await bluetooth.requestDevice({
    filters: [{ services: [NAUGHTBOT_SERVICE_UUID] }],
  });

  console.debug("[NaughtBot BLE]", "Device selected:", device.name);

  const sessionId = generateUuid();
  const requestIdBytes = requestIdToBytes(sessionId);
  const ephemeralKeyPair = await generateKeyPair();

  let currentState: CaptchaSessionState = "initializing";
  let currentSas: SASDisplay | null = null;
  let cancelled = false;
  let cancelNotification: (() => void) | null = null;
  const stateCallbacks: Array<(state: CaptchaSessionState, sas: SASDisplay | null) => void> = [];

  function setState(newState: CaptchaSessionState, sas?: SASDisplay | null) {
    currentState = newState;
    if (sas !== undefined) currentSas = sas;
    for (const cb of stateCallbacks) cb(currentState, currentSas);
  }

  const session: CaptchaSession = {
    get sessionId() {
      return sessionId;
    },
    get qrCodeUrl() {
      return ""; // No QR code for BLE sessions
    },
    get state() {
      return currentState;
    },
    get sas() {
      return currentSas;
    },

    async waitForResult(): Promise<CaptchaResult> {
      const domain = typeof window !== "undefined" ? window.location.hostname : "unknown";
      const deadline = Date.now() + timeoutMs;

      // Connect to GATT server
      setState("waiting_for_scan"); // "waiting for connection"
      console.debug("[NaughtBot BLE]", "Connecting to GATT server...");
      if (!device.gatt) {
        throw new Error("GATT server not available");
      }
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(NAUGHTBOT_SERVICE_UUID);
      const requestChar = await service.getCharacteristic(REQUEST_CHARACTERISTIC_UUID);
      const responseChar = await service.getCharacteristic(RESPONSE_CHARACTERISTIC_UUID);
      await responseChar.startNotifications();

      setState("phone_connected");
      console.debug("[NaughtBot BLE]", "Connected and notifications started");

      // Register notification listener BEFORE writing to avoid missing the response
      const connectMsg = JSON.stringify({
        type: "connect",
        sessionId,
        ephemeralPublicKey: base64urlEncode(ephemeralKeyPair.publicKey),
      });
      const phoneResponsePromise = waitForNotification(
        responseChar,
        deadline - Date.now(),
        () => cancelled,
        (fn) => {
          cancelNotification = fn;
        },
      );
      await writeFragmented(requestChar, new TextEncoder().encode(connectMsg));

      // Wait for phone's ephemeral public key (via notification)
      const phoneResponse = await phoneResponsePromise;
      cancelNotification = null;
      const phoneData = JSON.parse(new TextDecoder().decode(phoneResponse));

      if (!phoneData.ephemeralPublicKey) {
        throw new Error("Phone did not send ephemeral public key");
      }
      const phonePublicKey = base64urlDecode(phoneData.ephemeralPublicKey);

      // Build and encrypt challenge
      const challenge: CaptchaChallenge = {
        type: "captcha",
        domain,
        nonce,
        timestamp: Date.now(),
      };
      const challengeBytes = new TextEncoder().encode(JSON.stringify(challenge));
      const requestKey = await deriveRequestKey(
        ephemeralKeyPair.privateKey,
        phonePublicKey,
        requestIdBytes,
      );
      const { ciphertext, nonce: encNonce } = encrypt(requestKey, challengeBytes, requestIdBytes);

      // Register notification listener BEFORE writing to avoid missing the response
      const challengeMsg = JSON.stringify({
        type: "challenge",
        sessionId,
        encryptedChallenge: base64urlEncode(ciphertext),
        challengeNonce: base64urlEncode(encNonce),
      });
      const responsePromise = waitForNotification(
        responseChar,
        deadline - Date.now(),
        () => cancelled,
        (fn) => {
          cancelNotification = fn;
        },
      );
      await writeFragmented(requestChar, new TextEncoder().encode(challengeMsg));
      setState("verifying");
      console.debug("[NaughtBot BLE]", "Challenge sent, waiting for response...");

      // Wait for encrypted response
      const responseData = await responsePromise;
      cancelNotification = null;

      if (cancelled) throw new Error("Session cancelled");

      const encResponse = JSON.parse(new TextDecoder().decode(responseData));

      // Decrypt response
      const responseKey = await deriveResponseKey(
        ephemeralKeyPair.privateKey,
        phonePublicKey,
        requestIdBytes,
      );
      const decrypted = decrypt(
        responseKey,
        base64urlDecode(encResponse.responseNonce),
        base64urlDecode(encResponse.encryptedResponse),
        requestIdBytes,
      );
      const response: CaptchaResponse = JSON.parse(new TextDecoder().decode(decrypted));

      // Disconnect
      server.disconnect();

      if (!response.approved) {
        setState("error");
        throw new Error("Verification declined by user");
      }

      const result: CaptchaResult = {
        proof: response.attestation
          ? base64urlEncode(new TextEncoder().encode(JSON.stringify(response.attestation)))
          : "",
        nonce,
        domain,
      };

      setState("verified");
      console.debug("[NaughtBot BLE]", "BLE verification complete");
      return result;
    },

    confirmSAS() {
      // No-op — BLE mode skips SAS verification
    },

    cancel() {
      cancelled = true;
      cancelNotification?.();
      cancelNotification = null;
      setState("error");
      if (device.gatt?.connected) {
        device.gatt.disconnect();
      }
    },

    onStateChange(callback) {
      stateCallbacks.push(callback);
    },
  };

  return session;
}

// --- BLE Fragmentation (matching AckAgent protocol) ---

/** Write data to a characteristic using BLE fragmentation */
async function writeFragmented(
  characteristic: BluetoothRemoteGATTCharacteristic,
  data: Uint8Array,
): Promise<void> {
  const fragments = fragmentMessage(data);
  for (const fragment of fragments) {
    await characteristic.writeValue(
      fragment.buffer.slice(
        fragment.byteOffset,
        fragment.byteOffset + fragment.byteLength,
      ) as ArrayBuffer,
    );
  }
}

/** Wait for a complete fragmented notification */
function waitForNotification(
  characteristic: BluetoothRemoteGATTCharacteristic,
  timeoutMs: number,
  isCancelled: () => boolean,
  onCleanup?: (cleanup: () => void) => void,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const fragments = new Map<number, Uint8Array>();
    let expectedNext = 0;
    let started = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const handler = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      const value = target.value;
      if (!value) return;

      const raw = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (raw.length < FRAGMENT_HEADER_SIZE) return;

      const flags = raw[0];
      const seq = raw[1];
      const payload = raw.slice(FRAGMENT_HEADER_SIZE);

      if (flags & FRAGMENT_FLAG_FIRST) {
        fragments.clear();
        started = true;
        expectedNext = 0;
      }

      if (!started || seq !== expectedNext) return;

      fragments.set(seq, payload);
      expectedNext = (expectedNext + 1) & 0xff;

      // Check total reassembled size
      let currentSize = 0;
      for (const p of fragments.values()) currentSize += p.length;
      if (currentSize > MAX_REASSEMBLY_BYTES) {
        clearTimeout(timeoutId);
        characteristic.removeEventListener("characteristicvaluechanged", handler);
        reject(new Error("BLE message exceeds maximum size"));
        return;
      }

      if (flags & FRAGMENT_FLAG_LAST) {
        clearTimeout(timeoutId);
        characteristic.removeEventListener("characteristicvaluechanged", handler);

        let totalSize = 0;
        for (const p of fragments.values()) totalSize += p.length;
        const result = new Uint8Array(totalSize);
        let off = 0;
        for (let s = 0; s < expectedNext; s++) {
          const p = fragments.get(s);
          if (p) {
            result.set(p, off);
            off += p.length;
          }
        }

        console.debug(
          "[NaughtBot BLE]",
          `Reassembled ${expectedNext} fragments (${totalSize} bytes)`,
        );
        resolve(result);
      }
    };

    characteristic.addEventListener("characteristicvaluechanged", handler);

    timeoutId = setTimeout(() => {
      characteristic.removeEventListener("characteristicvaluechanged", handler);
      if (isCancelled()) {
        reject(new Error("Session cancelled"));
      } else {
        reject(new Error("BLE response timeout"));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutId);
      characteristic.removeEventListener("characteristicvaluechanged", handler);
      reject(new Error("Session cancelled"));
    };

    onCleanup?.(cleanup);
  });
}

// Web Bluetooth type declarations (experimental API, not in standard TS lib)
interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly value?: DataView;
  writeValue(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  removeEventListener(type: string, listener: EventListener): void;
}
