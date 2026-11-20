// pkt-line framing for the git smart-HTTP protocol (spec 01-git-protocol.md).
//
// A pkt-line is a 4-hex-digit length prefix (the length counts the prefix itself) followed by
// length-4 payload bytes. Three length values are control packets, not data:
//   0000  flush         — end of a stream or section
//   0001  delim         — v2 section separator
//   0002  response-end  — v2 end of response (never sent in a fetch response; parsed if seen)
// 0003 is invalid. The largest legal line is 65520 bytes on the wire (65516 payload bytes).

/** Largest legal pkt-line, length prefix included. */
export const PKT_LINE_MAX = 65520;

/** Largest legal pkt-line payload (PKT_LINE_MAX minus the 4-byte prefix). */
export const PKT_PAYLOAD_MAX = PKT_LINE_MAX - 4;

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one payload as a pkt-line. Throws when the payload cannot fit in one line. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > PKT_LINE_MAX) {
    throw new Error(`pkt-line payload of ${body.length} bytes exceeds the ${PKT_PAYLOAD_MAX}-byte maximum`);
  }
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet (0000). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet (0001). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet (0002). */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Concatenate payloads as pkt-lines; no terminator is added (callers append pktFlush()). */
export function pktLines(payloads: readonly (Buffer | string)[]): Buffer {
  return Buffer.concat(payloads.map((payload) => pktLine(payload)));
}

/**
 * Parse pkt-lines from `buf` starting at `offset`, stopping at the first flush packet
 * (inclusive) or at the end of the buffer, whichever comes first. Returns the packets and the
 * offset just past the last consumed byte, so a caller can continue with what follows (for
 * receive-pack that is the raw pack stream after the command list's flush).
 *
 * Throws on any malformed framing: a non-hex length, the invalid length 0003, a length below 4
 * that is not a control value, or a line that runs past the end of the buffer. Callers treat a
 * throw as a bad request; the server must stay healthy afterwards (spec 01, check 30).
 */
export function parsePktLines(buf: Buffer, offset = 0): { packets: PktPacket[]; nextOffset: number } {
  const packets: PktPacket[] = [];
  let pos = offset;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) {
      throw new Error(`truncated pkt-line at byte ${pos}: fewer than 4 bytes remain`);
    }
    const hex = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(hex)} at byte ${pos}`);
    }
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      return { packets, nextOffset: pos };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length === 3 || length < 4) {
      throw new Error(`invalid pkt-line length ${length} at byte ${pos}`);
    }
    if (length > PKT_LINE_MAX) {
      throw new Error(`pkt-line length ${length} at byte ${pos} exceeds ${PKT_LINE_MAX}`);
    }
    if (pos + length > buf.length) {
      throw new Error(`truncated pkt-line at byte ${pos}: declares ${length} bytes, ${buf.length - pos} remain`);
    }
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(pos + 4, pos + length)) });
    pos += length;
  }
  return { packets, nextOffset: pos };
}

/**
 * Parse a whole buffer that must be exactly one pkt-line stream ending in a flush (advertise /
 * ls-refs / fetch request bodies). Throws when bytes remain after the flush.
 */
export function parsePktStream(buf: Buffer): PktPacket[] {
  const { packets, nextOffset } = parsePktLines(buf, 0);
  if (nextOffset !== buf.length) {
    throw new Error(`${buf.length - nextOffset} trailing byte(s) after the flush packet`);
  }
  const last = packets[packets.length - 1];
  if (!last || last.kind !== 'flush') {
    throw new Error('pkt-line stream does not end with a flush packet');
  }
  return packets;
}

/** The text of a data packet as utf8, with one trailing newline stripped when present. */
export function pktText(packet: PktPacket): string {
  if (packet.kind !== 'data') return '';
  const text = packet.payload.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}
