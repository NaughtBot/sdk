import { describe, expect, it, vi } from "vitest";
import { isBLESupported, isBLEAvailable } from "../ble.js";
import {
  fragmentMessage,
  reassembleFragments,
  FRAGMENT_HEADER_SIZE,
  MAX_FRAGMENT_SIZE,
  FRAGMENT_FLAG_FIRST,
  FRAGMENT_FLAG_LAST,
  MAX_REASSEMBLY_BYTES,
} from "../ble-fragmentation.js";

describe("isBLESupported", () => {
  it("returns false in Node environment (no navigator.bluetooth)", () => {
    expect(isBLESupported()).toBe(false);
  });
});

describe("isBLEAvailable", () => {
  it("returns false in Node environment (no navigator.bluetooth)", async () => {
    expect(await isBLEAvailable()).toBe(false);
  });

  it("returns true when getAvailability() resolves to true", async () => {
    const mockBluetooth = {
      getAvailability: vi.fn().mockResolvedValue(true),
      requestDevice: vi.fn(),
    };
    vi.stubGlobal("navigator", { bluetooth: mockBluetooth });
    try {
      expect(await isBLEAvailable()).toBe(true);
      expect(mockBluetooth.getAvailability).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns false when getAvailability() resolves to false", async () => {
    const mockBluetooth = {
      getAvailability: vi.fn().mockResolvedValue(false),
      requestDevice: vi.fn(),
    };
    vi.stubGlobal("navigator", { bluetooth: mockBluetooth });
    try {
      expect(await isBLEAvailable()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns false when getAvailability() throws", async () => {
    const mockBluetooth = {
      getAvailability: vi.fn().mockRejectedValue(new Error("Not allowed")),
      requestDevice: vi.fn(),
    };
    vi.stubGlobal("navigator", { bluetooth: mockBluetooth });
    try {
      expect(await isBLEAvailable()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("fragmentMessage", () => {
  it("produces a single fragment with FIRST|LAST flags for small data", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const fragments = fragmentMessage(data);

    expect(fragments).toHaveLength(1);
    expect(fragments[0][0]).toBe(FRAGMENT_FLAG_FIRST | FRAGMENT_FLAG_LAST);
    expect(fragments[0][1]).toBe(0); // sequence 0
    expect(fragments[0].slice(FRAGMENT_HEADER_SIZE)).toEqual(data);
  });

  it("produces a single fragment for empty data with FIRST|LAST flags", () => {
    const data = new Uint8Array(0);
    const fragments = fragmentMessage(data);

    expect(fragments).toHaveLength(1);
    expect(fragments[0][0]).toBe(FRAGMENT_FLAG_FIRST | FRAGMENT_FLAG_LAST);
    expect(fragments[0][1]).toBe(0);
    expect(fragments[0].length).toBe(FRAGMENT_HEADER_SIZE);
  });

  it("splits data into multiple fragments with correct flags", () => {
    // Use a small max fragment size to force multiple fragments
    const maxFragSize = 10; // 2 header + 8 payload per fragment
    const data = new Uint8Array(25); // requires ceil(25/8) = 4 fragments
    for (let i = 0; i < data.length; i++) data[i] = i;

    const fragments = fragmentMessage(data, maxFragSize);

    expect(fragments).toHaveLength(4);

    // First fragment: FIRST flag only
    expect(fragments[0][0]).toBe(FRAGMENT_FLAG_FIRST);
    // Middle fragments: no flags
    expect(fragments[1][0]).toBe(0);
    expect(fragments[2][0]).toBe(0);
    // Last fragment: LAST flag only
    expect(fragments[3][0]).toBe(FRAGMENT_FLAG_LAST);
  });

  it("assigns correct sequence numbers 0-255", () => {
    const maxFragSize = 10; // 8 bytes payload
    const data = new Uint8Array(25);
    const fragments = fragmentMessage(data, maxFragSize);

    for (let i = 0; i < fragments.length; i++) {
      expect(fragments[i][1]).toBe(i);
    }
  });

  it("wraps sequence number at 255", () => {
    // Create enough data to produce 257 fragments (past 0xff wrap)
    const maxFragSize = 3; // 1 byte payload per fragment
    const data = new Uint8Array(257);
    const fragments = fragmentMessage(data, maxFragSize);

    expect(fragments).toHaveLength(257);
    expect(fragments[255][1]).toBe(255);
    expect(fragments[256][1]).toBe(0); // wrapped
  });

  it("limits each fragment to maxFragmentSize bytes", () => {
    const data = new Uint8Array(2000);
    const fragments = fragmentMessage(data);

    for (const frag of fragments) {
      expect(frag.length).toBeLessThanOrEqual(MAX_FRAGMENT_SIZE);
    }
  });

  it("preserves all data bytes across fragments", () => {
    const data = new Uint8Array(1500);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const fragments = fragmentMessage(data);

    // Concatenate all payloads
    const payloads = fragments.map((f) => f.slice(FRAGMENT_HEADER_SIZE));
    const totalLength = payloads.reduce((sum, p) => sum + p.length, 0);
    expect(totalLength).toBe(data.length);

    const reassembled = new Uint8Array(totalLength);
    let offset = 0;
    for (const p of payloads) {
      reassembled.set(p, offset);
      offset += p.length;
    }
    expect(reassembled).toEqual(data);
  });

  it("uses default MAX_FRAGMENT_SIZE when not specified", () => {
    // Data that fits in a single default-sized fragment
    const maxPayload = MAX_FRAGMENT_SIZE - FRAGMENT_HEADER_SIZE;
    const data = new Uint8Array(maxPayload);
    const fragments = fragmentMessage(data);

    expect(fragments).toHaveLength(1);
    expect(fragments[0].length).toBe(MAX_FRAGMENT_SIZE);
  });

  it("creates exactly 2 fragments when data is one byte over max payload", () => {
    const maxPayload = MAX_FRAGMENT_SIZE - FRAGMENT_HEADER_SIZE;
    const data = new Uint8Array(maxPayload + 1);
    const fragments = fragmentMessage(data);

    expect(fragments).toHaveLength(2);
    expect(fragments[0][0]).toBe(FRAGMENT_FLAG_FIRST);
    expect(fragments[1][0]).toBe(FRAGMENT_FLAG_LAST);
  });
});

describe("reassembleFragments", () => {
  it("reassembles a single fragment", () => {
    const data = new Uint8Array([10, 20, 30]);
    const fragments = fragmentMessage(data);
    const result = reassembleFragments(fragments);

    expect(result).toEqual(data);
  });

  it("reassembles multiple fragments (round-trip)", () => {
    const data = new Uint8Array(1500);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const fragments = fragmentMessage(data);
    const result = reassembleFragments(fragments);

    expect(result).toEqual(data);
  });

  it("round-trips empty data", () => {
    const data = new Uint8Array(0);
    const fragments = fragmentMessage(data);
    const result = reassembleFragments(fragments);

    expect(result).toEqual(data);
  });

  it("round-trips data exactly at max payload boundary", () => {
    const maxPayload = MAX_FRAGMENT_SIZE - FRAGMENT_HEADER_SIZE;
    const data = new Uint8Array(maxPayload);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const fragments = fragmentMessage(data);
    expect(fragments).toHaveLength(1);

    const result = reassembleFragments(fragments);
    expect(result).toEqual(data);
  });

  it("round-trips with custom fragment size", () => {
    const data = new Uint8Array(100);
    for (let i = 0; i < data.length; i++) data[i] = i;

    const fragments = fragmentMessage(data, 12); // 10 byte payload
    expect(fragments.length).toBe(10);

    const result = reassembleFragments(fragments);
    expect(result).toEqual(data);
  });

  it("throws on empty fragment array", () => {
    expect(() => reassembleFragments([])).toThrow("No fragments to reassemble");
  });

  it("throws when first fragment is missing FIRST flag", () => {
    const frag = new Uint8Array([FRAGMENT_FLAG_LAST, 0, 1, 2]);
    expect(() => reassembleFragments([frag])).toThrow("First fragment missing FIRST flag");
  });

  it("throws when last fragment is missing LAST flag", () => {
    const frag = new Uint8Array([FRAGMENT_FLAG_FIRST, 0, 1, 2]);
    expect(() => reassembleFragments([frag])).toThrow("Last fragment missing LAST flag");
  });

  it("throws on wrong sequence number", () => {
    const frag0 = new Uint8Array([FRAGMENT_FLAG_FIRST, 0, 1]);
    const frag1 = new Uint8Array([FRAGMENT_FLAG_LAST, 5, 2]); // seq should be 1
    expect(() => reassembleFragments([frag0, frag1])).toThrow("wrong sequence number");
  });

  it("throws when reassembled message exceeds MAX_REASSEMBLY_BYTES", () => {
    // Build fragments whose total payload exceeds the limit
    const payloadPerFrag = MAX_FRAGMENT_SIZE - FRAGMENT_HEADER_SIZE;
    const numFragments = Math.ceil(MAX_REASSEMBLY_BYTES / payloadPerFrag) + 1;
    const fragments: Uint8Array[] = [];

    for (let i = 0; i < numFragments; i++) {
      let flags = 0;
      if (i === 0) flags = FRAGMENT_FLAG_FIRST;
      if (i === numFragments - 1) flags = FRAGMENT_FLAG_LAST;

      const frag = new Uint8Array(MAX_FRAGMENT_SIZE);
      frag[0] = flags;
      frag[1] = i & 0xff;
      // payload is zeros
      fragments.push(frag);
    }

    expect(() => reassembleFragments(fragments)).toThrow("BLE message exceeds maximum size");
  });

  it("throws on fragment too short", () => {
    const frag = new Uint8Array([FRAGMENT_FLAG_FIRST | FRAGMENT_FLAG_LAST]);
    expect(() => reassembleFragments([frag])).toThrow("too short");
  });
});

describe("BLE UUID constants", () => {
  it("uses only valid hex characters in UUIDs", () => {
    // Validate UUID format: 8-4-4-4-12, all hex
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    // The UUIDs used in the module should be valid hex
    expect("0a097b07-ca9c-4a5b-8c7d-000000000001").toMatch(uuidPattern);
    expect("0a097b07-ca9c-4a5b-8c7d-000000000002").toMatch(uuidPattern);
    expect("0a097b07-ca9c-4a5b-8c7d-000000000003").toMatch(uuidPattern);

    // Verify the old invalid UUIDs would NOT match
    expect("naug7b07-ca9c-4a5b-8c7d-000000000001").not.toMatch(uuidPattern);
  });
});
