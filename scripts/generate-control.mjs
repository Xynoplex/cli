#!/usr/bin/env node
// generate-control.mjs — the control API's Go types, and the schemas the
// launcher validates against, from the pinned protocol's
// specs/src/control/methods.json and the schemas it names.
//
//   internal/launcher/control_types_gen.go    a Go type for each object a
//                                              method's params, result or
//                                              notification reaches,
//                                              prefixed Control
//   internal/launcher/control_schemas_gen.go  the text of every schema they
//                                              reach, the method and
//                                              notification tables, and the
//                                              control group of
//                                              protocol/specs/src/errors/codes.json
//
// The launcher validates a message against its schema and only then reads it,
// so a type states the schema's shape and no rule of its own: `oneOf`,
// `pattern`, a bound and the like are the validator's. A reference into
// protocol/specs/src/discovery is the launcher's DiscoveredKB. A schema form
// this generator does not render is refused by name, rather than rendered as a
// guess.
//
// --check compares without writing, and fails when a committed file differs.

import { describe, goComment, goHeader, goJSON, pascal, reach, refuse, schemaAt, target, writeOrCheck } from './lib/generate.mjs';

const TABLE = 'protocol/specs/src/control/methods.json';
const CODES = 'protocol/specs/src/errors/codes.json';
const DISCOVERY = 'protocol/specs/src/discovery/DiscoveredKB.json';
const GO_OUT = 'internal/launcher';

/** The keywords a type is made from, and those that are rules the validator enforces. */
const SHAPE = new Set(['title', 'type', 'description', 'properties', 'required', 'additionalProperties', 'items', '$ref']);
const RULES = new Set(['oneOf', 'not', 'const', 'enum', 'pattern', 'minLength', 'minimum']);

/** The property a reference into the discovery contract names, or '' for the whole of it. */
function discoveryProperty(from, path, fragment, name) {
  if (fragment === '') return '';
  const property = fragment.match(/^\/properties\/([A-Za-z]+)$/);
  if (!property || !schemaAt(path).properties?.[property[1]]) refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
  return property[1];
}

const table = schemaAt(TABLE);
for (const method of table.methods) {
  for (const key of Object.keys(method)) {
    if (!['name', 'params', 'result', 'exclusive', 'sends', 'docs'].includes(key)) refuse(TABLE, `${method.name} has \`${key}\`, which this generator does not render`);
  }
  if (typeof method.exclusive !== 'boolean') refuse(TABLE, `${method.name} does not say whether it is exclusive`);
  for (const sent of method.sends) {
    if (!table.notifications.some((n) => n.name === sent && n.from === 'launcher')) refuse(TABLE, `${method.name} sends ${sent}, which is no notification the launcher sends`);
  }
}
const resolveIn = (ref) => target(TABLE, ref).path;

// ── the types ──────────────────────────────────────────

/** Each object's struct, by name. */
const types = new Map();
/** Each scalar of a file of its own that has been checked for a description. */
const ownScalars = new Set();

/** The Go type of `schema`, written in the file at `from`, named `name` if it is an object of its own. */
function typeOf(schema, from, name) {
  for (const keyword of Object.keys(schema)) {
    if (!SHAPE.has(keyword) && !RULES.has(keyword)) refuse(from, `${name} uses \`${keyword}\`, which this generator does not render`);
  }
  if (schema.$ref) {
    const { path, fragment } = target(from, schema.$ref);
    if (path === DISCOVERY) {
      const property = discoveryProperty(from, path, fragment, name);
      if (property === '') return 'DiscoveredKB';
      const referred = schemaAt(path).properties[property];
      return referred.enum ? `DiscoveredKB${pascal(property)}` : typeOf(referred, path, `DiscoveredKB${pascal(property)}`);
    }
    if (fragment !== '') refuse(from, `${name} refers to ${path}#${fragment}, which this generator does not render`);
    if (!path.startsWith('protocol/specs/src/control/')) refuse(from, `${name} refers to ${path}, outside the control contract and the discovery contract`);
    const referred = schemaAt(path);
    if (referred.type === 'object') return objectType(referred, path, referred.title);
    if (!referred.title) refuse(path, `referred to by ${name}, and has no title`);
    return scalarType(referred, path, referred.title, true);
  }
  if (schema.type === 'object') {
    if (!schema.properties) refuse(from, `${name} is an object with no properties`);
    return objectType(schema, from, name);
  }
  if (schema.type === 'array') {
    if (!schema.items) refuse(from, `${name} is an array with no items`);
    return `[]${typeOf(schema.items, from, `${name}Item`)}`;
  }
  return scalarType(schema, from, name, false);
}

/** A string, number or boolean: the Go type it is made of; the validator holds its values. */
function scalarType(schema, from, name, own) {
  let go;
  if (Array.isArray(schema.type)) {
    if (JSON.stringify(schema.type) !== '["string","integer"]') refuse(from, `${name} is of the types ${JSON.stringify(schema.type)}, which this generator does not render`);
    go = 'json.RawMessage';
  } else {
    switch (schema.type) {
      case 'string':
        go = 'string';
        break;
      case 'integer':
        go = 'int';
        break;
      case 'boolean':
        go = 'bool';
        break;
      default:
        refuse(from, `${name} is a schema of type ${JSON.stringify(schema.type)}, which this generator does not render`);
    }
  }
  if (own && !ownScalars.has(name)) {
    if (!schema.description) refuse(from, `${name} has no description`);
    ownScalars.add(name);
  }
  return go;
}

