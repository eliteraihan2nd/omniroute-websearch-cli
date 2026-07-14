// Generates src/version.generated.ts from package.json so the version is a
// build-time constant (bundled into the standalone binary — no runtime
// package.json lookup, which failed inside bun --compile binaries).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'src', 'version.generated.ts');
writeFileSync(out, `export const VERSION = '${version}';\n`);
console.log(`version.generated.ts -> ${version}`);
