import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSession } from "../captcha.js";
import {
  generateKeyPair,
  deriveRequestKey,
  deriveResponseKey,
  encrypt,
  decrypt,
  requestIdToBytes,
  base64urlEncode,
  base64urlDecode,
  computeSAS,
} from "@ackagent/web-sdk";
import { hexEncode } from "../captcha.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock window.location for domain detection
vi.stubGlobal("window", { location: { hostname: "example.com" } });

describe("createSession", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create a session with correct QR URL format", async () => {
    // Mock successful relay session creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "550e8400-e29b-41d4-a716-446655440000" }),
    });

    const session = await createSession({
      nonce: "test-nonce-123",
      relayUrl: "https://relay.naughtbot.com",
      loginUrl: "https://login.naughtbot.com",
    });

    expect(session.sessionId).toBeTruthy();
    expect(session.qrCodeUrl).toContain("https://login.naughtbot.com/link/captcha?sid=");
    expect(session.qrCodeUrl).toContain("&pk=");
    expect(session.state).toBe("waiting_for_scan");
    expect(session.sas).toBeNull();
  });

  it("should include base64url-encoded public key in QR URL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "660e8400-e29b-41d4-a716-446655440001" }),
    });

    const session = await createSession({
      nonce: "nonce",
      relayUrl: "https://relay.test",
    });

    const url = new URL(session.qrCodeUrl);
    const pk = url.searchParams.get("pk");
    expect(pk).toBeTruthy();
    if (!pk) throw new Error("expected pk param");

    // base64url should only contain [A-Za-z0-9_-]
    expect(pk).toMatch(/^[A-Za-z0-9_-]+$/);

    // Decode should give 33 bytes (compressed P-256)
    const decoded = base64urlDecode(pk);
    expect(decoded.length).toBe(33);
    // First byte should be 0x02 or 0x03 (compressed SEC1 prefix)
    expect([0x02, 0x03]).toContain(decoded[0]);
  });

  it("should throw if relay session creation fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    });

    await expect(
      createSession({
        nonce: "nonce",
        relayUrl: "https://relay.test",
      }),
    ).rejects.toThrow("Failed to create captcha session on relay");
  });

  it("should allow cancellation", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "770e8400-e29b-41d4-a716-446655440002" }),
    });

    const session = await createSession({
      nonce: "nonce",
      relayUrl: "https://relay.test",
      timeoutMs: 30_000,
    });

    // Mock poll returning no phone key, with a delay so the cancel can fire during sleep
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 100),
        ),
    );

    const resultPromise = session.waitForResult();

    // Cancel after first poll cycle starts
    setTimeout(() => session.cancel(), 50);

    await expect(resultPromise).rejects.toThrow("Session cancelled");
  });

  it("should fire state change callbacks", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "880e8400-e29b-41d4-a716-446655440003" }),
    });

    const session = await createSession({
      nonce: "nonce",
      relayUrl: "https://relay.test",
    });

    const states: string[] = [];
    session.onStateChange((state) => states.push(state));

    // Cancel to trigger error state
    session.cancel();
    expect(states).toContain("error");
  });
});

describe("QR URL parsing", () => {
  it("should produce a URL that can be parsed back", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "990e8400-e29b-41d4-a716-446655440004" }),
    });

    const session = await createSession({
      nonce: "test-nonce",
      relayUrl: "https://relay.naughtbot.com",
      loginUrl: "https://login.naughtbot.com",
    });

    const url = new URL(session.qrCodeUrl);
    expect(url.hostname).toBe("login.naughtbot.com");
    expect(url.pathname).toBe("/link/captcha");

    const sid = url.searchParams.get("sid");
    const pk = url.searchParams.get("pk");

    expect(sid).toBe(session.sessionId);
    expect(pk).toBeTruthy();
    if (!pk) throw new Error("expected pk param");

    // Round-trip the public key
    const publicKey = base64urlDecode(pk);
    const reEncoded = base64urlEncode(publicKey);
    expect(reEncoded).toBe(pk);
  });
});

