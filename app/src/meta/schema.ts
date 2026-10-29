// A zod shape as the JSON Schema that structured outputs (Anthropic output_config.format, OpenRouter
// response_format) hold a model's answer to: every object closed, no length or number limits (the API takes none;
// zod still checks them after), fields with a default asked for outright so few stay optional.
import { z } from 'zod';

type Json = Record<string, unknown>;

class Unsupported extends Error {}

function convert(t: z.ZodTypeAny): Json {
  const def = t._def as { typeName: string } & Record<string, any>;
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: (def.checks as { kind: string }[]).some((c) => c.kind === 'int') ? 'integer' : 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodArray':
      return { type: 'array', items: convert(def.type) };
    case 'ZodObject': {
      if (def.unknownKeys === 'passthrough' || def.catchall?._def.typeName !== 'ZodNever') throw new Unsupported('open object');
      const shape = (t as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const required = Object.keys(shape).filter((k) => shape[k]._def.typeName !== 'ZodOptional');
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, convert(v)])), required, additionalProperties: false };
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return { anyOf: [...(def.options as z.ZodTypeAny[])].map(convert) };
    case 'ZodNullable':
      return { anyOf: [convert(def.innerType), { type: 'null' }] };
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodCatch':
      return convert(def.innerType);
    case 'ZodEffects':
      return convert(def.schema);
    case 'ZodBranded':
      return convert(def.type);
    case 'ZodPipeline':
      return convert(def.in);
    default:
      // Records, tuples, any: no closed shape to hold the model to.
      throw new Unsupported(def.typeName);
  }
}

/** The JSON Schema for a structured answer, or undefined when the shape cannot be held (records, tuples, any). */
export function answerSchema(t: z.ZodTypeAny): Json | undefined {
  try {
    const schema = convert(t);
    return schema.type === 'object' ? schema : undefined;
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
}