/** An object's struct. Its fields are named as its properties. */
function objectType(schema, from, name) {
  const typeName = `Control${name}`;
  if (types.has(typeName)) return typeName;
  types.set(typeName, undefined);
  if (!schema.description) refuse(from, `${name} is an object with no description`);
  if (schema.additionalProperties !== false) refuse(from, `${name} admits properties it does not name: a message is held to its schema`);
  const required = new Set(schema.required ?? []);
  const fields = [];
  for (const [property, sub] of Object.entries(schema.properties)) {
    const optional = !required.has(property);
    const type = typeOf(sub, from, `${name}${pascal(property)}`);
    const pointer = optional && !type.startsWith('[]') && type !== 'json.RawMessage';
    const description = describe(sub, from);
    const field = `\t${pascal(property)} ${pointer ? '*' : ''}${type} \`json:"${property}${optional ? ',omitempty' : ''}"\``;
    fields.push(description ? `${goComment(description, '\t')}\n${field}` : field);
  }
  types.set(typeName, `${goComment(`${typeName}: ${schema.description}`)}\ntype ${typeName} struct {\n${fields.join('\n\n')}\n}\n`);
  return typeName;
}

const named = (path) => {
  const schema = schemaAt(path);
  if (schema.type !== 'object' || !schema.title) refuse(path, 'a method or notification names a schema that is not an object with a title');
  return objectType(schema, path, schema.title);
};
const methods = table.methods.map((m) => ({ ...m, paramsPath: resolveIn(m.params), resultPath: resolveIn(m.result) }));
const notifications = table.notifications.map((n) => ({ ...n, paramsPath: resolveIn(n.params) }));
for (const m of methods) {
  m.paramsType = named(m.paramsPath);
  m.resultType = named(m.resultPath);
}
for (const n of notifications) n.paramsType = named(n.paramsPath);
const errorDataPath = resolveIn(table.errorData);
named(errorDataPath);
const apiVersionPath = resolveIn(table.apiVersion);
const apiVersion = schemaAt(apiVersionPath).const;
if (typeof apiVersion !== 'string') refuse(apiVersionPath, 'states no version as its const');

// ── the schemas they reach ────────────────────────────────────────────────

const schemaPaths = reach([apiVersionPath, errorDataPath, ...methods.flatMap((m) => [m.paramsPath, m.resultPath]), ...notifications.map((n) => n.paramsPath)]);

// ── the control error codes ───────────────────────────────────────────────

const control = schemaAt(CODES).control;
if (!control || !Array.isArray(control.codes) || control.codes.length === 0) refuse(CODES, 'has no control group, or it lists no codes');
const codes = control.codes.map((entry) => {
  if (!/^control\.[a-z]+(-[a-z]+)*$/.test(entry.code)) refuse(CODES, `control's ${entry.code} is not control.<kebab-case>`);
  return entry;
});

// ── Go ────────────────────────────────────────────────────────────────────

/** A control code's Go constant: control.target-required is controlCodeTargetRequired. */
const goCodeName = (code) => `controlCode${code.slice('control.'.length).split('-').map(pascal).join('')}`;

const header = goHeader(`${TABLE} and the schemas it names`, 'generate-control.mjs');
const goTypes = [...types.values()];
const goTypesText = `${header}
package launcher
${goTypes.some((t) => t.includes('json.RawMessage')) ? '\nimport "encoding/json"\n' : ''}
${goTypes.join('\n')}`;

const goMethod = (m) =>
  `\t{name: ${JSON.stringify(m.name)}, params: ${JSON.stringify(m.paramsPath)}, result: ${JSON.stringify(m.resultPath)}, exclusive: ${m.exclusive}, sends: []string{${m.sends.map((s) => JSON.stringify(s)).join(', ')}}},`;
const goSchemasText = `${header}
package launcher

// controlAPIVersion: the version of the control API this launcher speaks.
const controlAPIVersion = ${JSON.stringify(apiVersion)}

// controlErrorDataSchema: the schema of a failed request's error data.
const controlErrorDataSchema = ${JSON.stringify(errorDataPath)}

// controlSchemaFiles: the text of every schema a control message is read
// against, and of every schema those refer to, by its path in the repository.
var controlSchemaFiles = map[string]string{
${schemaPaths.map((p) => `\t${JSON.stringify(p)}: ${goJSON(schemaAt(p))},`).join('\n\n')}
}

// controlMethods: each method, the schemas of its params and its result,
// whether it is exclusive, and the notifications it may send besides
// progress.
var controlMethods = []controlMethod{
${methods.map(goMethod).join('\n')}
}

// controlNotifications: each notification, who sends it, and the schema of
// its params.
var controlNotifications = []controlNotification{
${notifications.map((n) => `\t{name: ${JSON.stringify(n.name)}, from: ${JSON.stringify(n.from)}, params: ${JSON.stringify(n.paramsPath)}},`).join('\n')}
}

// The control group of ${CODES}: why a request failed.
const (
${codes.map((c) => `${goComment(c.docs, '\t')}\n\t${goCodeName(c.code)} = ${JSON.stringify(c.code)}`).join('\n\n')}
)

// controlCodes: every code of the control group, in its order.
var controlCodes = []string{
${codes.map((c) => `\t${goCodeName(c.code)},`).join('\n')}
}
`;

writeOrCheck(`${GO_OUT}/control_types_gen.go`, goTypesText);
writeOrCheck(`${GO_OUT}/control_schemas_gen.go`, goSchemasText);

console.log(`methods: ${methods.length}, notifications: ${notifications.length}, types: ${types.size}, schemas: ${schemaPaths.length}, codes: ${codes.length}`);
