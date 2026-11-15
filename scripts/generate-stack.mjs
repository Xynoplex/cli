#!/usr/bin/env node
// generate-stack.mjs — the launcher's types for its documents, and the
// schemas it reads them against, from the pinned protocol's specs/src/stack/
// and specs/src/kb-identity/ProjectConfig.json.
//
//   internal/launcher/stack/types_gen.go    a Go type for each document and
//                                           each object it reaches
//   internal/launcher/stack/schemas_gen.go  the text of every schema they
//                                           reach, and the schema each kind
//                                           of document is read against
//
// A document is each schema in specs/src/stack/ whose `kind` is a const, and
// the project file. The launcher validates a document against its schema and
// only then reads it, so a type states the schema's shape and no rule of its
// own: `oneOf`, `allOf` of a rule, a bound and the like are the validator's.
// A reference into specs/src/components/schemas is the SDK's type of that
// name. A schema form this generator does not render is refused by name,
// rather than rendered as a guess.
//
// --check compares without writing, and fails when a committed file differs.

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, describe, goComment, goHeader, goJSON, pascal, reach, refuse, schemaAt, target, writeOrCheck } from './lib/generate.mjs';

const STACK = 'protocol/specs/src/stack';
const PROJECT = 'protocol/specs/src/kb-identity/ProjectConfig.json';
const COMPONENTS = 'protocol/specs/src/components/schemas/';
const GO_OUT = 'internal/launcher/stack';
// The SDK's package of the spec's components. A wrong path fails the build.
const SDK_API = 'github.com/Xynoplex/sdk/go/api';

/** The keywords a type is made from, and those that are rules the validator enforces. */
const SHAPE = new Set(['title', 'type', 'description', 'properties', 'required', 'additionalProperties', 'propertyNames', '$ref']);
const RULES = new Set(['const', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'minProperties', 'oneOf', 'anyOf', 'not', 'allOf']);

const kinds = readdirSync(resolve(ROOT, STACK))
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => `${STACK}/${file}`)
  .filter((path) => typeof schemaAt(path).properties?.kind?.const === 'string');
for (const path of kinds) {
  const schema = schemaAt(path);
  if (schema.title !== schema.properties.kind.const) refuse(path, `its title, ${schema.title}, is not its kind, ${schema.properties.kind.const}`);
}
const documents = [...kinds, PROJECT];

/** Each type, by name, in the order it is first reached: its declaration. */
const types = new Map();
let usesAPI = false;

/**
 * The Go type of `schema`, written in the file at `from`, named `name` if it
 * is an object of its own, whose own objects are named from `prefix`.
 */
function typeOf(schema, from, name, prefix = name) {
  for (const keyword of Object.keys(schema)) {
    if (!SHAPE.has(keyword) && !RULES.has(keyword)) refuse(from, `${name} uses \`${keyword}\`, which this generator does not render`);
  }
  for (const rule of schema.allOf ?? []) {
    const ruled = rule.$ref ? schemaAt(target(from, rule.$ref).path) : rule;
    if (ruled.properties) refuse(from, `${name} is all of a schema with properties, which this generator does not merge`);
  }
  if (schema.$ref) {
    const { path, fragment } = target(from, schema.$ref);
    if (path.startsWith(COMPONENTS)) {
      usesAPI = true;
      const component = path.slice(COMPONENTS.length).replace(/\.json$/, '');
      if (fragment === '') return `api.${component}`;
      const property = fragment.match(/^\/properties\/([A-Za-z]+)$/);
      if (!property || !schemaAt(path).properties?.[property[1]]) refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
      return `api.${component}${pascal(property[1])}`;
    }
    if (fragment !== '') refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
    if (!path.startsWith(`${STACK}/`) && path !== PROJECT) refuse(from, `${name} refers to ${path}, outside the stack's schemas and the components`);
    const referred = schemaAt(path);
    if (!referred.title) refuse(path, `referred to by ${name}, and has no title`);
    return typeOf(referred, path, referred.title);
  }
  switch (schema.type) {
    case 'object':
      if (schema.properties) return objectType(schema, from, name, prefix);
      if (typeof schema.additionalProperties !== 'object') refuse(from, `${name} is an object with neither properties nor a schema for its values`);
      return `map[${schema.propertyNames ? typeOf(schema.propertyNames, from, `${name}Key`) : 'string'}]${typeOf(schema.additionalProperties, from, `${name}Value`)}`;
    case 'string':
      return 'string';
    case 'integer':
      return 'int';
    case 'number':
      return 'float64';
    case 'boolean':
      return 'bool';
  }
  refuse(from, `${name} is a schema of type ${JSON.stringify(schema.type)}, which this generator does not render`);
}

/**
 * An object's struct. Its fields are named as its properties, and an object
 * of its own as `prefix` and the property: a document's spec names its own
 * after the document, KnowledgeBase's gateway is KnowledgeBaseGateway.
 */
function objectType(schema, from, name, prefix = name) {
  if (types.has(name)) return name;
  types.set(name, undefined);
  if (!schema.description) refuse(from, `${name} is an object with no description`);
  if (schema.additionalProperties !== false) refuse(from, `${name} admits properties it does not name: a document is held to its schema`);
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).map(([property, sub]) => {
    const optional = !required.has(property);
    const document = documents.some((path) => schemaAt(path) === schema);
    const type = typeOf(sub, from, `${prefix}${pascal(property)}`, document && property === 'spec' ? name : undefined);
    const pointer = optional && !type.startsWith('map[') && !type.startsWith('[]');
    const field = `\t${pascal(property)} ${pointer ? '*' : ''}${type} \`json:"${property}${optional ? ',omitempty' : ''}"\``;
    const description = describe(sub, from);
    return description ? `${goComment(description, '\t')}\n${field}` : field;
  });
  const body = fields.length === 0 ? 'struct{}' : `struct {\n${fields.join('\n\n')}\n}`;
  types.set(name, `${goComment(`${name}: ${schema.description}`)}\ntype ${name} ${body}\n`);
  return name;
}

for (const path of documents) {
  const schema = schemaAt(path);
  if (schema.type !== 'object' || !schema.title) refuse(path, 'a document is not an object with a title');
  objectType(schema, path, schema.title);
}
const schemaPaths = reach(documents);

const header = goHeader(`${STACK} and ${PROJECT}`, 'generate-stack.mjs');

const typesText = `${header}
package stack
${usesAPI ? `\nimport "${SDK_API}"\n` : ''}
${[...types.values()].join('\n')}`;

const schemasText = `${header}
package stack

// schemaFiles: the text of every schema a document is read against, and of
// every schema those refer to, by its path in the repository.
var schemaFiles = map[string]string{
${schemaPaths.map((p) => `\t${JSON.stringify(p)}: ${goJSON(schemaAt(p))},`).join('\n\n')}
}

// schemaOf: the schema each kind of document is read against.
var schemaOf = map[string]string{
${documents.map((p) => `\t${JSON.stringify(schemaAt(p).title)}: ${JSON.stringify(p)},`).join('\n\n')}
}
`;

writeOrCheck(`${GO_OUT}/types_gen.go`, typesText);
writeOrCheck(`${GO_OUT}/schemas_gen.go`, schemasText);

console.log(`documents: ${documents.length}, types: ${types.size}, schemas: ${schemaPaths.length}`);