describe("SAS computation for captcha", () => {
  it("should compute SAS from two ephemeral public keys", async () => {
    // Simulate browser and phone each generating ephemeral keys
    const browserKey = await generateKeyPair();
    const phoneKey = await generateKeyPair();

    // Browser computes SAS (browser is "requester", phone is "approver")
    const browserSas = computeSAS(browserKey.publicKey, [
      {
        encryptionPublicKeyHex: hexEncode(phoneKey.publicKey),
        publicKey: phoneKey.publicKey,
      },
    ]);

    // Phone computes SAS with same inputs
    const phoneSas = computeSAS(browserKey.publicKey, [
      {
        encryptionPublicKeyHex: hexEncode(phoneKey.publicKey),
        publicKey: phoneKey.publicKey,
      },
    ]);

    // Both should produce identical SAS
    expect(browserSas.words).toEqual(phoneSas.words);
    expect(browserSas.emojis).toEqual(phoneSas.emojis);
    expect(browserSas.wordString).toEqual(phoneSas.wordString);

    // SAS should have 5 words
    expect(browserSas.words).toHaveLength(5);
    expect(browserSas.emojis).toHaveLength(5);
  });

  it("should produce different SAS for different key pairs", async () => {
    const browserKey1 = await generateKeyPair();
    const browserKey2 = await generateKeyPair();
    const phoneKey = await generateKeyPair();

    const sas1 = computeSAS(browserKey1.publicKey, [
      {
        encryptionPublicKeyHex: hexEncode(phoneKey.publicKey),
        publicKey: phoneKey.publicKey,
      },
    ]);

    const sas2 = computeSAS(browserKey2.publicKey, [
      {
        encryptionPublicKeyHex: hexEncode(phoneKey.publicKey),
        publicKey: phoneKey.publicKey,
      },
    ]);

    // Different browser keys should produce different SAS (with overwhelming probability)
    expect(sas1.wordString).not.toBe(sas2.wordString);
  });
});

describe("E2E encryption for captcha", () => {
  it("should encrypt and decrypt challenge between browser and phone", async () => {
    const browserKey = await generateKeyPair();
    const phoneKey = await generateKeyPair();
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const requestIdBytes = requestIdToBytes(sessionId);

    // Browser encrypts challenge with request key
    const challenge = {
      type: "captcha",
      domain: "example.com",
      nonce: "abc123",
      timestamp: Date.now(),
    };
    const challengeBytes = new TextEncoder().encode(JSON.stringify(challenge));

    const requestKey = await deriveRequestKey(
      browserKey.privateKey,
      phoneKey.publicKey,
      requestIdBytes,
    );

    const { ciphertext, nonce } = encrypt(requestKey, challengeBytes, requestIdBytes);

    // Phone decrypts challenge with same derived request key
    const phoneRequestKey = await deriveRequestKey(
      phoneKey.privateKey,
      browserKey.publicKey,
      requestIdBytes,
    );

    // Note: ECDH is symmetric, but HKDF info string is directional
    // For captcha, both sides derive the same request key because
    // deriveRequestKey uses the same HKDF info string regardless of direction.
    // The "request" vs "response" distinction is about the message direction.
    // Actually, ECDH shared secret is the same regardless of which side computes it,
    // so deriveRequestKey with (browser_priv, phone_pub) = deriveRequestKey with (phone_priv, browser_pub)
    const decrypted = decrypt(phoneRequestKey, nonce, ciphertext, requestIdBytes);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));

    expect(parsed.type).toBe("captcha");
    expect(parsed.domain).toBe("example.com");
    expect(parsed.nonce).toBe("abc123");
  });

  it("should encrypt and decrypt response from phone to browser", async () => {
    const browserKey = await generateKeyPair();
    const phoneKey = await generateKeyPair();
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const requestIdBytes = requestIdToBytes(sessionId);

    // Phone encrypts response with response key
    const response = {
      approved: true,
      plaintextHash: "sha256:abc123",
    };
    const responseBytes = new TextEncoder().encode(JSON.stringify(response));

    const phoneResponseKey = await deriveResponseKey(
      phoneKey.privateKey,
      browserKey.publicKey,
      requestIdBytes,
    );

    const { ciphertext, nonce } = encrypt(phoneResponseKey, responseBytes, requestIdBytes);

    // Browser decrypts response
    const browserResponseKey = await deriveResponseKey(
      browserKey.privateKey,
      phoneKey.publicKey,
      requestIdBytes,
    );

    const decrypted = decrypt(browserResponseKey, nonce, ciphertext, requestIdBytes);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));

    expect(parsed.approved).toBe(true);
  });
});
