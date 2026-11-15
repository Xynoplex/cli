// generate.mjs — what every generator in scripts/ shares: the repository it
// writes in, --check, how a refusal is said, the schemas it reads, where a
// `$ref` leads, and Go comments as gofmt leaves them.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** --check compares without writing, and fails when a committed file differs. */
export const CHECK = process.argv.includes('--check');

export function refuse(where, message) {
  console.error(`✗ ${where}: ${message}`);
  process.exit(1);
}

const parsed = new Map();
/** The JSON at `path`, a repository path, read once. */
export function schemaAt(path) {
  if (!parsed.has(path)) parsed.set(path, JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')));
  return parsed.get(path);
}

export const pascal = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;

/** The repository path a `$ref` written in the file at `from` names, and its fragment. */
export function target(from, ref) {
  const [file, fragment = ''] = ref.split('#');
  return { path: file ? relative(ROOT, resolve(dirname(resolve(ROOT, from)), file)) : from, fragment };
}

/** The value a `$ref` written in the file at `from` names. */
export function referred(from, ref) {
  const { path, fragment } = target(from, ref);
  let value = schemaAt(path);
  for (const step of fragment.split('/').filter(Boolean)) value = value?.[step];
  return value;
}

/** A schema's description, or else the description of the schema its `$ref` names. */
export function describe(schema, from) {
  if (schema.description) return schema.description;
  return schema.$ref ? referred(from, schema.$ref)?.description : undefined;
}

/** Every file the schemas at `paths` refer to, and those, by repository path, sorted. */
export function reach(paths) {
  const reached = new Set();
  const visit = (path) => {
    if (reached.has(path)) return;
    reached.add(path);
    (function walk(node) {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) visit(target(path, value).path);
          else walk(value);
        }
      }
    })(schemaAt(path));
  };
  paths.forEach(visit);
  return [...reached].sort();
}

/** `value` as compact JSON in a Go string literal. */
export const goJSON = (value) => JSON.stringify(JSON.stringify(value));

/** `text` as `//` comment lines, wrapped at `width` columns behind `indent`, as gofmt leaves them. */
export function goComment(text, indent = '', width = 78) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && `${indent}// ${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${indent}// ${l}`).join('\n');
}

/** The first lines of a generated Go file: what it is generated from, and how. */
export const goHeader = (from, script) => `// Code generated from ${from} — DO NOT EDIT.
//
// Regenerate: node scripts/${script}
`;

/** Write `text` to `path`, a repository path, or with --check only compare, failing when they differ. */
export function writeOrCheck(path, text) {
  const file = resolve(ROOT, path);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current === text) {
    console.log(`ok    ${path}`);
    return;
  }
  console.log(`${current ? 'DRIFT' : 'new  '} ${path}`);
  if (CHECK) process.exit(1);
  writeFileSync(file, text);
}
