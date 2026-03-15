/**
 * Client-side BBS+ proof verification for captcha results.
 *
 * This provides a convenience wrapper around @ackagent/web-sdk's BBS+ verification
 * for verifying NaughtBot captcha proofs in the browser. Server-side verification
 * is recommended for production use.
 */

import { verifyBbsProofWithPseudonym, base64urlDecode, base64urlEncode } from "@ackagent/web-sdk";

import type { CaptchaResult } from "./types.js";

/** Total number of signer messages in BBS+ credential */
const BBS_TOTAL_SIGNER_MESSAGES = 4;

/** Logger interface for server-side verification */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Options for verifyCaptchaProof */
export interface VerifyOptions {
  /** Issuer public key for BBS+ verification */
  issuerPublicKey: IssuerPublicKey;

  /** Expected domain for domain-binding check */
  expectedDomain?: string;

  /** Logger instance (defaults to console) */
  logger?: Logger;
}

/** Issuer public key for verifying BBS+ proofs */
export interface IssuerPublicKey {
  /** Key ID matching the proof's issuerPublicKeyId */
  keyId: string;

  /** BLS12-381 G2 public key (96 bytes, base64url) */
  publicKey: string;
}

/** Result of verifying a captcha proof */
export interface VerificationResult {
  /** Whether the proof is valid */
  valid: boolean;

  /** Error message if verification failed */
  error?: string;

  /** Revealed attestation attributes */
  attestation?: {
    attestationType: string;
    deviceType: string;
    expiresAt: number;
  };
}

/**
 * Verify a NaughtBot captcha proof.
 *
 * This performs server-side verification of the BBS+ anonymous attestation
 * included in the captcha result.
 *
 * @param result - The captcha result to verify
 * @param options - Verification options (issuer key, expected domain, logger)
 * @returns Verification result
 */
export async function verifyCaptchaProof(
  result: CaptchaResult,
  options: VerifyOptions,
): Promise<VerificationResult> {
  const { issuerPublicKey, expectedDomain, logger = console } = options;

  if (!result.proof) {
    return { valid: false, error: "No proof in captcha result" };
  }

  try {
    // Decode the attestation from the proof field
    logger.debug("[NaughtBot]", "Decoding proof for nonce:", result.nonce);
    const attestationJson = new TextDecoder().decode(base64urlDecode(result.proof));
    const attestation = JSON.parse(attestationJson);

    const payload = attestation.ackagentAnonymousAttestation;
    if (!payload) {
      return { valid: false, error: "Missing ackagentAnonymousAttestation in proof" };
    }

    // Verify the issuer key ID matches
    if (payload.issuerPublicKeyId !== issuerPublicKey.keyId) {
      return {
        valid: false,
        error: `Issuer key mismatch: expected ${issuerPublicKey.keyId}, got ${payload.issuerPublicKeyId}`,
      };
    }

    // Verify scope is non-empty (it should be the sessionId)
    if (!payload.scope) {
      return { valid: false, error: "Missing scope in attestation" };
    }

    // Verify domain if expected domain is provided
    // Domain binding comes from the presentation header (challenge-bound), not the scope
    if (expectedDomain && result.domain !== expectedDomain) {
      return {
        valid: false,
        error: `Domain mismatch: expected ${expectedDomain}, got ${result.domain}`,
      };
    }

    // Verify BBS+ proof with pseudonym
    const proofValue = attestation.proof?.proofValue;
    if (!proofValue) {
      return { valid: false, error: "Missing proofValue in attestation" };
    }

    // Strip multibase "u" prefix from proofValue (iOS produces "u" + base64url(proof))
    const rawProofValue = proofValue.startsWith("u") ? proofValue.slice(1) : proofValue;

    // Build disclosed messages map from revealed attributes
    // Signer indices: 0=attestationType, 1=deviceType, 3=expiresAt
    const disclosed = payload.revealedMessages;
    const disclosedMessages = new Map<number, Uint8Array>();
    if (disclosed.attestationType) {
      disclosedMessages.set(0, new TextEncoder().encode(disclosed.attestationType));
    }
    if (disclosed.deviceType) {
      disclosedMessages.set(1, new TextEncoder().encode(disclosed.deviceType));
    }
    if (disclosed.expiresAt) {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigInt64(0, BigInt(disclosed.expiresAt));
      disclosedMessages.set(3, new Uint8Array(buf));
    }

    // Recompute expected presentation header from result nonce + domain
    // This binds the proof to the specific challenge (sha256(nonce || 0x00 || domain))
    const phMessage = new Uint8Array([
      ...new TextEncoder().encode(result.nonce),
      0x00,
      ...new TextEncoder().encode(result.domain),
    ]);
    const phDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", phMessage));
    // iOS passes base64urlEncode(digest) as a String to generateRelayAuthProof,
    // which UTF-8 encodes it internally. Match that encoding here.
    const phBytes = new TextEncoder().encode(base64urlEncode(phDigest));

    const bbsResult = await verifyBbsProofWithPseudonym(
      base64urlDecode(issuerPublicKey.publicKey),
      base64urlDecode(rawProofValue),
      base64urlDecode(payload.pseudonym),
      new TextEncoder().encode("ackagent-anonymous-attestation-v2"),
      phBytes,
      new TextEncoder().encode(payload.scope),
      disclosedMessages,
      BBS_TOTAL_SIGNER_MESSAGES,
      new Map(), // disclosed committed messages
      [], // disclosed commitment indices
    );

    logger.debug("[NaughtBot]", "BBS+ verification result:", bbsResult.verified);

    if (!bbsResult.verified) {
      return { valid: false, error: bbsResult.error || "BBS+ proof verification failed" };
    }

    // Check credential expiry
    const revealed = payload.revealedMessages;
    if (revealed.expiresAt && revealed.expiresAt < Math.floor(Date.now() / 1000)) {
      logger.debug("[NaughtBot]", "Credential expired at:", revealed.expiresAt);
      return { valid: false, error: "Credential has expired" };
    }

    logger.debug("[NaughtBot]", "Proof verified successfully");
    return {
      valid: true,
      attestation: {
        attestationType: revealed.attestationType,
        deviceType: revealed.deviceType,
        expiresAt: revealed.expiresAt,
      },
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Verification failed",
    };
  }
}
