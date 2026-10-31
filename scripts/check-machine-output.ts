// Run the built-in Split and Diagram machines against a live model on twelve short,
// invented paper abstracts and report how their answers parse: how many split into two
// cards or more, and how many relation lines a diagram keeps or drops. Nothing is
// stored. Usage: CHECK_MODEL=deepseek-chat node --import tsx scripts/check-machine-output.ts
import { executeModel } from '../server/llm/model.js';
import { BUILT_IN_MACHINES } from '../shared/machines.js';
import { machineOutput, parseOutput } from '../shared/machine-output.js';
import type { RunInput } from '../shared/types/domain.js';

const papers = [
  'Night-shift nurses who napped 30 minutes made fewer medication errors; the effect faded after three weeks.',
  'Cities that announced light-rail lines saw land prices rise near stations before construction began.',
  'A four-day week trial in 61 firms kept output level while sick days fell by a third.',
  'Children taught fractions with number lines outperformed peers taught with pie charts a year later.',
  'Rooftop solar adoption spread street by street, suggesting neighbours copy visible installations.',
  'Remote workers reported more focus time but fewer weak ties, and promotions slowed for juniors.',
  'Soil microbes in no-till fields stored more carbon, though yields dropped in wet years.',
  'Hospital readmissions fell when pharmacists called patients two days after discharge.',
  'Bike-lane networks raised cycling only once they connected; isolated lanes changed little.',
  'Short daily retrieval quizzes beat rereading for retention among adult language learners.',
  'Heat waves raised emergency visits most in neighbourhoods with little tree cover.',
  'Open-plan offices cut face-to-face conversation and increased email volume.',
];
const model = process.env.CHECK_MODEL ?? 'deepseek-chat';
const template = (name: string) => BUILT_IN_MACHINES.find((m) => m.name === name)!.template;
const inputs = (slot: string, texts: string[], prompt: string): RunInput[] => [
  ...texts.map((text, position) => ({
    position,
    kind: 'reference' as const,
    label: slot,
    role: 'user' as const,
    revision_id: `paper-${position}`,
    content: { format: 'text' as const, text },
  })),
  {
    position: texts.length,
    kind: 'prompt' as const,
    label: 'Prompt',
    role: 'user' as const,
    revision_id: 'prompt',
    content: { format: 'text' as const, text: prompt },
  },
];
const ask = async (slot: string, texts: string[], prompt: string) =>
  (
    await executeModel(
      {
        model,
        maxOutputTokens: 900,
        inputs: inputs(slot, texts, prompt),
        signal: AbortSignal.timeout(120_000),
      },
      () => {},
    )
  ).text;

const split = template('Split');
const splits = await Promise.all(papers.map((paper) => ask('text', [paper], split)));
const counts = splits.map((text) => parseOutput(text, machineOutput(split)).items.length);
console.log(
  `Split: ${counts.filter((n) => n >= 2).length}/12 answers split; cards per answer ${counts.join(', ')}`,
);

const diagram = template('Diagram');
const groups = [papers.slice(0, 4), papers.slice(4, 8), papers.slice(8, 12)];
for (const [index, group] of groups.entries()) {
  const text = await ask('material', group, diagram);
  const parts = parseOutput(text, machineOutput(diagram));
  console.log(
    `Diagram ${index + 1}: ${parts.items.length} cards, ${parts.arrows.length} arrows kept, ${parts.dropped} dropped`,
  );
  if (parts.items.length < 2 || parts.dropped) console.log(text);
}
