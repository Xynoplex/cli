#!/usr/bin/env node
// generate-owner-only.mjs — how the launcher keeps its state home and its own
// files to their owner, from the pinned protocol's
// specs/src/sign-in-store/owner-only.json: the mode of a directory and of a
// file, and the Windows access list of each.
//
//   internal/launcher/owneronly_gen.go
//
// A file's access list is the directory's with nothing handed down: each
// entry's `OICI` inheritance flags are dropped.
//
// --check compares without writing, and fails when a committed file differs.

import { goComment, goHeader, refuse, schemaAt, writeOrCheck } from './lib/generate.mjs';

const SPEC = 'protocol/specs/src/sign-in-store/owner-only.json';
const OWNER = '{owner}';

const spec = schemaAt(SPEC);
for (const key of ['directoryMode', 'fileMode', 'accessList']) {
  if (typeof spec[key]?.value !== 'string' || typeof spec[key]?.docs !== 'string') refuse(SPEC, `${key} has no value and docs`);
}

/** An octal mode as Go writes it: 0700 is 0o700. */
function goMode(key) {
  const { value } = spec[key];
  if (!/^0[0-7]{3}$/.test(value)) refuse(SPEC, `${key} is ${value}, not an octal mode`);
  return `0o${value.slice(1)}`;
}

const directoryList = spec.accessList.value;
if (directoryList.split(OWNER).length !== 2) refuse(SPEC, `accessList names ${OWNER} other than once`);
const fileList = directoryList.replaceAll('(A;OICI;', '(A;;');
if (fileList === directoryList || fileList.includes('OICI')) refuse(SPEC, 'accessList hands nothing down, or not by each entry');

/** An access list as a Go expression of `owner`. */
const goList = (list) => list.split(OWNER).map((part) => JSON.stringify(part)).join(' + owner + ');

const text = `${goHeader(SPEC, 'generate-owner-only.mjs')}// The Go SDK generates its own from the same file.

package launcher

import "os"

${goComment(`ownerOnlyDirMode: ${spec.directoryMode.docs}`)}
const ownerOnlyDirMode os.FileMode = ${goMode('directoryMode')}

${goComment(`ownerOnlyFileMode: ${spec.fileMode.docs}`)}
const ownerOnlyFileMode os.FileMode = ${goMode('fileMode')}

${goComment(`ownerOnlyDirAccessList: ${spec.accessList.docs.replaceAll(`\`${OWNER}\``, '`owner`')}`)}
func ownerOnlyDirAccessList(owner string) string {
\treturn ${goList(directoryList)}
}

${goComment('ownerOnlyFileAccessList: The same list as a file is given it: each entry hands nothing down, since a file has nothing beneath it.')}
func ownerOnlyFileAccessList(owner string) string {
\treturn ${goList(fileList)}
}
`;

writeOrCheck('internal/launcher/owneronly_gen.go', text);
