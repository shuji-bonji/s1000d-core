# @shuji-bonji/s1000d-core

**English** | [日本語](./README.ja.md)

A shared library for reading S1000D® CSDB objects (data modules and others) and checking them against BREX (Business Rules Exchange). It provides parsing and formatting of data module codes (DMC) and ICNs, reading of the identification and status section, reading of a BREX and checking against it, and XML reading with XPath evaluation. `s1000d-brex-mcp` / `s1000d-reader-mcp` / `s1000d-verify-mcp` / `s1000d-writer-mcp` share it.

> [!IMPORTANT]
> This is a personal project and is not affiliated with ASD (Aerospace, Security and Defence Industries Association of Europe). S1000D® is a registered trademark of ASD.
> The S1000D specification, XML schemas, default BREX and official samples are not included in any package or repository, because their terms of use do not grant redistribution. Obtain them from [s1000d.org](https://s1000d.org/) and point the `S1000D_SPEC_DIR` environment variable at the extracted folder.

## What it does

| Feature | Functions |
|---|---|
| Parse and format a DMC (with or without a learn code) | `parseDmc` / `formatDmc` / `sameDmc` / `isBrexDmc` |
| Parse and format a DMC file name (issue information, language, extension) | `parseDmcFileName` / `formatDmcFileName` |
| Parse and format an ICN (MIC-based and CAGE-based) | `parseIcn` / `formatIcn` / `parseIcnFileName` |
| Infer the schema name and the S1000D issue from `xsi:noNamespaceSchemaLocation` | `parseSchemaLocation` |
| Read the identification and status section of a data module (DMC, language, issue, title, BREX reference, applicability display text and more) | `readDataModuleInfo` / `readIdentAndStatus` / `readDmRef` |
| Read a BREX data module (contextRules / nonContextRules / snsRules / notationRuleList) | `readBrex` / `allRules` / `lookupSns` |
| Check a data module against a BREX (one layer, several layers, or following the `brexDmRef` chain) | `checkAgainstBrexLayer` / `checkAgainstBrexLayers` / `checkAgainstBrexChain` / `resolveBrexChain` |
| Treat a folder as a CSDB and find a file by DMC | `listDataModules` / `findDataModule` / `createDirectoryBrexResolver` |
| Resolve a BREX designation (file path, DMC, or omitted = the default BREX of the distribution) to a single BREX | `locateBrex` / `findDefaultBrex` / `isDefaultBrexDmc` |
| Read XML and evaluate XPath 3.1 (replaceable interface) | `XmlEngine` / `defaultXmlEngine` |
| Validate against an XML schema (XSD) (replaceable interface; the implementation lives in the subpath `xsd-libxml2`) | `SchemaValidator` / `Libxml2SchemaValidator` |
| Find `xml_schema_flat/` inside the distribution and pick the XSD to use from `xsi:noNamespaceSchemaLocation` | `findSchemaDirs` / `locateXsd` |
| Parse and format a PMC, and index a CSDB that also picks up objects other than DMs (PMC, DML, DDN, IMF, UPF, ICN) | `parsePmc` / `parsePmcFileName` / `listCsdbObjects` / `CsdbIndex` |
| Swap where the CSDB lives (a folder by default; a database or API implementation can be plugged in) | `CsdbSource` / `DirectoryCsdbSource` / `MemoryCsdbSource` / `CsdbIndex.fromSource` |
| Read a DML (data module list) and a DDN (data dispatch note) and reconcile them with the CSDB (missing, different issue, not listed in the DML) | `readDml` / `readDdn` / `reconcileDml` / `reconcileDdn` / `parseDmlFileName` / `parseDdnFileName` |
| Collect references (`dmRef` / `pmRef` / ICN / `internalRef` / `applicRefId`) and report whether each target exists, with the reason | `collectReferences` / `resolveReferences` |
| Read content (descript / proced / process / fault / pm) into a common shape (headings, paragraphs, steps, warnings, illustrations, tables, references) | `readContent` / `readContentFromXml` |
| Applicability: read the ACT, CCT and PCT, and evaluate `assert` / `evaluate` with three values (applicable / notApplicable / undetermined) | `readAct` / `readCct` / `readPct` / `ApplicEvaluator` / `evaluateApplic` |
| Validate one data module (well-formedness, XSD, BREX, references) in one call and return the verification status `VerificationStatus` | `verifyDataModule` |
| Decide the distribution folder (`specDir`) and the CSDB folders (`csdbDirs`) from environment variables or a config file | `resolveStackConfig` / `stackConfigPath` / `specDirHowTo` |
| Decide fix candidates deterministically from the verification result (XSD, BREX, references) and from undetermined applicability | `suggestFixes` / `findUndeterminedApplicability` / `findApplicTables` |

```ts
import { readFileSync } from 'node:fs';
import { checkAgainstBrexChain, createDirectoryBrexResolver } from '@shuji-bonji/s1000d-core';

// Look for BREX in the S1000D distribution you obtained (which includes the default BREX) and in the project CSDB
const resolve = createDirectoryBrexResolver([process.env.S1000D_SPEC_DIR!, './csdb']);

const report = await checkAgainstBrexChain(readFileSync('./csdb/DMC-….XML', 'utf8'), resolve);
console.log(report.passed);
for (const layer of report.layers) {
  for (const v of layer.violations) {
    console.log(layer.brex.title, v.kind, v.ruleId, v.location?.path, v.actualValue, v.objectUse);
  }
  // nonContextRules cannot be decided by machine, so they are returned as manual checks
  console.log(layer.manualChecks.map((m) => m.text));
}
```

## Checking rules

The checks follow Chap 4.10.2 (BREX data module) and Chap 7.9 (Business rules processing) of S1000D Issue 7.

| Item | Handling |
|---|---|
| `allowedObjectFlag="0"` | A violation (`forbidden`) if the result of `objectPath` is not empty |
| `allowedObjectFlag="1"` | A violation (`missing`) if the result is empty |
| `allowedObjectFlag="2"` | The value of each node in the result is checked against `objectValue`; a violation (`value`) if none matches. `single` is an exact match, `range` is a prefixed range such as `brsl51~brsl99`, and `pattern` is a full match of a regular expression |
| An `objectPath` that returns a boolean (`not(…)` and the like) | true is treated as "object present" and false as "object absent", and the same rules apply |
| `contextRules/@rulesContext` | Applies the block whose schema name matches the `xsi:noNamespaceSchemaLocation` of the target data module, plus the common block that has no `rulesContext` |
| `notationRuleList` | A violation (`notation`) if a NOTATION used in `ENTITY … NDATA` of the DOCTYPE is not in the allowed set (the basic set plus schema-specific redefinitions and exclusions). A layer that has no inclusion (`allowedNotationFlag="1"`) and only exclusions (`"0"`) reports only the listed notations; other notations are not restricted by that layer (`notationPolicy`) |
| `nonContextRules` | Not decided; returned as manual checks (`manualChecks`) |
| Layers | Follows the `brexDmRef` chain up to the default BREX (which references itself) and checks each layer separately. Layers are not merged. `passed` only when no layer has a violation and no reference is unresolved |
| `brSeverityLevel` | The rule's attribute, or `brex/@defaultBrSeverityLevel` if absent, is put in the report as is. Its meaning is not interpreted |

## Validation against the XML schema (XSD)

The XSDs are part of the distribution and cannot be redistributed, so the library looks for them in the folder you extracted. The validation implementation uses `libxml2-wasm` and is loaded from the subpath `@shuji-bonji/s1000d-core/xsd-libxml2`. `libxml2-wasm` is an optional peerDependency, so the package that uses it must run `npm install libxml2-wasm`.

```ts
import { findSchemaDirs, createDirectoryBrexResolver, verifyDataModule } from '@shuji-bonji/s1000d-core';
import { Libxml2SchemaValidator } from '@shuji-bonji/s1000d-core/xsd-libxml2';

const specDir = process.env.S1000D_SPEC_DIR!;
const schemaDirs = findSchemaDirs([specDir]);          // find xml_schema_flat/ that contains brex.xsd (the issue is read from brex.xsd)
const validator = new Libxml2SchemaValidator();        // compile each XSD once and reuse it
try {
  const result = await verifyDataModule(xml, {
    path: 'DMC-….XML',
    schema: { validator, schemaDirs },
    brex: { resolver: createDirectoryBrexResolver([specDir, './csdb']) },
    references: { csdb: ['./csdb'] },
  });
  console.log(result.status.schema.state);   // valid / invalid / schema-not-found / not-run
  console.log(result.status.brex.state);     // passed / violations / incomplete / not-run
  console.log(result.status.references.state); // resolved / unresolved / not-run
  console.log(result.schema.errors);         // libxml2 messages and line numbers
  console.log(result.references?.unresolved); // references that were not found, with the reason
} finally {
  validator.dispose();
}
```

`VerificationStatus` has no single boolean that states S1000D conformance. Even when the machine checks of XSD and BREX pass, the nonContextRules (`brex.manualChecks`) and the business rules documents that people read remain.

## Where the distribution and the CSDB are

`resolveStackConfig` decides where the S1000D distribution obtained by the user is, and where the project's CSDB is. It reads the environment variables `S1000D_SPEC_DIR` / `S1000D_CSDB_DIR` first, then a config file. The default location of the config file is `~/.config/s1000d-stack/config.json` (under `XDG_CONFIG_HOME` if it is set), and `S1000D_CONFIG` changes it.

```json
{
  "specDir": "~/s1000d/issue-7",
  "csdbDirs": ["~/projects/kenbaiki/csdb"]
}
```

Paths that start with `~/` and paths relative to the folder of the config file are accepted. The config file exists because MCP hosts such as Claude Desktop do not pass environment variables to servers installed as plugins. If the host passes `${S1000D_SPEC_DIR}` through as literal text without substituting it, that value is ignored, the config file is read instead, and the reason is written to `warnings`.

## Fix suggestions

`suggestFixes` takes the result of `verifyDataModule` and returns, for each finding, candidates (`Fix`) that say what to change, where, and to which value. This library decides every candidate. The intended use is that an LLM only chooses among the candidates and explains them, so that the LLM does not invent allowed values or reference targets.

| Source finding | Candidates | Origin (`source`) |
|---|---|---|
| BREX value violation | The rule's `objectValue` entries (allowed value and description; `range` and `pattern` are passed with their form) | BREX rule ID |
| BREX forbidden / missing | Remove / add (an `objectValue`, if any, becomes the initial value) | BREX rule ID |
| BREX NOTATION violation | The allowed notations | BREX |
| XSD error | The values or elements named in the libxml2 message. If the message names none, they are taken from the XSD definitions (`xs:enumeration`, `xs:pattern`, the allowed child elements and attributes) | XSD file name and definition name |
| Unresolved reference | A DMC that differs only in the information code, a DMC that differs only in the system difference code, the issue present in the CSDB, an ICN that differs only in the extension, a similar id. A reference to a chapter of the specification (model identification code `S1000D`) gets an explanation only | CsdbIndex, ids in the document |
| Undetermined applicability | Values to give to the product (ACT enumerations and `valuePattern`, CCT enumerations, values assigned to PCT products) | ACT, CCT, PCT |

The certainty is expressed in three levels of `confidence` (`exact` = one candidate with a fixed value, `several` = choose among several, or within a range or pattern, `none` = no candidate). No score is given.

```ts
import { findApplicTables, findUndeterminedApplicability, resolveBrexChain, suggestFixes, CsdbIndex } from '@shuji-bonji/s1000d-core';

const csdb = CsdbIndex.fromDirs(['./csdb']);
const result = await verifyDataModule(xml, { schema: { validator, schemaDirs }, brex: { resolver }, references: { csdb } });
const chain = await resolveBrexChain(result.info?.identAndStatus?.brexDmRef, resolver);

// Applicability is checked only when the product to evaluate against is decided
const tables = findApplicTables(xml, csdb);
const findings = findUndeterminedApplicability(xml, { attributes: { model: 'MV-50' }, conditions: {} });

const fixes = suggestFixes(result, {
  xml,                       // ids in the document, for internalRef / applicRefId candidates
  csdb,                      // where reference candidates are searched
  brexLayers: chain.layers,  // adds the objectValue descriptions to the candidates
  applicability: { findings, act: tables.act?.act, cct: tables.cct?.cct, pct: tables.pct?.pct },
});
for (const f of fixes) console.log(f.kind, f.location?.path, f.confidence, f.candidates.map((c) => c.value));
```

The XSD definitions are read from `result.schema.xsdPath` (pass `xsd: false` to skip this). Applying a fix to the document (`apply_fix`) is not part of this library; s1000d-writer-mcp will do it in stage 3.

## Swapping where the CSDB lives (CsdbSource)

By default, core treats `DMC-….XML` files inside a folder as the CSDB (`CsdbIndex.fromDirs`). A product's CSDB is a database or an API, so "listing" and "fetching the content" are gathered in the `CsdbSource` interface. It is swapped the same way as `XmlEngine` / `SchemaValidator`.

```ts
import { CsdbIndex, MemoryCsdbSource, createBrexResolver, type CsdbSource } from '@shuji-bonji/s1000d-core';

// 1. Pass content you have already loaded (for tests, or for a store that can only be read asynchronously)
const rows = await db.query('select file_name, xml from csdb_objects');
const source = new MemoryCsdbSource(rows.map((r) => ({ fileName: r.file_name, xml: r.xml })), 'project CSDB');

// 2. Plug in your own implementation (list returns the objects, readText returns the content; both synchronous)
const custom: CsdbSource = {
  description: 'product CSDB',
  list: () => cache.objects,
  readText: (o) => cache.xmlOf(o.path),
};

const csdb = CsdbIndex.fromSource(source);       // index (look up by DMC, PMC or file name)
const xml = csdb.read(csdb.findDataModules(dmCode)[0]!);
const resolver = createBrexResolver(csdb);       // BREX is read from this CSDB as well
await verifyDataModule(xml, { references: { csdb } });  // accepts a CsdbIndex, a CsdbSource or a list of folders
```

`CsdbObject.path` is the identifier inside the store: the file path for a folder, and for `MemoryCsdbSource` the string given as `path` (the file name if omitted). It is returned in responses as is. Writing back will be added in stage 3 (writer).

## Reconciling a DML and a DDN with the CSDB

The library reads a data module list (DML, `dml.xsd`) and a data dispatch note (DDN, `ddn.xsd`) and reconciles them with the CSDB. This is the foundation for project management (stage 2.5).

```ts
import { CsdbIndex, readDdn, readDml, reconcileDdn, reconcileDml } from '@shuji-bonji/s1000d-core';

const csdb = CsdbIndex.fromDirs(['./csdb']);
const dmlObj = csdb.objects.find((o) => o.kind === 'dml')!;
const dml = readDml(csdb.read(dmlObj));
if (dml.ok) {
  const r = reconcileDml(dml.value, csdb);
  console.log(r.counts);        // { found, 'issue-mismatch', 'not-found', 'not-checked' }
  console.log(r.notListed);     // DMs and PMs in the CSDB that the DML does not list
}
const ddnObj = csdb.objects.find((o) => o.kind === 'ddn')!;
const ddn = readDdn(csdb.read(ddnObj));
if (ddn.ok) console.log(reconcileDdn(ddn.value, csdb).items.filter((i) => i.state !== 'found'));
```

| State | Meaning |
|---|---|
| `found` | The object is in the CSDB (and, when the DML entry names an issue, that issue is there) |
| `issue-mismatch` | The object is there, but not the issue the DML or DDN names. `foundIssueInfo` is the latest issue in the CSDB |
| `not-found` | The object is not in the CSDB |
| `not-checked` | Not reconciled (a DML entry that references a comment) |

A DML entry holds exactly one of `dmRef` / `pmRef` / `infoEntityRef` (ICN) / `dmlRef` / `commentRef`. The values of `dmlType`, `dmlEntryType` and `issueType` are returned as the XSD enumerations, without interpretation. `notListed` covers only DMs and PMs whose model identification code appears in the DML entries, and ignores the language. A DDN is reconciled by `dispatchFileName`; when a name differs only in the issue part (`_NNN-NN`), the item is `issue-mismatch`. Data modules with an extended DMC (file names starting with `DME-`) are indexed as `kind: 'dme'` and can be found by file name, not by DMC.

## XML and XPath libraries

XML is read with `@xmldom/xmldom`, and XPath is evaluated with `fontoxpath` (XPath 3.1). The default BREX of S1000D Issue 7 contains rules that use XPath 2.0 syntax (`for … return some … satisfies`), so an engine that supports only XPath 1.0 cannot evaluate every rule of the default BREX. To allow the libraries to be replaced, both sit behind the `XmlEngine` interface.

> [!TIP]
> The distribution contains samples (the data dictionary's `samples/`) whose DMC in the file name does not match the DMC in the content. `createDirectoryBrexResolver` prefers the file whose DMC in the content matches the reference, and returns the first readable file if none is found.

## Tests

```sh
npm test            # runs with the project's own test data only
npm run test:spec   # uses the S1000D distribution you obtained (set its location with S1000D_SPEC_DIR)
```

`test:spec` reads the distribution from `../../specs/s1000d/issue-7` (the s1000d-stack layout) or from the location given by the environment variable `S1000D_SPEC_DIR`. The distribution cannot be redistributed, so it is not included in the repository.

## License

MIT
