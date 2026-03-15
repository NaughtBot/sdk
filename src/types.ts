/**
 * Type definitions for NaughtBot captcha sessions.
 */

/** Options for creating a captcha session */
export interface CaptchaOptions {
  /** Server-generated nonce for replay protection */
  nonce: string;

  /** Relay server URL (e.g., "https://relay.naughtbot.com"). Required for QR mode. */
  relayUrl?: string;

  /** Login/identity service URL for QR code links (e.g., "https://login.naughtbot.com") */
  loginUrl?: string;

  /** Transport mode */
  mode?: "qr" | "ble" | "auto";

  /** Session timeout in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;
}

/** Options for the captcha widget */
export interface CaptchaWidgetOptions extends CaptchaOptions {
  /** Callback when verification completes successfully */
  onVerified: (result: CaptchaResult) => void | Promise<void>;

  /** Callback when an error occurs */
  onError?: (error: Error) => void;

  /** Callback when the session expires */
  onExpired?: () => void;

  /** Callback when session state changes */
  onStateChange?: (state: CaptchaSessionState) => void;
}

/** Result of a successful captcha verification */
export interface CaptchaResult {
  /** BBS+ anonymous proof (base64url) */
  proof: string;

  /** Original nonce (for server-side correlation) */
  nonce: string;

  /** Domain that was verified (e.g., "example.com") */
  domain: string;
}

/** State of a captcha session */
export type CaptchaSessionState =
  | "initializing"
  | "waiting_for_scan"
  | "phone_connected"
  | "sas_verification"
  | "verifying"
  | "verified"
  | "expired"
  | "error";

/** SAS (Short Authentication String) for visual verification */
export interface SASDisplay {
  words: string[];
  emojis: string[];
  wordString: string;
  emojiString: string;
}

/** Internal: captcha challenge sent from browser to phone */
export interface CaptchaChallenge {
  type: "captcha";
  domain: string;
  nonce: string;
  timestamp: number;
}

/** Internal: captcha response from phone to browser */
export interface CaptchaResponse {
  approved: boolean;
  plaintextHash?: string;
  attestation?: {
    "@context": string[];
    type: string[];
    proof: {
      type: string;
      cryptosuite: string;
      proofValue: string;
      created?: string;
      verificationMethod?: string;
      proofPurpose?: string;
    };
    ackagentAnonymousAttestation: {
      pseudonym: string;
      scope: string;
      presentationHeader: string;
      revealedMessages: {
        attestationType: string;
        deviceType: string;
        expiresAt: number;
      };
      issuerPublicKeyId: string;
    };
  };
}

/** Default timeout for captcha sessions (5 minutes) */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Default login URL for QR code links */
export const DEFAULT_LOGIN_URL = "https://login.naughtbot.com";
