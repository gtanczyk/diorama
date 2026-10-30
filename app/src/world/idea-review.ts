import { z } from 'zod';

export const IdeaReview = z.object({
  understanding: z.string().min(1).max(700),
  questions: z.array(z.object({
    question: z.string().min(1).max(100),
    why: z.string().max(300),
    presentation: z.enum(['pictures', 'text']).optional(),
    options: z.array(z.string().min(1).max(96)).max(3),
    visuals: z.array(z.object({ scene: z.string().min(1).max(500), photo: z.number().int().nonnegative().optional() })).max(3).optional(),
    photo: z.number().int().nonnegative().optional(),
    video: z.object({ id: z.string(), seconds: z.number().nonnegative() }).optional(),
  })).max(1),
  styles: z.array(z.object({ title: z.string().min(1).max(80), description: z.string().min(10).max(500) })).max(3),
});
export type IdeaReview = z.infer<typeof IdeaReview>;

/** Only explicit creator decisions, never the reviewer's guesses or unanswered suggestions. */
export const CreativeChoices = z.object({
  answers: z.array(z.object({ question: z.string().min(1).max(240), answer: z.string().trim().min(1).max(600) })).max(3),
  style: z.string().trim().min(10).max(500).optional(),
  styleReference: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  note: z.string().trim().max(1000).optional(),
}).refine(v => !v.styleReference || !!v.style, 'A style reference needs a chosen style.');
export type CreativeChoices = z.infer<typeof CreativeChoices>;
export function refinedIdea(idea: string, choices?: CreativeChoices): string {
  if (!choices) return idea.trim();
  const lines = choices.answers.map(a => `${a.question}\n${a.answer}`);
  if (choices.style) lines.push(`Visual style chosen by the creator: ${choices.style}`);
  if (choices.note) lines.push(choices.note);
  return [idea.trim(), ...(lines.length ? [`Creator's clarifications (these override earlier ambiguity; keep the original story language unless explicitly changed):\n${lines.join('\n\n')}`] : [])].join('\n\n');
}
