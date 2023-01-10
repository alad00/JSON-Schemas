#!/usr/bin/node
//@ts-check

import fs from 'fs';
import path from 'path';
import { exit } from 'process';
import url from 'url';

const SHOW_DEBUG_LOG = false;

const log = {
  errorsCount: 0,
  warningsCount: 0,
  error(...args) { log.errorsCount++; log._colored('31', true, ...args) },
  warning(...args) { log.warningsCount++; log._colored('33', true, ...args); },
  info(...args) { log._colored('', false, ...args); },
  debug(...args) { SHOW_DEBUG_LOG && log._colored('2', false, ...args); },
  _colored(colors, error, message, ...args) {
    (error ? console.error : console.log)(`\x1b[${colors}m${message}\x1b[0m`, ...args);
  }
};

/**
 * @typedef {JSONSchemaValue[]} JSONSchemaValueArray
 * @typedef {JSONSchema | JSONSchemaValueArray | string | boolean | number | null} JSONSchemaValue
 * @typedef {{
 *   $schema?: string | null
 *   $ref?: string | null
 *   definitions?: { [name: string]: JSONSchema }
 *   [others: string]: JSONSchemaValue | undefined
 * }} JSONSchema
 */

/**
 * Trova ricorsivamente tutti i file nella cartella indicata.
 * @param {string} dir
 * @param {{ exclude?: string[] }} options
 * @returns {Generator<string>}
 */
function* readdirRecursiveSync(dir, options) {
  for (const entry of fs.readdirSync(dir)) {
    const name = path.basename(entry);
    if (options.exclude?.includes(name))
      continue;

    const entryPath = path.join(dir, entry);
    const stats = fs.lstatSync(entryPath);
    if (stats.isDirectory()) {
      for (const sub of readdirRecursiveSync(entryPath, options))
        yield sub;

      continue;
    }

    yield entryPath;
  }
}

/**
 * Carica tutti gli schema da una cartella.
 * @param {string} dir
 * @returns {{ [filePath: string]: JSONSchema }}
 */
function loadSchemas(dir) {
  /** @type {{ [path: string]: any }} */
  const schemas = {};

  log.info(`info: loading schemas...`);

  for (const filePath of readdirRecursiveSync(dir, { exclude: ['.git', '.github', '.vscode', 'node_modules', '_site'] })) {
    if (path.extname(filePath) != '.json')
      continue;

    log.debug(`debug: loading '${filePath}'...`);

    const json = fs.readFileSync(filePath, { encoding: 'utf8' });

    try {
      const schema = JSON.parse(json);
      if (!`${schema.$schema}`.startsWith('http://json-schema.org')) {
        log.info(`info: no $schema on '${filePath}', skipping`);
        continue;
      }

      schemas[filePath] = schema;
    }
    catch (e) {
      log.warning(`warning: unable to parse '${filePath}' as JSON. ${e}`);
    }

    log.debug(`debug: loaded '${filePath}'`);
  }

  return schemas;
}

/**
 * Parserizza una `$ref`.
 * @param {string} filePath Percorso del file contenente lo schema.
 * @param {string} ref `$ref`
 * @returns {{ type: 'hash', path: string[] } | { type: 'local', filePath: string, path: string[] } | { type: 'remote', url: string } | { type: 'unknown' }}
 */
function parseRef(filePath, ref) {
  try {
    const parsed = url.parse(ref);
    // "https://json.schemastore.org/something.json"
    if (parsed.host != null)
      return { type: 'remote', url: ref };

    // "./my-schemas/some-schema.json"
    // "./my-schemas/some-schema.json#/definitions/my-definition"
    if (parsed.pathname != null)
      return { type: 'local', filePath: path.join(filePath, '..', parsed.pathname), path: (parsed.hash ?? '').substring(1).split('/').filter(x => x !== '') };

    // "#/definitions/my-definition"
    if (parsed.hash === parsed.href)
      return { type: 'hash', path: parsed.hash.substring(1).split('/').filter(x => x !== '') };

    throw 'not a valid $ref URL.';
  }
  catch (e) {
    log.warning(`warning: error parsing $ref '${ref}': ${e}`);
    return { type: 'unknown' };
  }
}

/**
 * Estrae valore al path indicato.
 * @param {JSONSchema} schema
 * @param {string[]} path
 * @returns {JSONSchemaValue | undefined}
 */
