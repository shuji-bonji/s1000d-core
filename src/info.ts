/**
 * このパッケージ（s1000d-core）の名前と版。
 *
 * MCP は応答の `_server.core` に、実際に読み込まれている core の版を載せる（hub の DECISIONS の D-38）。
 * 依存の指定（`^0.16.0` など）ではなく、ここで読んだ `package.json` の版を返す。
 * `src/info.ts` からも `dist/info.js` からも、`../package.json` はパッケージの直下を指す。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { name: string; version: string };

/** s1000d-core のパッケージ名と版（`package.json` の `name`・`version`） */
export const CORE_INFO: Readonly<{ name: string; version: string }> = Object.freeze({
  name: packageJson.name,
  version: packageJson.version,
});
