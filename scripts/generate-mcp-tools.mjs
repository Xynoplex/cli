#!/usr/bin/env node
// generate-mcp-tools.mjs — the tools `xynaut mcp` serves, from the table that
// curates them (internal/launcher/verbs/mcp-tools.json) and the pinned
// protocol's components it names.
//
//   internal/launcher/verbs/mcp_tools_gen.go  every tool, with its input and
//                                             output schema, and every SDK
//                                             method no tool calls
//
// The table's $comment states what an argument and a result may be. Each
// schema is self-contained: every component it refers to, and every one
// those refer to, is in its $defs, and each reference names it there. A form
// of the table this generator does not render is refused by name.
//
// --check compares without writing, and fails when a committed file differs.

import { goHeader, goJSON, reach, refuse, schemaAt, target, writeOrCheck } from './lib/generate.mjs';

const TABLE = 'internal/launcher/verbs/mcp-tools.json';
const COMPONENTS = 'protocol/specs/src/components/schemas';
const TOOL_KEYS = new Set(['name', 'title', 'description', 'calls', 'readOnly', 'destructive', 'arguments', 'result']);

const table = schemaAt(TABLE);
const component = (name) => `${COMPONENTS}/${name}.json`;
const defName = (path) => path.slice(COMPONENTS.length + 1).replace(/\.json$/, '');

/** Where a reference written in the file at `from` leads: a whole component, by its path. */
function componentRef(from, ref, where) {
  const { path, fragment } = target(from, ref);
  if (!path.startsWith(`${COMPONENTS}/`) || fragment !== '') refuse(where, `refers to ${ref}, which is no whole component`);
  return path;
}

/**
 * `schema`, written in the file at `from`, with each reference to a
 * component naming it in $defs, as the components it refers to are added
 * to `refs`.
 */
function rewrite(schema, from, refs, where) {
  if (Array.isArray(schema)) return schema.map((s) => rewrite(s, from, refs, where));
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) {
      const path = componentRef(from, value, where);
      refs.add(path);
      out[key] = `#/$defs/${defName(path)}`;
    } else if (key === 'discriminator' && value.mapping) {
      out[key] = {
        ...value,
        mapping: Object.fromEntries(
          Object.entries(value.mapping).map(([tag, ref]) => {
            const path = componentRef(from, ref, where);
            refs.add(path);
            return [tag, `#/$defs/${defName(path)}`];
          }),
        ),
      };
    } else {
      out[key] = rewrite(value, from, refs, where);
    }
  }
  return out;
}

/** The $defs of a schema that refers to `refs`: every component it reaches, by name. */
function defsOf(refs, where) {
  const defs = {};
  for (const path of reach([...refs])) {
    if (!path.startsWith(`${COMPONENTS}/`)) refuse(where, `reaches ${path}, which is no component`);
    defs[defName(path)] = rewrite(schemaAt(path), path, new Set(), where);
  }
  return defs;
}

/** A member of a component: its schema, and whether the component requires it. */
function member(entry, where) {
  const path = component(entry.from);
  const schema = schemaAt(path);
  if (entry.member.startsWith('_')) refuse(where, `${entry.from}.${entry.member} is the gateway's, never an argument`);
  const sub = schema.properties?.[entry.member];
  if (!sub) refuse(where, `${entry.from} has no member ${entry.member}`);
  return { path, sub, required: (schema.required ?? []).includes(entry.member) };
}

/** The schema of an argument or a result member named by `name` with `required`, and `refs` it reaches. */
function named(entry, refs, where) {
  const forms = ['schema', 'listOf', 'own'].filter((form) => form in entry);
  if (forms.length !== 1) refuse(where, `states ${forms.length === 0 ? 'none' : forms.join(' and ')} of schema, listOf and own`);
  if (typeof entry.required !== 'boolean') refuse(where, 'does not say whether it is required');
  if (entry.schema) return rewrite({ $ref: `./${entry.schema}.json` }, component(entry.schema), refs, where);
  if (entry.own) return rewrite(entry.own, TABLE, refs, where);
  const items =
    typeof entry.listOf === 'string'
      ? rewrite({ $ref: `./${entry.listOf}.json` }, component(entry.listOf), refs, where)
      : (({ path, sub }) => rewrite(sub, path, refs, where))(member(entry.listOf, where));
  return { type: 'array', items };
}

