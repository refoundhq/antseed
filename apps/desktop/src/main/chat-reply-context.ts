export type ChatReplyReference = {
  messageId: string;
  role: string;
  senderLabel: string;
  excerpt: string;
  createdAt?: number;
  conversationId?: string;
};

export type ReplyContextDetails = ChatReplyReference & {
  expectedUserExcerpt?: string;
};

export type ParsedReplyWrappedPrompt = {
  visibleText: string;
  replyTo: ChatReplyReference | null;
};

type ReplyPromptPayload = {
  version: 1;
  replyTo: ChatReplyReference;
  visibleTextBase64: string;
};

type ReplyExcerptBlock =
  | { type: 'text'; text?: string }
  | { type: 'file'; fileName?: string }
  | { type: string; [key: string]: unknown };

export const ANTSEED_REPLY_CONTEXT_CUSTOM_TYPE = 'antseed.reply_context';
export const ANTSEED_REPLY_CONTEXT_JSON_START = '<antseed_reply_context_json>';
export const ANTSEED_REPLY_CONTEXT_JSON_END = '</antseed_reply_context_json>';
export const ANTSEED_REPLY_CONTEXT_START = '<antseed_reply_context>';
export const ANTSEED_REPLY_CONTEXT_END = '</antseed_reply_context>';
export const ANTSEED_REPLY_USER_MESSAGE_START = '<antseed_user_message>';
export const ANTSEED_REPLY_USER_MESSAGE_END = '</antseed_user_message>';

export function normalizeReplyContextExcerpt(value: unknown, maxLength = 500): string {
  const excerpt = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!excerpt) return '';
  return excerpt.length > maxLength ? `${excerpt.slice(0, maxLength).trimEnd()}...` : excerpt;
}

