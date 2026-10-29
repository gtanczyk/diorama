// Which models make a world, as picked in Studio Setup (~/.config/diorama/models.json). DIORAMA_SPARK_VIA and
// DIORAMA_IMAGE_VIA, where the Studio or a command was started, win over the pick.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../secrets.ts';

export type ModelChoice = { spark?: string; image?: string };

const file = () => path.join(configDir(), 'models.json');

export function readModelChoice(): ModelChoice {
  try {
    const c = JSON.parse(fs.readFileSync(file(), 'utf8')) as ModelChoice;
    return { spark: typeof c.spark === 'string' ? c.spark : undefined, image: typeof c.image === 'string' ? c.image : undefined };
  } catch {
    return {};
  }
}

export function writeModelChoice(choice: ModelChoice) {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), `${JSON.stringify(choice, null, 2)}\n`);
}

/** The model for Spark's asks and for pictures: the environment first, then the Setup pick. */
export const sparkChoice = () => process.env.DIORAMA_SPARK_VIA || readModelChoice().spark;
export const imageChoice = () => process.env.DIORAMA_IMAGE_VIA || readModelChoice().image;
