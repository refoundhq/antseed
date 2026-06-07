import {
  PAYMENT_CODE_CHANNEL_EXHAUSTED,
  type SpendingAuthPayload,
  type AuthAckPayload,
  type PaymentRequiredPayload,
  type NeedAuthPayload,
  type ChannelUsageReportPayload,
  type ChannelUsageReportServiceUsageLeafPayload,
  type UsageReportAckPayload,
} from '../types/protocol.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Validation helpers ---

const MAX_PAYLOAD_SIZE = 4 * 1024 * 1024; // Bounded JSON payloads; frames still cap at 64MB.

function parseJson(data: Uint8Array): Record<string, unknown> {
  if (data.byteLength > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payment payload too large: ${data.byteLength} bytes (max ${MAX_PAYLOAD_SIZE})`);
  }
  const raw: unknown = JSON.parse(decoder.decode(data));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Missing or invalid string field: ${field}`);
  }
  return val;
}

// --- Encoders ---

export function encodeSpendingAuth(payload: SpendingAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeAuthAck(payload: AuthAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodePaymentRequired(payload: PaymentRequiredPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeNeedAuth(payload: NeedAuthPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodePeerReport(payload: ChannelUsageReportPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

export function encodeReportAck(payload: UsageReportAckPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

// --- Decoders (with runtime validation) ---

export function decodeSpendingAuth(data: Uint8Array): SpendingAuthPayload {
  const obj = parseJson(data);
  const result: SpendingAuthPayload = {
    channelId: requireString(obj, 'channelId'),
    cumulativeAmount: requireString(obj, 'cumulativeAmount'),
    metadataHash: requireString(obj, 'metadataHash'),
    metadata: typeof obj.metadata === 'string' ? obj.metadata : '',
    spendingAuthSig: requireString(obj, 'spendingAuthSig'),
  };
  // Optional reserve params (only on initial auth)
  if (typeof obj.reserveSalt === 'string') result.reserveSalt = obj.reserveSalt;
  if (typeof obj.reserveMaxAmount === 'string') result.reserveMaxAmount = obj.reserveMaxAmount;
  if (typeof obj.reserveDeadline === 'number') result.reserveDeadline = obj.reserveDeadline;
  return result;
}

export function decodeAuthAck(data: Uint8Array): AuthAckPayload {
  const obj = parseJson(data);
  return {
    channelId: requireString(obj, 'channelId'),
  };
}

export function decodePaymentRequired(data: Uint8Array): PaymentRequiredPayload {
  const obj = parseJson(data);
  const result: PaymentRequiredPayload = {
    minBudgetPerRequest: requireString(obj, 'minBudgetPerRequest'),
    suggestedAmount: requireString(obj, 'suggestedAmount'),
    requestId: requireString(obj, 'requestId'),
  };
  if (typeof obj.inputUsdPerMillion === 'number') result.inputUsdPerMillion = obj.inputUsdPerMillion;
  if (typeof obj.outputUsdPerMillion === 'number') result.outputUsdPerMillion = obj.outputUsdPerMillion;
  if (typeof obj.cachedInputUsdPerMillion === 'number') result.cachedInputUsdPerMillion = obj.cachedInputUsdPerMillion;
  if (typeof obj.requiredCumulativeAmount === 'string') result.requiredCumulativeAmount = obj.requiredCumulativeAmount;
  if (typeof obj.currentSpent === 'string') result.currentSpent = obj.currentSpent;
  if (typeof obj.currentAcceptedCumulative === 'string') result.currentAcceptedCumulative = obj.currentAcceptedCumulative;
  if (typeof obj.channelId === 'string') result.channelId = obj.channelId;
  if (typeof obj.reserveMaxAmount === 'string') result.reserveMaxAmount = obj.reserveMaxAmount;
  if (obj.code === PAYMENT_CODE_CHANNEL_EXHAUSTED) result.code = obj.code;
  return result;
}

export function decodeNeedAuth(data: Uint8Array): NeedAuthPayload {
  const obj = parseJson(data);
  const result: NeedAuthPayload = {
    channelId: requireString(obj, 'channelId'),
    requiredCumulativeAmount: requireString(obj, 'requiredCumulativeAmount'),
    currentAcceptedCumulative: requireString(obj, 'currentAcceptedCumulative'),
    deposit: requireString(obj, 'deposit'),
  };
  if (typeof obj.requestId === 'string') result.requestId = obj.requestId;
  if (typeof obj.lastRequestCost === 'string') result.lastRequestCost = obj.lastRequestCost;
  if (typeof obj.inputTokens === 'string') result.inputTokens = obj.inputTokens;
  if (typeof obj.outputTokens === 'string') result.outputTokens = obj.outputTokens;
  if (typeof obj.cachedInputTokens === 'string') result.cachedInputTokens = obj.cachedInputTokens;
  if (typeof obj.freshInputTokens === 'string') result.freshInputTokens = obj.freshInputTokens;
  if (typeof obj.service === 'string') result.service = obj.service;
  if (
    typeof obj.usageReportMetadata === 'object'
    && obj.usageReportMetadata !== null
    && !Array.isArray(obj.usageReportMetadata)
  ) {
    const metadata = obj.usageReportMetadata as Record<string, unknown>;
    result.usageReportMetadata = {
      pricingSnapshotHash: requireString(metadata, 'pricingSnapshotHash'),
      usageByServiceRoot: requireString(metadata, 'usageByServiceRoot'),
      receiptRoot: requireString(metadata, 'receiptRoot'),
      cumulativeFreshInputTokens: requireString(metadata, 'cumulativeFreshInputTokens'),
      cumulativeCachedInputTokens: requireString(metadata, 'cumulativeCachedInputTokens'),
      cumulativeOutputTokens: requireString(metadata, 'cumulativeOutputTokens'),
      cumulativeRequestCount: requireString(metadata, 'cumulativeRequestCount'),
      cumulativeAmountPaid: requireString(metadata, 'cumulativeAmountPaid'),
    };
  }
  return result;
}

export function decodePeerReport(data: Uint8Array): ChannelUsageReportPayload {
  const obj = parseJson(data);
  const result: ChannelUsageReportPayload = {
    channelId: requireString(obj, 'channelId'),
    buyer: requireString(obj, 'buyer'),
    seller: requireString(obj, 'seller'),
    sellerAgentId: requireString(obj, 'sellerAgentId'),
    cumulativeAmount: requireString(obj, 'cumulativeAmount'),
    metadata: requireString(obj, 'metadata'),
    metadataHash: requireString(obj, 'metadataHash'),
    selectionBeacon: requireString(obj, 'selectionBeacon'),
    verifierCount: requireNumber(obj, 'verifierCount'),
    pricingSnapshotHash: requireString(obj, 'pricingSnapshotHash'),
    serviceUsageLeaves: parseArray(obj, 'serviceUsageLeaves', parseServiceUsageLeaf),
    reportedAt: requireNumber(obj, 'reportedAt'),
  };
  if (typeof obj.buyerSpendingAuthSig === 'string') result.buyerSpendingAuthSig = obj.buyerSpendingAuthSig;
  return result;
}

export function decodeReportAck(data: Uint8Array): UsageReportAckPayload {
  const obj = parseJson(data);
  const result: UsageReportAckPayload = {
    channelId: requireString(obj, 'channelId'),
    reportHash: requireString(obj, 'reportHash'),
    verifierAgentId: requireString(obj, 'verifierAgentId'),
    accepted: requireBoolean(obj, 'accepted'),
  };
  if (typeof obj.reason === 'string') result.reason = obj.reason;
  if (typeof obj.attestation === 'object' && obj.attestation !== null && !Array.isArray(obj.attestation)) {
    const attestation = obj.attestation as Record<string, unknown>;
    result.attestation = {
      channelId: requireString(attestation, 'channelId'),
      reportHash: requireString(attestation, 'reportHash'),
      seller: requireString(attestation, 'seller'),
      sellerAgentId: requireString(attestation, 'sellerAgentId'),
      buyer: requireString(attestation, 'buyer'),
      cumulativeAmount: requireString(attestation, 'cumulativeAmount'),
      metadataHash: requireString(attestation, 'metadataHash'),
      pricingSnapshotHash: requireString(attestation, 'pricingSnapshotHash'),
      usageByServiceRoot: requireString(attestation, 'usageByServiceRoot'),
      verifier: requireString(attestation, 'verifier'),
      verifierAgentId: requireString(attestation, 'verifierAgentId'),
      timestamp: requireNumber(attestation, 'timestamp'),
      signature: requireString(attestation, 'signature'),
    };
  }
  return result;
}

function requireNumber(obj: Record<string, unknown>, field: string): number {
  const val = obj[field];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`Missing or invalid number field: ${field}`);
  }
  return val;
}

function requireBoolean(obj: Record<string, unknown>, field: string): boolean {
  const val = obj[field];
  if (typeof val !== 'boolean') {
    throw new Error(`Missing or invalid boolean field: ${field}`);
  }
  return val;
}

function parseArray<T>(
  obj: Record<string, unknown>,
  field: string,
  parseItem: (item: Record<string, unknown>) => T,
): T[] {
  const val = obj[field];
  if (!Array.isArray(val)) {
    throw new Error(`Missing or invalid array field: ${field}`);
  }
  return val.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Invalid object at ${field}[${index}]`);
    }
    return parseItem(item as Record<string, unknown>);
  });
}

function parseServiceUsageLeaf(obj: Record<string, unknown>): ChannelUsageReportServiceUsageLeafPayload {
  return {
    channelId: requireString(obj, 'channelId'),
    provider: requireString(obj, 'provider'),
    service: requireString(obj, 'service'),
    serviceIdHash: requireString(obj, 'serviceIdHash'),
    inputUsdPerMillion: requireString(obj, 'inputUsdPerMillion'),
    cachedInputUsdPerMillion: requireString(obj, 'cachedInputUsdPerMillion'),
    outputUsdPerMillion: requireString(obj, 'outputUsdPerMillion'),
    serviceMode: requireString(obj, 'serviceMode'),
    cumulativeFreshInputTokens: requireString(obj, 'cumulativeFreshInputTokens'),
    cumulativeCachedInputTokens: requireString(obj, 'cumulativeCachedInputTokens'),
    cumulativeOutputTokens: requireString(obj, 'cumulativeOutputTokens'),
    cumulativeRequestCount: requireString(obj, 'cumulativeRequestCount'),
    cumulativeAmountPaid: requireString(obj, 'cumulativeAmountPaid'),
  };
}
