import { describe, expect, it } from 'vitest';
import {
  hasJsonContentType,
  parseJsonObject,
  requireFiniteNumberField,
  requireStringField,
  tryParseJsonObject,
} from '../src/utils/json-codec.js';

describe('json-codec utilities', () => {
  it('parses JSON objects from bytes and strings', () => {
    expect(parseJsonObject(new TextEncoder().encode('{"ok":true}'))).toEqual({ ok: true });
    expect(parseJsonObject('{"name":"antseed"}')).toEqual({ name: 'antseed' });
  });

  it('rejects non-object JSON and oversized payloads', () => {
    expect(() => parseJsonObject('[]')).toThrow('Expected JSON object');
    expect(() => parseJsonObject('"x"')).toThrow('Expected JSON object');
    expect(() => parseJsonObject('{"too":"large"}', {
      maxBytes: 4,
      payloadName: 'Test payload',
    })).toThrow('Test payload too large');
  });

  it('returns null from tryParseJsonObject for invalid inputs', () => {
    expect(tryParseJsonObject('{')).toBeNull();
    expect(tryParseJsonObject('[]')).toBeNull();
    expect(tryParseJsonObject('{"ok":true}')).toEqual({ ok: true });
  });

  it('detects JSON content type case-insensitively', () => {
    expect(hasJsonContentType({ 'content-type': 'application/json; charset=utf-8' })).toBe(true);
    expect(hasJsonContentType({ 'Content-Type': 'Application/JSON' })).toBe(true);
    expect(hasJsonContentType({ 'content-type': 'text/plain' })).toBe(false);
  });

  it('validates required object fields', () => {
    const obj = { text: 'value', count: 3 };
    expect(requireStringField(obj, 'text')).toBe('value');
    expect(requireFiniteNumberField(obj, 'count')).toBe(3);
    expect(() => requireStringField(obj, 'missing')).toThrow('Missing or invalid string field');
    expect(() => requireFiniteNumberField({ count: Number.NaN }, 'count')).toThrow('Missing or invalid number field');
  });
});
