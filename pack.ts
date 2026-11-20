// Packfile v2/v3 reading and writing (spec 01, §3).
//
// Reading accepts plain objects plus ofs-delta (type 6) and ref-delta (type 7) entries,
// resolving delta chains recursively; a ref-delta base that is not in the pack is looked up
// through the caller's resolver (a thin pack against objects the other side already holds).
// The trailer checksum is verified before anything is returned, the header count must match
// the entries exactly, and every resolved object's size must match its declared size.
//
// Writing emits plain objects only — deltas are never required by the suite (spec 01, §3.2) —
// with a correct SHA-1 trailer, which is mandatory on every pack the forge sends.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type ObjectType } from './store.ts';

export interface PackEntry extends GitObject {
  oid: string;
}

const TYPE_TO_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Inflate the single zlib stream starting at `pos`; returns the bytes and where the stream ended. */
function inflateAt(buf: Buffer, pos: number): { data: Buffer; nextPos: number } {
  const out = inflateSync(buf.subarray(pos), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: out.buffer, nextPos: pos + out.engine.bytesWritten };
}

/** The pack entry header: type in bits 4-6 of the first byte, size little-endian 4-then-7 bits. */
function readTypeSize(buf: Buffer, pos: number): { typeCode: number; size: number; nextPos: number } {
  if (pos >= buf.length) throw new Error('pack entry header runs past the pack');
  let byte = buf[pos];
  pos += 1;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    if (pos >= buf.length) throw new Error('pack entry header runs past the pack');
    byte = buf[pos];
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, nextPos: pos };
}

