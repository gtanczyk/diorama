import { useEffect, useState } from 'preact/hooks';
import { CreativeChoices } from '../src/world/idea-review.ts';
import { fileUrl } from './api.ts';

type CreatorBrief = { idea: string; choices?: CreativeChoices };

/** The build keeps its full instructions; the conversation shows what the person actually wrote. */
export function useCreatorBrief(slug: string): CreatorBrief | null {
  const [saved, setSaved] = useState<{ slug: string; brief: CreatorBrief } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const options = { cache: 'no-store' as const, signal: controller.signal };
    const version = Date.now();
    void (async () => {
      const source = await fetch(fileUrl(slug, 'creative-brief.json', version), options)
        .then(r => r.ok ? r.json() : null).catch(() => null);
      let brief: CreatorBrief;
      if (source && typeof source.idea === 'string' && source.idea.trim()) {
        const choices = CreativeChoices.safeParse(source.choices);
        brief = { idea: source.idea.trim(), ...(choices.success && { choices: choices.data }) };
      } else {
        const idea = await fetch(fileUrl(slug, 'idea.txt', version), options)
          .then(r => r.ok ? r.text() : '').catch(() => '');
        brief = { idea: idea.trim() };
      }
      if (!controller.signal.aborted) setSaved({ slug, brief });
    })();
    return () => controller.abort();
  }, [slug]);
  return saved?.slug === slug ? saved.brief : null;
}

export function CreatorIdea({ brief }: { brief: CreatorBrief }) {
  const choices = brief.choices;
  const hasChoices = choices && (choices.answers.length > 0 || choices.style || choices.note);
  return <div class="creator-idea">
    <div class="idea-bubble">{brief.idea}</div>
    {hasChoices && <details class="creator-choices">
      <summary>Your choices{choices.answers.length > 0 && <span> · {choices.answers.length} {choices.answers.length === 1 ? 'answer' : 'answers'}</span>}{choices.style && <span> · visual style</span>}</summary>
      <dl>{choices.answers.map(a => <div><dt>{a.question}</dt><dd>{a.answer}</dd></div>)}
        {choices.style && <div><dt>Visual style</dt><dd>{choices.style}</dd></div>}
        {choices.note && <div><dt>Your note</dt><dd>{choices.note}</dd></div>}
      </dl>
    </details>}
  </div>;
}
