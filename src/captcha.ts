/**
 * Core captcha session logic.
 *
 * Handles ephemeral key generation, QR code URL creation, relay polling,
 * E2E encrypted challenge/response exchange, and SAS computation.
 */

import {
  generateKeyPair,
  deriveRequestKey,
  deriveResponseKey,
  encrypt,
  decrypt,
  requestIdToBytes,
} from "@ackagent/web-sdk";
import { base64urlEncode } from "@ackagent/web-sdk";
import { computeSAS, type SASApproverKey } from "@ackagent/web-sdk";
import type {
  CaptchaOptions,
  CaptchaResult,
  CaptchaSessionState,
  CaptchaChallenge,
  CaptchaResponse,
  SASDisplay,
} from "./types.js";
import { DEFAULT_TIMEOUT_MS, DEFAULT_LOGIN_URL } from "./types.js";

/** Polling interval for checking phone connection (ms) */
const POLL_INTERVAL_MS = 1_500;

/** Captcha session — manages the ephemeral E2E encrypted session with the phone */
export interface CaptchaSession {
  /** Unique session ID */
  readonly sessionId: string;

  /** URL to encode as QR code */
  readonly qrCodeUrl: string;

  /** Current session state */
  readonly state: CaptchaSessionState;

  /** SAS words/emojis (available after phone connects) */
  readonly sas: SASDisplay | null;

  /** Wait for the captcha result (resolves on approval, rejects on error/timeout) */
  waitForResult(): Promise<CaptchaResult>;

  /**
   * Confirm SAS match — unblocks challenge sending.
   * In BLE mode, the browser user must call this after visually confirming the SAS.
   * In QR mode, SAS confirmation happens on the phone side, so this is a no-op.
   */
  confirmSAS(): void;

  /** Cancel the session */
  cancel(): void;

  /** Subscribe to state changes */
  onStateChange(callback: (state: CaptchaSessionState, sas: SASDisplay | null) => void): void;
}

/** Create a new captcha session */
export async function createSession(options: CaptchaOptions): Promise<CaptchaSession> {
  const { nonce, relayUrl, loginUrl = DEFAULT_LOGIN_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!relayUrl) {
    throw new Error("relayUrl is required for QR mode");
  }

  // Generate ephemeral P-256 key pair (not persisted)
  const ephemeralKeyPair = await generateKeyPair();

  let currentState: CaptchaSessionState = "initializing";
  let currentSas: SASDisplay | null = null;
  let cancelled = false;
  const stateCallbacks: Array<(state: CaptchaSessionState, sas: SASDisplay | null) => void> = [];

  function setState(newState: CaptchaSessionState, sas?: SASDisplay | null) {
    currentState = newState;
    if (sas !== undefined) {
      currentSas = sas;
    }
    for (const cb of stateCallbacks) {
      cb(currentState, currentSas);
    }
  }

  // Create session on relay — server generates session ID
  const sessionResult = await createRelaySession(relayUrl, ephemeralKeyPair.publicKey);
  if (!sessionResult) {
    setState("error");
    throw new Error("Failed to create captcha session on relay");
  }

  const sessionId = sessionResult.sessionId;
  const requestIdBytes = requestIdToBytes(sessionId);

  console.debug("[NaughtBot]", "Session created:", sessionId);

  // Build QR code URL using server-returned session ID
  const publicKeyB64 = base64urlEncode(ephemeralKeyPair.publicKey);
  const qrCodeUrl = `${loginUrl}/link/captcha?sid=${sessionId}&pk=${publicKeyB64}`;

  console.debug("[NaughtBot]", "QR URL:", qrCodeUrl);

  setState("waiting_for_scan");

  const session: CaptchaSession = {
    get sessionId() {
      return sessionId;
    },
    get qrCodeUrl() {
      return qrCodeUrl;
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

      // Phase 1: Poll for phone connection (phone posts its ephemeral public key)
      const phonePublicKey = await pollForPhoneConnection(
        relayUrl,
        sessionId,
        deadline,
        () => cancelled,
      );

      if (cancelled) throw new Error("Session cancelled");

      setState("phone_connected");

      // Compute SAS from both public keys
      const approverKey: SASApproverKey = {
        encryptionPublicKeyHex: hexEncode(phonePublicKey),
        publicKey: phonePublicKey,
      };
      const sasResult = computeSAS(ephemeralKeyPair.publicKey, [approverKey]);

      setState("sas_verification", sasResult);
      console.debug("[NaughtBot]", "SAS:", sasResult.wordString);

      // Phase 1.5: Wait for phone to confirm SAS match (relay-mediated)
      await pollForSASConfirmation(relayUrl, sessionId, deadline, () => cancelled);
      if (cancelled) throw new Error("Session cancelled");

      // Phase 2: Send encrypted captcha challenge
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

      await postEncryptedChallenge(relayUrl, sessionId, ciphertext, encNonce);

      setState("verifying");

      // Phase 3: Poll for encrypted response
      const encryptedResponse = await pollForResponse(
        relayUrl,
        sessionId,
        deadline,
        () => cancelled,
      );

      if (cancelled) throw new Error("Session cancelled");

      // Decrypt response (fields are hex-encoded from relay)
      const responseKey = await deriveResponseKey(
        ephemeralKeyPair.privateKey,
        phonePublicKey,
        requestIdBytes,
      );
      const decrypted = decrypt(
        responseKey,
        hexDecodeBytes(encryptedResponse.nonce),
        hexDecodeBytes(encryptedResponse.ciphertext),
        requestIdBytes,
      );
      const response: CaptchaResponse = JSON.parse(new TextDecoder().decode(decrypted));

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
      console.debug("[NaughtBot]", "Verification complete");
      return result;
    },

    confirmSAS() {
      // No-op for QR mode — SAS confirmation happens on the phone side
    },

    cancel() {
      cancelled = true;
      setState("error");
    },

    onStateChange(callback) {
      stateCallbacks.push(callback);
    },
  };

  return session;
}

