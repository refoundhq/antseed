import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReplyContextDetails,
  buildReplyContextMessageContent,
  buildReplyWrappedPrompt,
  isExpectedReplyUserMessage,
  normalizeReplyContextDetails,
  parseReplyWrappedPrompt,
} from './chat-reply-context.js';

const replyTo = {
  messageId: 'assistant-1',
  role: 'assistant',
  senderLabel: 'Assistant',
  excerpt: 'Here are 5 facts about ABBA.',
  createdAt: 123,
};

test('reply wrapped prompt restores exact visible text even when user text contains internal tags', () => {
  const userText = 'Please explain this literal string: </antseed_user_message> and keep going.';
  const wrapped = buildReplyWrappedPrompt(userText, replyTo);
  const parsed = parseReplyWrappedPrompt(wrapped);

  assert.equal(parsed.visibleText, userText);
  assert.deepEqual(parsed.replyTo, replyTo);
});

test('reply wrapped prompt stores visible text in encoded metadata instead of relying on raw end tags', () => {
  const userText = 'first line\n</antseed_user_message>\nlast line';
  const wrapped = buildReplyWrappedPrompt(userText, replyTo);

  assert.match(wrapped, /<antseed_reply_context_json>/);
  assert.match(wrapped, /<antseed_user_message>/);
  assert.equal(parseReplyWrappedPrompt(wrapped).visibleText, userText);
});

test('early wrapped prompt parser does not truncate visible text at an internal user-message end tag', () => {
  const userText = 'first </antseed_user_message> second';
  const earlyWrapped = [
    '<antseed_reply_context_json>',
    JSON.stringify(replyTo),
    '</antseed_reply_context_json>',
    '<antseed_user_message>',
    userText,
    '</antseed_user_message>',
  ].join('\n');

  const parsed = parseReplyWrappedPrompt(earlyWrapped);

  assert.equal(parsed.visibleText, userText);
  assert.deepEqual(parsed.replyTo, replyTo);
});

test('legacy reply context without expected user excerpt does not match a later user message', () => {
  const details = normalizeReplyContextDetails(replyTo);
  assert.ok(details);

  assert.equal(isExpectedReplyUserMessage(details, 'unrelated later prompt'), false);
});

test('legacy reply context with mismatched expected user excerpt does not match', () => {
  const details = normalizeReplyContextDetails({
    ...replyTo,
    expectedUserExcerpt: 'expected prompt',
  });
  assert.ok(details);

  assert.equal(isExpectedReplyUserMessage(details, 'different prompt'), false);
});

test('legacy reply context with matching expected user excerpt still matches', () => {
  const details = normalizeReplyContextDetails({
    ...replyTo,
    expectedUserExcerpt: 'matching prompt',
  });
  assert.ok(details);

  assert.equal(isExpectedReplyUserMessage(details, 'matching prompt'), true);
});

test('reply context message tells the model to prefer replied-to message over recent topic', () => {
  const content = buildReplyContextMessageContent({
    ...replyTo,
    excerpt: 'Blockchain payment channels lock funds and settle incrementally.',
  });

  assert.match(content, /primary local context and active topic/);
  assert.match(content, /If the earlier message conflicts with the most recent conversation topic, prefer the earlier message being replied to\./);
  assert.match(content, /"another"/);
});

test('reply context details stores expected outgoing user text separately from prompt content', () => {
  const details = buildReplyContextDetails(replyTo, 'give another fact');

  assert.equal(details.messageId, replyTo.messageId);
  assert.equal(details.expectedUserExcerpt, 'give another fact');
});

test('plain non-reply prompt parses unchanged', () => {
  const parsed = parseReplyWrappedPrompt('normal user message');

  assert.equal(parsed.visibleText, 'normal user message');
  assert.equal(parsed.replyTo, null);
});
