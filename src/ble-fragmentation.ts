/**
 * Pure BLE fragmentation logic extracted for testability.
 * Implements the AckAgent BLE fragmentation protocol:
 * each fragment has a 2-byte header [flags, sequence] followed by payload.
 */

export const FRAGMENT_HEADER_SIZE = 2;
export const MAX_FRAGMENT_SIZE = 500;
export const FRAGMENT_FLAG_FIRST = 0x01;
export const FRAGMENT_FLAG_LAST = 0x02;
export const MAX_REASSEMBLY_BYTES = 65_536; // 64 KB max reassembled message

/**
 * Split data into fragments with headers (flags + sequence byte).
 * Each fragment is at most maxFragmentSize bytes including the 2-byte header.
 */
export function fragmentMessage(
  data: Uint8Array,
  maxFragmentSize: number = MAX_FRAGMENT_SIZE,
): Uint8Array[] {
  if (data.length === 0) {
    // Even empty data produces one fragment with FIRST|LAST flags
    const fragment = new Uint8Array(FRAGMENT_HEADER_SIZE);
    fragment[0] = FRAGMENT_FLAG_FIRST | FRAGMENT_FLAG_LAST;
    fragment[1] = 0;
    return [fragment];
  }

  const maxPayload = maxFragmentSize - FRAGMENT_HEADER_SIZE;
  const fragments: Uint8Array[] = [];
  let offset = 0;
  let sequence = 0;

  while (offset < data.length) {
    const remaining = data.length - offset;
    const chunkSize = Math.min(remaining, maxPayload);
    const chunk = data.slice(offset, offset + chunkSize);

    let flags = 0;
    if (offset === 0) flags |= FRAGMENT_FLAG_FIRST;
    if (offset + chunkSize >= data.length) flags |= FRAGMENT_FLAG_LAST;

    const fragment = new Uint8Array(FRAGMENT_HEADER_SIZE + chunk.length);
    fragment[0] = flags;
    fragment[1] = sequence & 0xff;
    fragment.set(chunk, FRAGMENT_HEADER_SIZE);

    fragments.push(fragment);
    offset += chunkSize;
    sequence++;
  }

  return fragments;
}

/**
 * Reassemble fragments into a complete message.
 * Validates fragment ordering, flags, and size limits.
 * Throws if the reassembled message exceeds MAX_REASSEMBLY_BYTES.
 */
export function reassembleFragments(fragments: Uint8Array[]): Uint8Array {
  if (fragments.length === 0) {
    throw new Error("No fragments to reassemble");
  }

  // Validate first fragment has FIRST flag
  if (!(fragments[0][0] & FRAGMENT_FLAG_FIRST)) {
    throw new Error("First fragment missing FIRST flag");
  }

  // Validate last fragment has LAST flag
  if (!(fragments[fragments.length - 1][0] & FRAGMENT_FLAG_LAST)) {
    throw new Error("Last fragment missing LAST flag");
  }

  let totalPayloadSize = 0;
  const payloads: Uint8Array[] = [];

  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i];
    if (frag.length < FRAGMENT_HEADER_SIZE) {
      throw new Error(`Fragment ${i} too short`);
    }

    const seq = frag[1];
    if (seq !== (i & 0xff)) {
      throw new Error(`Fragment ${i} has wrong sequence number: expected ${i & 0xff}, got ${seq}`);
    }

    const payload = frag.slice(FRAGMENT_HEADER_SIZE);
    totalPayloadSize += payload.length;

    if (totalPayloadSize > MAX_REASSEMBLY_BYTES) {
      throw new Error("BLE message exceeds maximum size");
    }

    payloads.push(payload);
  }

  const result = new Uint8Array(totalPayloadSize);
  let offset = 0;
  for (const p of payloads) {
    result.set(p, offset);
    offset += p.length;
  }

  return result;
}