export function normalizeReplyReference(value: unknown): ChatReplyReference | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const messageId = typeof data.messageId === 'string' ? data.messageId.trim() : '';
  const role = typeof data.role === 'string' ? data.role.trim() : '';
  const senderLabel = typeof data.senderLabel === 'string' ? data.senderLabel.trim() : '';
  const excerpt = normalizeReplyContextExcerpt(data.excerpt);
  if (!messageId || !role || !senderLabel || !excerpt) return null;
  const createdAt = typeof data.createdAt === 'number' && Number.isFinite(data.createdAt) && data.createdAt > 0
    ? Math.floor(data.createdAt)
    : undefined;
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
  return {
    messageId,
    role,
    senderLabel,
    excerpt,
    ...(createdAt ? { createdAt } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

export function normalizeReplyContextDetails(value: unknown): ReplyContextDetails | null {
  const replyTo = normalizeReplyReference(value);
  if (!replyTo || !value || typeof value !== 'object') return replyTo;
  const expectedUserExcerpt = normalizeReplyContextExcerpt((value as Record<string, unknown>).expectedUserExcerpt, 240);
  return {
    ...replyTo,
    ...(expectedUserExcerpt ? { expectedUserExcerpt } : {}),
  };
}

export function extractUiContentExcerpt(content: string | ReplyExcerptBlock[]): string {
  if (typeof content === 'string') return normalizeReplyContextExcerpt(content, 240);
  const parts = content
    .filter((block) => block.type === 'text' || block.type === 'file')
    .map((block) => {
      if (block.type === 'file') return block.fileName ? `[File: ${block.fileName}]` : '';
      if (block.type === 'text') return String(block.text || '');
      return '';
    })
    .filter(Boolean);
  return normalizeReplyContextExcerpt(parts.join(' '), 240);
}

export function isExpectedReplyUserMessage(replyTo: ReplyContextDetails, content: string | ReplyExcerptBlock[]): boolean {
  // Legacy antseed.reply_context entries are only safe to attach when they
  // carry an explicit correlation to the expected outgoing user text. Early
  // dev builds did not include expectedUserExcerpt; attaching those entries to
  // the next user message can stale-link unrelated later prompts.
  if (!replyTo.expectedUserExcerpt) return false;
  const actualExcerpt = extractUiContentExcerpt(content);
  return Boolean(actualExcerpt && actualExcerpt === replyTo.expectedUserExcerpt);
}

function extractBetween(value: string, start: string, end: string): string | null {
  const startIndex = value.indexOf(start);
  if (startIndex < 0) return null;
  const contentStart = startIndex + start.length;
  const endIndex = value.indexOf(end, contentStart);
  if (endIndex < 0) return null;
  return value.slice(contentStart, endIndex).trim();
}

function extractBetweenLast(value: string, start: string, end: string): string | null {
  const startIndex = value.indexOf(start);
  if (startIndex < 0) return null;
  const contentStart = startIndex + start.length;
  const endIndex = value.lastIndexOf(end);
  if (endIndex < contentStart) return null;
  return value.slice(contentStart, endIndex).trim();
}

function encodeReplyVisibleText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeReplyVisibleText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function buildReplyContextMessageContent(replyTo: ChatReplyReference): string {
  return [
    'The immediately following user message in this transcript is a reply to an earlier chat message.',
    '',
    'Earlier message:',
    `Sender: ${replyTo.senderLabel}`,
    `Role: ${replyTo.role}`,
    'Excerpt:',
    '"""',
    replyTo.excerpt,
    '"""',
    '',
    'Treat the earlier message as the primary local context and active topic for interpreting that following user message.',
    'This is especially important for references like "that", "it", "continue", "another", "more", "give another", "explain this", or "what you wrote".',
    'If the earlier message conflicts with the most recent conversation topic, prefer the earlier message being replied to.',
    'Do not answer the earlier message by itself. Answer only the following user message, interpreted as a direct reply to the earlier message.',
  ].join('\n');
}

export function buildReplyContextDetails(replyTo: ChatReplyReference, expectedUserText: string): ReplyContextDetails {
  const expectedUserExcerpt = normalizeReplyContextExcerpt(expectedUserText, 240);
  return {
    ...replyTo,
    ...(expectedUserExcerpt ? { expectedUserExcerpt } : {}),
  };
}

export function buildReplyWrappedPrompt(userPrompt: string, replyTo: ChatReplyReference | null): string {
  if (!replyTo) return userPrompt || ' ';
  const visibleText = userPrompt || ' ';
  const replyMetadata: ReplyPromptPayload = {
    version: 1,
    replyTo,
    visibleTextBase64: encodeReplyVisibleText(visibleText),
  };
  return [
    ANTSEED_REPLY_CONTEXT_JSON_START,
    JSON.stringify(replyMetadata),
    ANTSEED_REPLY_CONTEXT_JSON_END,
    '',
    ANTSEED_REPLY_CONTEXT_START,
    buildReplyContextMessageContent(replyTo)
      .replace('The immediately following user message in this transcript', 'The user message below')
      .replace(/that following user message/g, 'the user message below')
      .replace(/the following user message/g, 'the user message below'),
    ANTSEED_REPLY_CONTEXT_END,
    '',
    ANTSEED_REPLY_USER_MESSAGE_START,
    visibleText,
    ANTSEED_REPLY_USER_MESSAGE_END,
  ].join('\n');
}

export function parseReplyWrappedPrompt(text: string): ParsedReplyWrappedPrompt {
  if (!text.startsWith(ANTSEED_REPLY_CONTEXT_JSON_START)) {
    return { visibleText: text, replyTo: null };
  }
  const replyJson = extractBetween(text, ANTSEED_REPLY_CONTEXT_JSON_START, ANTSEED_REPLY_CONTEXT_JSON_END);
  if (replyJson === null) {
    return { visibleText: text, replyTo: null };
  }

  try {
    const parsed = JSON.parse(replyJson) as Record<string, unknown>;
    const payloadReplyTo = normalizeReplyReference(parsed.replyTo);
    const payloadVisibleText = decodeReplyVisibleText(parsed.visibleTextBase64);
    if (payloadReplyTo && payloadVisibleText !== null) {
      return { visibleText: payloadVisibleText, replyTo: payloadReplyTo };
    }

    // Backward-compatible parser for early wrapped prompts whose JSON block was
    // the reply reference itself and whose visible text was raw tag-delimited.
    const legacyReplyTo = normalizeReplyReference(parsed);
    const legacyVisibleText = extractBetweenLast(text, ANTSEED_REPLY_USER_MESSAGE_START, ANTSEED_REPLY_USER_MESSAGE_END);
    if (legacyReplyTo && legacyVisibleText !== null) {
      return { visibleText: legacyVisibleText, replyTo: legacyReplyTo };
    }
  } catch {
    return { visibleText: text, replyTo: null };
  }

  return { visibleText: text, replyTo: null };
}
