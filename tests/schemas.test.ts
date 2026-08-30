import { describe, expect, it } from 'vitest';

import { SchemaValidationError, validateReplyText, validateSchema } from '../src/schemas.js';

const common = {
  schemaVersion: 1 as const,
  revision: 3,
  title: 'Location preference',
  body: 'Choose the bounded fixture answer.',
  effect: 'Updates only the owning workflow after acknowledgement.',
};

const option = (value: string, label: string) => ({ value, label, effect: `Records ${label}.` });

describe('the interaction schema primitives', () => {
  it.each([
    ['notification', { ...common, acknowledgeLabel: 'Acknowledge' }],
    ['single_enum', { ...common, options: [option('remote', 'Remote'), option('hybrid', 'Hybrid')] }],
    [
      'multi_enum_object',
      {
        ...common,
        fields: [
          { name: 'location', label: 'Location', options: [option('remote', 'Remote')] },
          { name: 'cadence', label: 'Cadence', options: [option('daily', 'Daily')] },
        ],
        reviewLabel: 'Review',
        confirmLabel: 'Confirm',
      },
    ],
    [
      'reply_text',
      { ...common, minLength: 3, maxLength: 80, submitLabel: 'Reply directly' },
    ],
    [
      'choice_with_optional_reply',
      {
        ...common,
        options: [option('drop_lead', 'Drop lead'), option('custom_guidance', 'Give custom guidance')],
        replyOption: 'custom_guidance',
        reply: { minLength: 3, maxLength: 80, submitLabel: 'Send instructions' },
      },
    ],
  ] as const)('validates %s defensively', (kind, schema) => {
    const validated = validateSchema(kind, schema);
    expect(validated).toEqual(schema);
    expect(validated).not.toBe(schema);
  });

  it.each([
    ['notification', { ...common, schemaVersion: 2, acknowledgeLabel: 'Acknowledge' }, 'schemaVersion must equal 1'],
    ['single_enum', { ...common, options: [] }, 'options must contain between 1 and 10 items'],
    [
      'multi_enum_object',
      {
        ...common,
        fields: [
          { name: 'same', label: 'One', options: [option('a', 'A')] },
          { name: 'same', label: 'Two', options: [option('b', 'B')] },
        ],
        reviewLabel: 'Review',
        confirmLabel: 'Confirm',
      },
      'field names must be unique',
    ],
    [
      'reply_text',
      { ...common, minLength: 9, maxLength: 3, submitLabel: 'Reply directly' },
      'minLength cannot exceed maxLength',
    ],
  ] as const)('rejects invalid %s schemas', (kind, schema, message) => {
    expect(() => validateSchema(kind, schema)).toThrowError(message);
  });

  it('rejects unknown fields, including private evidence', () => {
    expect(() =>
      validateSchema('notification', {
        ...common,
        acknowledgeLabel: 'Acknowledge',
        privateEvidence: 'must not be accepted',
      }),
    ).toThrowError('unknown schema fields: privateEvidence');
  });

  it('validates bounded reply text without unsafe regular-expression features', () => {
    const schema = validateSchema('reply_text', {
      ...common,
      minLength: 3,
      maxLength: 20,
      pattern: '^[A-Za-z ]+$',
      submitLabel: 'Reply directly',
    });
    expect(validateReplyText(schema, 'Valid text')).toBe('Valid text');
    expect(() => validateReplyText(schema, 'no!')).toThrowError('reply text does not match the required pattern');
    expect(() => validateSchema('reply_text', { ...schema, pattern: '(?=unsafe).*' })).toThrow(SchemaValidationError);
  });

  it('requires the optional reply branch to name exactly one declared option', () => {
    expect(() => validateSchema('choice_with_optional_reply', {
      ...common,
      options: [option('drop_lead', 'Drop lead')],
      replyOption: 'custom_guidance',
      reply: { minLength: 1, maxLength: 80, submitLabel: 'Send instructions' },
    })).toThrowError('replyOption must match a declared option');
  });
});