/** An object of `properties`, `required` as listed, with the $defs they reach. */
function objectOf(properties, required, refs, where) {
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  schema.additionalProperties = false;
  const defs = defsOf(refs, where);
  if (Object.keys(defs).length > 0) schema.$defs = defs;
  return schema;
}

function input(tool) {
  const where = `${TABLE}: ${tool.name}'s arguments`;
  const refs = new Set();
  const properties = {};
  const required = [];
  if (tool.calls.length > 0) properties.kb = table.kb;
  for (const entry of tool.arguments) {
    let name;
    let schema;
    let isRequired;
    if ('from' in entry) {
      const { path, sub, required: componentRequires } = member(entry, where);
      if ('optional' in entry && !componentRequires) refuse(where, `${entry.member} is optional, which ${entry.from} does not require`);
      name = entry.member;
      schema = rewrite(sub, path, refs, where);
      isRequired = componentRequires && !('optional' in entry);
    } else {
      name = entry.name;
      schema = named(entry, refs, `${where}, ${entry.name}`);
      isRequired = entry.required;
    }
    if (name in properties) refuse(where, `names ${name} twice`);
    properties[name] = schema;
    if (isRequired) required.push(name);
  }
  return objectOf(properties, required, refs, where);
}

function output(tool) {
  const where = `${TABLE}: ${tool.name}'s result`;
  const refs = new Set();
  if ('component' in tool.result) {
    if (Object.keys(tool.result).length !== 1) refuse(where, 'is a component and members besides');
    const path = component(tool.result.component);
    const schema = rewrite(schemaAt(path), path, refs, where);
    const defs = defsOf(refs, where);
    return Object.keys(defs).length > 0 ? { ...schema, $defs: defs } : schema;
  }
  const properties = {};
  const required = [];
  for (const [name, entry] of Object.entries(tool.result)) {
    if ('from' in entry) {
      if (typeof entry.required !== 'boolean') refuse(`${where}, ${name}`, 'does not say whether it is required');
      const { path, sub } = member(entry, `${where}, ${name}`);
      properties[name] = rewrite(sub, path, refs, where);
    } else {
      properties[name] = named(entry, refs, `${where}, ${name}`);
    }
    if (entry.required) required.push(name);
  }
  return objectOf(properties, required, refs, where);
}

if (!table.kb || table.kb.type !== 'string') refuse(TABLE, 'states no `kb` argument');
const tools = table.tools.map((tool) => {
  for (const key of Object.keys(tool)) {
    if (!TOOL_KEYS.has(key)) refuse(TABLE, `${tool.name} has \`${key}\`, which this generator does not render`);
  }
  const rendered = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    calls: tool.calls,
    readOnly: tool.readOnly === true,
    destructive: tool.destructive === true,
    input: input(tool),
  };
  if (tool.result) rendered.output = output(tool);
  return rendered;
});
const leftOut = Object.fromEntries(Object.entries(table.leftOut).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const text = `${goHeader(`${TABLE} and ${COMPONENTS}`, 'generate-mcp-tools.mjs')}
package verbs

// mcpToolsDocument: every tool xynaut mcp serves, in the order tools/list
// gives them, each with its input and output schema, and every method of the
// SDK's surface no tool calls, with its reason.
const mcpToolsDocument = ${goJSON({ tools, leftOut })}
`;

writeOrCheck('internal/launcher/verbs/mcp_tools_gen.go', text);

console.log(`tools: ${tools.length}, left out: ${Object.keys(leftOut).length}`);
