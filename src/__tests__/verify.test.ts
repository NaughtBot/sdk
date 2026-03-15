import { describe, expect, it, vi } from "vitest";
import { verifyCaptchaProof } from "../verify.js";
import type { CaptchaResult } from "../types.js";
import type { IssuerPublicKey, Logger } from "../verify.js";

const dummyIssuerKey: IssuerPublicKey = {
  keyId: "test-key-001",
  publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("verifyCaptchaProof", () => {
  it("returns invalid when proof is empty", async () => {
    const result: CaptchaResult = {
      proof: "",

      nonce: "test-nonce",
      domain: "example.com",
    };

    const verification = await verifyCaptchaProof(result, { issuerPublicKey: dummyIssuerKey });
    expect(verification.valid).toBe(false);
    expect(verification.error).toBe("No proof in captcha result");
  });

  it("returns invalid when proof is malformed JSON", async () => {
    // base64url encode some non-JSON data
    const proof = btoa("not-json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    const result: CaptchaResult = {
      proof,

      nonce: "test-nonce",
      domain: "example.com",
    };

    const verification = await verifyCaptchaProof(result, { issuerPublicKey: dummyIssuerKey });
    expect(verification.valid).toBe(false);
    expect(verification.error).toBeDefined();
  });

  it("returns invalid when attestation missing ackagentAnonymousAttestation", async () => {
    const attestation = { proof: { proofValue: "abc" } };
    const proof = btoa(JSON.stringify(attestation))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const result: CaptchaResult = {
      proof,

      nonce: "test-nonce",
      domain: "example.com",
    };

    const verification = await verifyCaptchaProof(result, { issuerPublicKey: dummyIssuerKey });
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain("Missing ackagentAnonymousAttestation");
  });

  it("passes custom logger through to verification", async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result: CaptchaResult = {
      proof: "",
      nonce: "test-nonce",
      domain: "example.com",
    };

    await verifyCaptchaProof(result, { issuerPublicKey: dummyIssuerKey, logger });
    // Logger should not be called for empty proof (early return before decoding)
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("returns invalid when expectedDomain does not match", async () => {
    const attestation = {
      ackagentAnonymousAttestation: {
        issuerPublicKeyId: "test-key-001",
        pseudonym: "abc",
        scope: "test",
        presentationHeader: "abc",
        revealedMessages: {
          attestationType: "biometric",
          deviceType: "ios",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      proof: { proofValue: "abc", cryptosuite: "bbs-2023" },
    };
    const proof = btoa(JSON.stringify(attestation))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const result: CaptchaResult = {
      proof,
      nonce: "test-nonce",
      domain: "example.com",
    };

    const verification = await verifyCaptchaProof(result, {
      issuerPublicKey: dummyIssuerKey,
      expectedDomain: "other.com",
    });
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain("Domain mismatch");
  });

  it("returns invalid when issuer key ID does not match", async () => {
    const attestation = {
      ackagentAnonymousAttestation: {
        issuerPublicKeyId: "wrong-key-id",
        pseudonym: "abc",
        scope: "test",
        presentationHeader: "abc",
        revealedMessages: {
          attestationType: "biometric",
          deviceType: "ios",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      proof: { proofValue: "abc", cryptosuite: "bbs-2023" },
    };
    const proof = btoa(JSON.stringify(attestation))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const result: CaptchaResult = {
      proof,

      nonce: "test-nonce",
      domain: "example.com",
    };

    const verification = await verifyCaptchaProof(result, { issuerPublicKey: dummyIssuerKey });
    expect(verification.valid).toBe(false);
    expect(verification.error).toContain("Issuer key mismatch");
  });
});
