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
| Collect references (`dmRef` / `pmRef` / ICN / `internalRef` / `applicRefId`) and report whether each target exists, with the reason | `collectReferences` / `resolveReferences` |
| Read content (descript / proced / process / fault / pm) into a common shape (headings, paragraphs, steps, warnings, illustrations, tables, references) | `readContent` / `readContentFromXml` |
| Applicability: read the ACT, CCT and PCT, and evaluate `assert` / `evaluate` with three values (applicable / notApplicable / undetermined) | `readAct` / `readCct` / `readPct` / `ApplicEvaluator` / `evaluateApplic` |
| Validate one data module (well-formedness, XSD, BREX, references) in one call and return the verification status `VerificationStatus` | `verifyDataModule` |

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
| `notationRuleList` | A violation (`notation`) if a NOTATION used in `ENTITY … NDATA` of the DOCTYPE is not in the allowed set (the basic set plus schema-specific additions and exclusions) |
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
