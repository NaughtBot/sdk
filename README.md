# NaughtBot SDK

TypeScript SDK for the NaughtBot CAPTCHA widget. Provides cryptographic proof of human interaction via biometric verification.

## Install

```bash
npm install @naughtbot/sdk
```

## Usage

The SDK provides two entrypoints: `@naughtbot/sdk/browser` for client-side UI and `@naughtbot/sdk/server` for server-side proof verification.

### Browser — Widget

```ts
import { createWidget } from "@naughtbot/sdk/browser";

const widget = await createWidget("#captcha", {
  nonce: "server-generated-nonce",
  relayUrl: "https://relay.naughtbot.com",
  onVerified: (result) => {
    // Send result.proof to your server for verification
    fetch("/api/verify", {
      method: "POST",
      body: JSON.stringify(result),
    });
  },
});
```

### Browser — Headless Session

```ts
import { createSession } from "@naughtbot/sdk/browser";

const session = await createSession({
  nonce: "server-generated-nonce",
  relayUrl: "https://relay.naughtbot.com",
});

// Display session.qrCodeUrl as a QR code
const result = await session.waitForResult();
```

### Browser — BLE Transport

```ts
import { createBLESession, isBLEAvailable } from "@naughtbot/sdk/browser";

if (await isBLEAvailable()) {
  // Must be called from a user gesture (click handler)
  const session = await createBLESession({ nonce: "server-generated-nonce" });
  const result = await session.waitForResult();
}
```

### Server — Proof Verification

```ts
import { verifyCaptchaProof } from "@naughtbot/sdk/server";

const result = await verifyCaptchaProof(captchaResult, {
  issuerPublicKey: {
    keyId: "key-001",
    publicKey: "<base64url-encoded BLS12-381 G2 public key>",
  },
  expectedDomain: "example.com",
  logger: console, // optional, defaults to console
});

if (result.valid) {
  // Proof is valid
}
```

## Development

```bash
# Build
pnpm install && pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

## Related Repos

- [ackagent/web-sdk](https://github.com/AckAgent/web-sdk) — AckAgent Web SDK (peer dependency)
- [naughtbot/api](https://github.com/naughtbot/api) — NaughtBot API types
- [naughtbot/relay](https://github.com/naughtbot/relay) — NaughtBot relay service

## License

MIT
