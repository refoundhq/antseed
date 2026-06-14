import type { ResponseAuthPayload } from '../types/protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_PAYLOAD_SIZE = 64 * 1024;

function parseJson(data: Uint8Array): Record<string, unknown> {
  if (data.byteLength > MAX_PAYLOAD_SIZE) {
    throw new Error(`Verification payload too large: ${data.byteLength} bytes (max ${MAX_PAYLOAD_SIZE})`);
  }
  const raw: unknown = JSON.parse(decoder.decode(data));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid string field: ${field}`);
  }
  return value;
}

function requireNumber(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing or invalid number field: ${field}`);
  }
  return value;
}

export function encodeResponseAuth(payload: ResponseAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function decodeResponseAuth(data: Uint8Array): ResponseAuthPayload {
  const obj = parseJson(data);
  const version = obj.version;
  if (version !== 1) {
    throw new Error(`Unsupported response auth version: ${String(version)}`);
  }

  const result: ResponseAuthPayload = {
    version,
    requestId: requireString(obj, 'requestId'),
    buyerPeerId: requireString(obj, 'buyerPeerId'),
    sellerPeerId: requireString(obj, 'sellerPeerId'),
    advertisedService: requireString(obj, 'advertisedService'),
    provider: requireString(obj, 'provider'),
    statusCode: requireNumber(obj, 'statusCode'),
    requestHash: requireString(obj, 'requestHash'),
    responseHash: requireString(obj, 'responseHash'),
    responseStartedAt: requireNumber(obj, 'responseStartedAt'),
    responseCompletedAt: requireNumber(obj, 'responseCompletedAt'),
    signature: requireString(obj, 'signature'),
  };
  if (typeof obj.channelId === 'string' && obj.channelId.length > 0) {
    result.channelId = obj.channelId;
  }
  return result;
}