// --- Relay communication helpers ---
// All endpoints target the naughtbot-relay service (separate from AckAgent relay).
// Session creation is IP rate-limited; all other endpoints are unauthenticated.
// Phone-initiated endpoints (connect, confirm-sas, respond) use BBS+ anonymous auth.

/** Create a captcha session on the naughtbot-relay server */
async function createRelaySession(
  relayUrl: string,
  ephemeralPublicKey: Uint8Array,
): Promise<{ sessionId: string } | null> {
  try {
    const response = await fetch(`${relayUrl}/api/v1/captcha-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requesterEphemeralKeyHex: hexEncode(ephemeralPublicKey),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.debug("[NaughtBot]", "Failed to create session:", response.status, body);
      return null;
    }

    const data = await response.json();
    return { sessionId: data.sessionId };
  } catch (error) {
    console.debug("[NaughtBot]", "Error creating session:", error);
    return null;
  }
}

/** Poll relay for phone connection (phone's ephemeral public key) */
async function pollForPhoneConnection(
  relayUrl: string,
  sessionId: string,
  deadline: number,
  isCancelled: () => boolean,
): Promise<Uint8Array> {
  while (Date.now() < deadline && !isCancelled()) {
    try {
      const response = await fetch(`${relayUrl}/api/v1/captcha-sessions/${sessionId}`);

      if (response.ok) {
        const data = await response.json();
        if (data.approverEphemeralKeyHex) {
          console.debug("[NaughtBot]", "Phone connected");
          return hexDecodeBytes(data.approverEphemeralKeyHex);
        }
      }
    } catch {
      // Network error, retry
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (isCancelled()) {
    throw new Error("Session cancelled");
  }
  throw new Error("Session expired waiting for phone connection");
}

/** Poll relay until phone confirms SAS match */
async function pollForSASConfirmation(
  relayUrl: string,
  sessionId: string,
  deadline: number,
  isCancelled: () => boolean,
): Promise<void> {
  while (Date.now() < deadline && !isCancelled()) {
    try {
      const response = await fetch(`${relayUrl}/api/v1/captcha-sessions/${sessionId}`);

      if (response.ok) {
        const data = await response.json();
        if (
          data.status === "sas_confirmed" ||
          data.status === "challenged" ||
          data.status === "responded"
        ) {
          console.debug("[NaughtBot]", "Phone confirmed SAS match");
          return;
        }
      }
    } catch {
      // Network error, retry
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (isCancelled()) {
    throw new Error("Session cancelled");
  }
  throw new Error("Session expired waiting for SAS confirmation");
}

/** Post encrypted captcha challenge to relay */
async function postEncryptedChallenge(
  relayUrl: string,
  sessionId: string,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Promise<void> {
  const response = await fetch(`${relayUrl}/api/v1/captcha-sessions/${sessionId}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encryptedChallenge: hexEncode(ciphertext),
      challengeNonce: hexEncode(nonce),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post challenge: ${response.status}`);
  }

  console.debug("[NaughtBot]", "Challenge posted");
}

/** Poll unified status endpoint for encrypted response from phone */
async function pollForResponse(
  relayUrl: string,
  sessionId: string,
  deadline: number,
  isCancelled: () => boolean,
): Promise<{ ciphertext: string; nonce: string }> {
  while (Date.now() < deadline && !isCancelled()) {
    try {
      const response = await fetch(`${relayUrl}/api/v1/captcha-sessions/${sessionId}`);

      if (response.ok) {
        const data = await response.json();
        if (data.status === "responded" && data.encryptedResponse && data.responseNonce) {
          console.debug("[NaughtBot]", "Response received");
          return {
            ciphertext: data.encryptedResponse,
            nonce: data.responseNonce,
          };
        }
      }
    } catch {
      // Network error, retry
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (isCancelled()) {
    throw new Error("Session cancelled");
  }
  throw new Error("Session expired waiting for response");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hex-encode bytes (lowercase) */
export function hexEncode(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex-decode string to bytes */
function hexDecodeBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
