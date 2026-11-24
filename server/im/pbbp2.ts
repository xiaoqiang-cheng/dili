/** Feishu long-connection frames (protobuf `pbbp2.Frame`), encoded by hand so
 * Dili does not need protobufjs. Field numbers follow @larksuiteoapi/node-sdk
 * 1.76 (pbbp2.Frame / pbbp2.Header):
 *   Frame: 1 SeqID uint64, 2 LogID uint64, 3 service int32, 4 method int32,
 *          5 headers repeated Header, 6 payloadEncoding string,
 *          7 payloadType string, 8 payload bytes, 9 LogIDNew string
 *   Header: 1 key string, 2 value string
 * SeqID/LogID are kept as bigint so an ACK echoes them exactly. */
export interface FrameHeader { key: string; value: string }
export interface Frame {
  SeqID: bigint; LogID: bigint; service: number; method: number;
  headers: FrameHeader[]; payloadEncoding?: string; payloadType?: string; payload?: Uint8Array; LogIDNew?: string;
}
/** method values. */
export const FRAME_CONTROL = 0, FRAME_DATA = 1;

function varint(value: bigint, out: number[]) {
  let rest = BigInt.asUintN(64, value);
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
}
const tag = (field: number, wire: number, out: number[]) => varint(BigInt((field << 3) | wire), out);
function bytesField(field: number, value: Uint8Array, out: number[]) { tag(field, 2, out); varint(BigInt(value.length), out); for (const byte of value) out.push(byte); }
const utf8 = new TextEncoder();

export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = [];
  tag(1, 0, out); varint(frame.SeqID, out);
  tag(2, 0, out); varint(frame.LogID, out);
  // int32: negative values take ten bytes, as protobuf sign-extends them.
  tag(3, 0, out); varint(BigInt(frame.service), out);
  tag(4, 0, out); varint(BigInt(frame.method), out);
  for (const header of frame.headers) {
    const inner: number[] = [];
    bytesField(1, utf8.encode(header.key), inner);
    bytesField(2, utf8.encode(header.value), inner);
    bytesField(5, Uint8Array.from(inner), out);
  }
  if (frame.payloadEncoding !== undefined) bytesField(6, utf8.encode(frame.payloadEncoding), out);
  if (frame.payloadType !== undefined) bytesField(7, utf8.encode(frame.payloadType), out);
  if (frame.payload !== undefined) bytesField(8, frame.payload, out);
  if (frame.LogIDNew !== undefined) bytesField(9, utf8.encode(frame.LogIDNew), out);
  return Uint8Array.from(out);
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done() { return this.offset >= this.bytes.length; }
  varint(): bigint {
    let result = 0n, shift = 0n;
    for (;;) {
      if (this.offset >= this.bytes.length || shift > 63n) throw new Error('帧格式无效');
      const byte = this.bytes[this.offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  }
  chunk(): Uint8Array {
    const length = Number(this.varint());
    if (this.offset + length > this.bytes.length) throw new Error('帧格式无效');
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 2) this.chunk();
    else if (wire === 1) this.offset += 8;
    else if (wire === 5) this.offset += 4;
    else throw new Error('帧格式无效');
  }
}
const text = new TextDecoder();
const int32 = (value: bigint) => Number(BigInt.asIntN(32, value));

export function decodeFrame(bytes: Uint8Array): Frame {
  const reader = new Reader(bytes);
  const frame: Frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] };
  while (!reader.done) {
    const key = Number(reader.varint()), field = key >> 3, wire = key & 7;
    if (field === 1 && wire === 0) frame.SeqID = reader.varint();
    else if (field === 2 && wire === 0) frame.LogID = reader.varint();
    else if (field === 3 && wire === 0) frame.service = int32(reader.varint());
    else if (field === 4 && wire === 0) frame.method = int32(reader.varint());
    else if (field === 5 && wire === 2) {
      const inner = new Reader(reader.chunk());
      const header: FrameHeader = { key: '', value: '' };
      while (!inner.done) {
        const innerKey = Number(inner.varint());
        if (innerKey === 10) header.key = text.decode(inner.chunk());
        else if (innerKey === 18) header.value = text.decode(inner.chunk());
        else inner.skip(innerKey & 7);
      }
      frame.headers.push(header);
    }
    else if (field === 6 && wire === 2) frame.payloadEncoding = text.decode(reader.chunk());
    else if (field === 7 && wire === 2) frame.payloadType = text.decode(reader.chunk());
    else if (field === 8 && wire === 2) frame.payload = Uint8Array.from(reader.chunk());
    else if (field === 9 && wire === 2) frame.LogIDNew = text.decode(reader.chunk());
    else reader.skip(wire);
  }
  return frame;
}
export const header = (frame: Frame, key: string) => frame.headers.find(item => item.key === key)?.value;
