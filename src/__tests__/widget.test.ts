import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CaptchaResult, CaptchaSessionState } from "../types.js";
import type { CaptchaSession } from "../captcha.js";
import { createSession } from "../captcha.js";
import { createWidget } from "../widget.js";

vi.mock("../captcha.js", () => ({
  createSession: vi.fn(),
}));

vi.mock("../ble.js", () => ({
  createBLESession: vi.fn(),
  isBLEAvailable: vi.fn().mockResolvedValue(false),
}));

// Widget requires DOM APIs — test the pure helper logic and widget creation failures
describe("createWidget", () => {
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalDocument = globalThis.document;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  it("throws when container selector not found", async () => {
    // Provide a minimal document with querySelector that returns null
    const mockDoc = {
      querySelector: vi.fn().mockReturnValue(null),
      createElement: vi.fn(),
      head: { appendChild: vi.fn() },
    };
    globalThis.document = mockDoc as unknown as Document;

    const { createWidget } = await import("../widget.js");

    await expect(
      createWidget("#nonexistent", {
        nonce: "test",
        relayUrl: "https://relay.example.com",
        onVerified: () => {},
      }),
    ).rejects.toThrow("Container not found");
  });
});

describe("widget onVerified rendering", () => {
  let savedDocument: typeof globalThis.document;
  let savedCustomEvent: typeof globalThis.CustomEvent;

  interface MockElement {
    className: string;
    textContent: string;
    dataset: Record<string, string>;
    id: string;
    width: number;
    height: number;
    readonly firstChild: MockElement | null;
    appendChild(child: MockElement): MockElement;
    removeChild(child: MockElement): MockElement;
    addEventListener: ReturnType<typeof vi.fn>;
    dispatchEvent: ReturnType<typeof vi.fn>;
    getContext: ReturnType<typeof vi.fn>;
    _children: MockElement[];
  }

  // Minimal mock DOM element with child tracking
  function mockEl(): MockElement {
    const children: MockElement[] = [];
    return {
      className: "",
      textContent: "",
      dataset: {} as Record<string, string>,
      id: "",
      width: 0,
      height: 0,
      get firstChild() {
        return children[0] ?? null;
      },
      appendChild(child: MockElement) {
        children.push(child);
        return child;
      },
      removeChild(child: MockElement) {
        const i = children.indexOf(child);
        if (i >= 0) children.splice(i, 1);
        return child;
      },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      getContext: vi.fn().mockReturnValue({
        fillStyle: "",
        font: "",
        textAlign: "",
        fillRect: vi.fn(),
        fill: vi.fn(),
        fillText: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        closePath: vi.fn(),
      }),
      _children: children,
    };
  }

  // Extract the widget state from the container's rendered child className
  function renderedState(el: ReturnType<typeof mockEl>): string | null {
    if (el._children.length === 0) return null;
    const cls: string = el._children[0].className;
    return cls.match(/naughtbot-(\w+)$/)?.[1] ?? null;
  }

  function makeMockSession(result: CaptchaResult): CaptchaSession {
    return {
      sessionId: "test",
      qrCodeUrl: "https://example.com/qr",
      state: "waiting_for_scan" as CaptchaSessionState,
      sas: null,
      waitForResult: vi.fn().mockResolvedValue(result),
      confirmSAS: vi.fn(),
      cancel: vi.fn(),
      onStateChange: vi.fn(),
    };
  }

  async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  const testResult: CaptchaResult = {
    proof: "proof",
    nonce: "nonce",
    domain: "example.com",
  };

  beforeEach(() => {
    savedDocument = globalThis.document;
    savedCustomEvent = globalThis.CustomEvent;

    globalThis.CustomEvent = class {
      constructor(
        public type: string,
        public init?: CustomEventInit<unknown>,
      ) {}
    } as unknown as typeof CustomEvent;

    globalThis.document = {
      querySelector: vi.fn(),
      createElement: vi.fn().mockImplementation(() => mockEl()),
      head: { appendChild: vi.fn() },
      getElementById: vi.fn().mockReturnValue(null),
    } as unknown as Document;
  });

  afterEach(() => {
    globalThis.document = savedDocument;
    globalThis.CustomEvent = savedCustomEvent;
  });

  it("shows error when onVerified rejects", async () => {
    vi.mocked(createSession).mockResolvedValue(makeMockSession(testResult));
    const container = mockEl();

    await createWidget(container as unknown as HTMLElement, {
      nonce: "n",
      relayUrl: "https://relay.example.com",
      onVerified: async () => {
        throw new Error("Server verification failed");
      },
    });
    await flush();

    expect(renderedState(container)).toBe("error");
  });

  it("shows verified when onVerified resolves", async () => {
    vi.mocked(createSession).mockResolvedValue(makeMockSession(testResult));
    const container = mockEl();

    await createWidget(container as unknown as HTMLElement, {
      nonce: "n",
      relayUrl: "https://relay.example.com",
      onVerified: async () => {},
    });
    await flush();

    expect(renderedState(container)).toBe("verified");
  });

  it("shows verified when onVerified returns void (backward compat)", async () => {
    vi.mocked(createSession).mockResolvedValue(makeMockSession(testResult));
    const container = mockEl();

    await createWidget(container as unknown as HTMLElement, {
      nonce: "n",
      relayUrl: "https://relay.example.com",
      onVerified: () => {},
    });
    await flush();

    expect(renderedState(container)).toBe("verified");
  });
});