function extractPath(schema, path) {
  /** @type {JSONSchemaValue | undefined} */
  let sub = schema;
  for (const field of path) {
    if (typeof sub !== 'object' || sub == null)
      return undefined;

    if (!Object.prototype.hasOwnProperty.call(sub, field))
      return undefined;

    sub = sub[field];
  }

  return sub;
}

/**
 * Converte in `definition` le `$ref` che fanno riferimento a schema locali.
 * @param {{ [path: string]: JSONSchema }} schemas
 * @param {string} filePath Percorso del file contenente lo schema.
 * @param {JSONSchema} schema
 * @param {JSONSchema | undefined} baseSchema
 * @param {string[] | undefined} baseSchemaSubPath
 * @returns {JSONSchema}
 */
function convertLocalRefs(schemas, filePath, schema, baseSchema = undefined, baseSchemaSubPath = undefined) {
  /** @type {JSONSchema | JSONSchema[]} */
  const converted = Array.isArray(schema) ? [] : {};

  if (!baseSchema)
    log.debug(`debug: processing '${filePath}'...`);

  baseSchema ??= /** @type {JSONSchema} */(converted); // HACK: cast
  baseSchemaSubPath ??= [];

  for (const k in schema) {
    const v = schema[k];
    if (typeof v === 'object' && v != null) {
      if (v.$ref == null) {
        let newValue = convertLocalRefs(schemas, filePath, v, baseSchema, baseSchemaSubPath);;

        if (k === 'definitions' && converted === baseSchema)
          newValue = { ...converted.definitions, ...newValue };
        
        converted[k] = newValue;
      }
      else {
        const parsed = parseRef(filePath, v.$ref);
        
        switch (parsed.type) {
          case 'hash':
          //  const s = extractPath(schemas[filePath], parsed.path);
          //  if (typeof s !== 'object' || s == null) {
          //    log.warning(`warning: invalid $ref '${v.$ref}'`);
          //    converted[k] = v;
          //  }
          //  else {
          //    converted[k] = s;
          //  }
          //  break;
              converted[k] = { $ref: ['#'].concat(baseSchemaSubPath, parsed.path).join('/') };
              break;

          case 'local':
            const definitionId = `file_${encodeURIComponent(parsed.filePath.replace(/\\/g, '/').replace(/\//g, '_')).replace(/%/g, '')}`;
            log.debug(`debug: $ref '${v.$ref}' resolved to '${parsed.filePath}'`);
            const d = baseSchema.definitions ??= {};
            d[definitionId] = convertLocalRefs(schemas, parsed.filePath, schemas[parsed.filePath], baseSchema, ['definitions', definitionId]);
            converted[k] = { $ref: ['#'].concat('definitions', definitionId, parsed.path).join('/') };
            break;

          default:
            converted[k] = v;
            break;
        }
      }
    }
    else {
      converted[k] = v;
    }
  }

  if (converted === baseSchema) {
    converted.definitions = baseSchema.definitions;
  }

  return /** @type {JSONSchema} */(converted); // HACK: cast
}

function build() {
  const schemas = loadSchemas('.');
  const schemas2 = {};

  log.info(`info: converting local references into definitions...`);

  for (const filePath in schemas)
    schemas2[filePath] = convertLocalRefs(schemas, filePath, schemas[filePath]);

  log.info(`info: building...`);

  fs.rmSync('_site', { recursive: true, force: true });
  fs.mkdirSync('_site', { recursive: true });

  for (const filePath in schemas2) {
    const json = JSON.stringify(schemas2[filePath], null, '  ');
    const outFilePath = path.join('_site', filePath);

    fs.mkdirSync(path.join(outFilePath, '..'), { recursive: true });
    fs.writeFileSync(outFilePath, json);
  }

  log.info(`info: done`);
}

try {
  build();
}
catch (e) {
  log.error('error:', e);
}

if (log.errorsCount > 0) {
  log.error(`\nterminated with ${log.errorsCount} error${log.errorsCount == 1 ? '' : 's'}${log.warningsCount > 0 ? ` and ${log.warningsCount} warning${log.warningsCount == 1 ? '' : 's'}` : ''}`)
  exit(1);
}
else if (log.warningsCount > 0) {
  log.warning(`\nbuilt with ${log.warningsCount} warning${log.warningsCount == 1 ? '' : 's'}`)
  exit(0);
}
else {
  log.info(`\nbuilt without errors`);
  exit(0);
}
