import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { answerSchema } from '../src/meta/schema.ts';
import { Story } from '../src/story/schema.ts';

describe('answerSchema', () => {
  it('closes every object and asks for defaulted fields outright', () => {
    const s = answerSchema(z.object({ a: z.string().min(2), b: z.array(z.number().int()).max(3).default([]), c: z.boolean().optional() }));
    expect(s).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'integer' } }, c: { type: 'boolean' } },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });

  it('holds the story shape, unions included', () => {
    const s = JSON.stringify(answerSchema(Story));
    expect(s).toContain('"anyOf"');
    expect(s).not.toContain('minItems');
  });

  it('gives up on records and tuples', () => {
    expect(answerSchema(z.record(z.string(), z.number()))).toBeUndefined();
    expect(answerSchema(z.object({ box: z.tuple([z.number(), z.number()]) }))).toBeUndefined();
  });
});

describe('the story on the wire', () => {
  it('reads {op, key} effects back as Story effects and leaves Story-shaped ones alone', async () => {
    const { fromWire } = await import('../src/story/schema.ts');
    expect(fromWire({ do: [{ op: 'give', key: 'ticket' }, { set: 'lit' }], op: 'x' })).toEqual({ do: [{ give: 'ticket' }, { set: 'lit' }], op: 'x' });
  });
});
