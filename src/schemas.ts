import { z } from 'zod';

export const INTERACTION_KINDS = [
  'notice',
  'notification',
  'single_enum',
  'multi_enum_object',
  'reply_text',
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

const MAX_TITLE = 120;
const MAX_BODY = 3_000;
const MAX_EFFECT = 500;
const MAX_LABEL = 80;
const MAX_OPTIONS = 10;
// Keep multi-field Telegram wizards bounded and reviewable. This is an
// application safety bound, not a Telegram platform limit. Callers with more
// than eight decisions must split them into multiple related packets.
const MAX_FIELDS = 8;
const MAX_TEXT_LENGTH = 2_000;
const MAX_PATTERN_LENGTH = 256;
const symbolicValue = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export class SchemaValidationError extends Error {
  readonly code = 'invalid_schema';

  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

const boundedText = (name: string, maximum: number) =>
  z
    .string({ error: `${name} must be a string` })
    .min(1, { error: `${name} must contain between 1 and ${maximum} characters` })
    .max(maximum, { error: `${name} must contain between 1 and ${maximum} characters` });

const commonShape = {
  schemaVersion: z.literal(1, { error: 'schemaVersion must equal 1' }),
  revision: z.number({ error: 'revision must be an integer of at least 1' }).int({ error: 'revision must be an integer of at least 1' }).min(1, { error: 'revision must be an integer of at least 1' }),
  title: boundedText('title', MAX_TITLE),
  body: boundedText('body', MAX_BODY),
  effect: boundedText('effect', MAX_EFFECT),
};

const optionSchema = z
  .object({
    value: z.string().regex(symbolicValue, { error: 'option value must be a bounded symbolic value' }),
    label: boundedText('option label', MAX_LABEL),
    effect: boundedText('option effect', MAX_EFFECT),
  })
  .strict();

const optionsSchema = (name = 'options') =>
  z
    .array(optionSchema, { error: `${name} must contain between 1 and ${MAX_OPTIONS} items` })
    .min(1, { error: `${name} must contain between 1 and ${MAX_OPTIONS} items` })
    .max(MAX_OPTIONS, { error: `${name} must contain between 1 and ${MAX_OPTIONS} items` })
    .superRefine((options, context) => {
      const values = options.map((option) => option.value);
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', message: `${name} values must be unique` });
      }
    });

const noticeSchema = z
  .object({
    ...commonShape,
  })
  .strict();

const notificationSchema = z
  .object({
    ...commonShape,
    acknowledgeLabel: boundedText('acknowledgeLabel', MAX_LABEL).default('Acknowledge'),
  })
  .strict();

const singleEnumSchema = z
  .object({
    ...commonShape,
    options: optionsSchema(),
  })
  .strict();

const multiEnumSchema = z
  .object({
    ...commonShape,
    fields: z
      .array(
        z
          .object({
            name: z.string().regex(symbolicValue, { error: 'field name must be a bounded symbolic value' }),
            label: boundedText('field label', MAX_LABEL),
            options: optionsSchema('field options'),
          })
          .strict(),
        { error: `fields must contain between 1 and ${MAX_FIELDS} items` },
      )
      .min(1, { error: `fields must contain between 1 and ${MAX_FIELDS} items` })
      .max(MAX_FIELDS, { error: `fields must contain between 1 and ${MAX_FIELDS} items` }),
    reviewLabel: boundedText('reviewLabel', MAX_LABEL),
    confirmLabel: boundedText('confirmLabel', MAX_LABEL),
  })
  .strict()
  .superRefine((schema, context) => {
    const names = schema.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', message: 'field names must be unique' });
    }
  });

const replyTextSchema = z
  .object({
    ...commonShape,
    minLength: z.number().int().min(0).max(MAX_TEXT_LENGTH),
    maxLength: z.number().int().min(1).max(MAX_TEXT_LENGTH),
    pattern: z.string().min(1).max(MAX_PATTERN_LENGTH).optional(),
    submitLabel: boundedText('submitLabel', MAX_LABEL),
  })
  .strict()
  .superRefine((schema, context) => {
    if (schema.minLength > schema.maxLength) {
      context.addIssue({ code: 'custom', message: 'minLength cannot exceed maxLength' });
    }
    if (schema.pattern !== undefined) {
      if (/\(\?|\\[1-9]/u.test(schema.pattern) || /\([^)]*[+*][^)]*\)[+*{]/u.test(schema.pattern)) {
        context.addIssue({
          code: 'custom',
          message: 'pattern cannot contain lookarounds, inline modifiers, backreferences, or nested quantifiers',
        });
        return;
      }
      try {
        new RegExp(schema.pattern, 'u');
      } catch {
        context.addIssue({ code: 'custom', message: 'pattern is not a valid regular expression' });
      }
    }
  });

export type NotificationSchema = z.output<typeof notificationSchema>;
export type NoticeSchema = z.output<typeof noticeSchema>;
export type SingleEnumSchema = z.output<typeof singleEnumSchema>;
export type MultiEnumSchema = z.output<typeof multiEnumSchema>;
export type ReplyTextSchema = z.output<typeof replyTextSchema>;
export type InteractionSchema = NoticeSchema | NotificationSchema | SingleEnumSchema | MultiEnumSchema | ReplyTextSchema;

const validators = {
  notice: noticeSchema,
  notification: notificationSchema,
  single_enum: singleEnumSchema,
  multi_enum_object: multiEnumSchema,
  reply_text: replyTextSchema,
} as const;

const validationMessage = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    return `unknown schema fields: ${[...issue.keys].sort().join(', ')}`;
  }
  return issue?.message ?? 'schema is invalid';
};

export function validateSchema(kind: 'notice', schema: unknown): NoticeSchema;
export function validateSchema(kind: 'notification', schema: unknown): NotificationSchema;
export function validateSchema(kind: 'single_enum', schema: unknown): SingleEnumSchema;
export function validateSchema(kind: 'multi_enum_object', schema: unknown): MultiEnumSchema;
export function validateSchema(kind: 'reply_text', schema: unknown): ReplyTextSchema;
export function validateSchema(kind: unknown, schema: unknown): InteractionSchema;
export function validateSchema(kind: unknown, schema: unknown): InteractionSchema {
  if (typeof kind !== 'string' || !INTERACTION_KINDS.includes(kind as InteractionKind)) {
    throw new SchemaValidationError('type is not a supported interaction primitive');
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new SchemaValidationError('schema must be an object');
  }
  const result = validators[kind as InteractionKind].safeParse(schema);
  if (!result.success) {
    throw new SchemaValidationError(validationMessage(result.error));
  }
  return structuredClone(result.data);
}

export function validateReplyText(schema: ReplyTextSchema, value: unknown): string {
  const validated = validateSchema('reply_text', schema);
  if (typeof value !== 'string') {
    throw new SchemaValidationError('reply text must be a string');
  }
  if (value.length < validated.minLength || value.length > validated.maxLength) {
    throw new SchemaValidationError(
      `reply text must contain between ${validated.minLength} and ${validated.maxLength} characters`,
    );
  }
  if (validated.pattern !== undefined) {
    const match = new RegExp(validated.pattern, 'u').exec(value);
    if (match?.index !== 0 || match[0].length !== value.length) {
      throw new SchemaValidationError('reply text does not match the required pattern');
    }
  }
  return value;
}
