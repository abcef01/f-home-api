import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readJson(url) {
  return JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8'));
}