function writeTypeSize(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = ((typeCode & 0x07) << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** The little-endian 7-bit varint used for delta header sizes. */
function readDeltaSize(buf: Buffer, pos: number): { size: number; nextPos: number } {
  let size = 0;
  let shift = 0;
  let byte = 0;
  do {
    if (pos >= buf.length) throw new Error('delta header runs past the delta');
    byte = buf[pos];
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { size, nextPos: pos };
}

/** The ofs-delta base offset encoding: each continuation adds 1 before shifting. */
function readOfsOffset(buf: Buffer, pos: number): { offset: number; nextPos: number } {
  if (pos >= buf.length) throw new Error('ofs-delta offset runs past the pack');
  let byte = buf[pos];
  pos += 1;
  let offset = byte & 0x7f;
  while (byte & 0x80) {
    if (pos >= buf.length) throw new Error('ofs-delta offset runs past the pack');
    byte = buf[pos];
    pos += 1;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
  }
  return { offset, nextPos: pos };
}

/** Apply a git delta body to a base object's bytes. Throws on any malformed instruction. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaSize(delta, 0);
  if (source.size !== base.length) {
    throw new Error(`delta expects a ${source.size}-byte base, the base is ${base.length} bytes`);
  }
  const target = readDeltaSize(delta, source.nextPos);
  let pos = target.nextPos;
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const cmd = delta[pos];
    pos += 1;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (cmd & (1 << bit)) {
          if (pos >= delta.length) throw new Error('delta copy offset runs past the delta');
          offset |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (cmd & (0x10 << bit)) {
          if (pos >= delta.length) throw new Error('delta copy size runs past the delta');
          size |= delta[pos] << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy reads past the base object');
      out.push(Buffer.from(base.subarray(offset, offset + size)));
      produced += size;
    } else if (cmd !== 0) {
      if (pos + cmd > delta.length) throw new Error('delta insert runs past the delta');
      out.push(Buffer.from(delta.subarray(pos, pos + cmd)));
      produced += cmd;
      pos += cmd;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== target.size || result.length !== target.size) {
    throw new Error(`delta produced ${result.length} bytes, the header promised ${target.size}`);
  }
  return result;
}

interface RawEntry {
  position: number;
  typeCode: number;
  size: number;
  plain?: Buffer;
  basePosition?: number;
  baseOid?: string;
  delta?: Buffer;
}

/**
 * Parse and fully resolve a pack. `resolveExternal`, when given, supplies bases for a thin
 * pack (ref-deltas against objects the receiving side already holds); those bases are used for
 * resolution but are NOT returned as entries. Throws on a bad magic, version, count, size or
 * trailer — the caller turns a throw into "unpack <detail>".
 */
export function readPack(buf: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (buf.length < 12 + 20) throw new Error('pack is shorter than a header plus trailer');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const checksum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!checksum.equals(trailer)) throw new Error('pack trailer checksum does not match the pack bytes');

  const raw: RawEntry[] = [];
  const indexByPosition = new Map<number, number>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const position = pos;
    const head = readTypeSize(buf, pos);
    pos = head.nextPos;
    const entry: RawEntry = { position, typeCode: head.typeCode, size: head.size };
    if (head.typeCode === OFS_DELTA) {
      const ofs = readOfsOffset(buf, pos);
      pos = ofs.nextPos;
      entry.basePosition = position - ofs.offset;
      const inflated = inflateAt(buf, pos);
      entry.delta = inflated.data;
      pos = inflated.nextPos;
    } else if (head.typeCode === REF_DELTA) {
      if (pos + 20 > buf.length) throw new Error('ref-delta base id runs past the pack');
      entry.baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
      const inflated = inflateAt(buf, pos);
      entry.delta = inflated.data;
      pos = inflated.nextPos;
    } else if (CODE_TO_TYPE[head.typeCode]) {
      const inflated = inflateAt(buf, pos);
      if (inflated.data.length !== head.size) {
        throw new Error(`pack entry at ${position} inflates to ${inflated.data.length} bytes, declares ${head.size}`);
      }
      entry.plain = inflated.data;
      pos = inflated.nextPos;
    } else {
      throw new Error(`pack entry at ${position} has unknown type code ${head.typeCode}`);
    }
    indexByPosition.set(position, raw.length);
    raw.push(entry);
  }
  if (pos !== buf.length - 20) {
    throw new Error(`pack has ${buf.length - 20 - pos} stray byte(s) between its last entry and the trailer`);
  }

  const resolved: (PackEntry | undefined)[] = raw.map(() => undefined);
  const byOid = new Map<string, PackEntry>();
  const resolve = (index: number): PackEntry => {
    const memo = resolved[index];
    if (memo) return memo;
    const entry = raw[index];
    let object: PackEntry;
    if (entry.plain !== undefined) {
      const type = CODE_TO_TYPE[entry.typeCode];
      object = { oid: hashObject(type, entry.plain), type, data: entry.plain };
    } else {
      let base: GitObject | undefined;
      if (entry.basePosition !== undefined) {
        const baseIndex = indexByPosition.get(entry.basePosition);
        if (baseIndex === undefined) throw new Error(`ofs-delta at ${entry.position} points at unknown offset ${entry.basePosition}`);
        base = resolve(baseIndex);
      } else if (entry.baseOid !== undefined) {
        base = byOid.get(entry.baseOid) ?? resolveExternal?.(entry.baseOid);
        if (!base) throw new Error(`ref-delta at ${entry.position} has no available base ${entry.baseOid}`);
      }
      if (!base || !entry.delta) throw new Error(`delta entry at ${entry.position} is incomplete`);
      const data = applyDelta(base.data, entry.delta);
      if (data.length !== entry.size) {
        throw new Error(`delta entry at ${entry.position} resolves to ${data.length} bytes, declares ${entry.size}`);
      }
      object = { oid: hashObject(base.type, data), type: base.type, data };
    }
    resolved[index] = object;
    byOid.set(object.oid, object);
    return object;
  };
  return raw.map((_, index) => resolve(index));
}

/**
 * Build a pack of plain objects. Each object is written at most once (first occurrence wins),
 * in the order given; the trailer is the SHA-1 of everything before it.
 */
export function buildPack(objects: Iterable<{ oid: string; type: ObjectType; data: Buffer }>): Buffer {
  const unique = new Map<string, { type: ObjectType; data: Buffer }>();
  for (const object of objects) {
    if (!unique.has(object.oid)) unique.set(object.oid, { type: object.type, data: object.data });
  }
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(unique.size, 8);
  parts.push(header);
  for (const object of unique.values()) {
    parts.push(writeTypeSize(TYPE_TO_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A valid pack of zero objects (32 bytes): what a nothing-new fetch delivers. */
export function emptyPack(): Buffer {
  return buildPack([]);
}
