#!/usr/bin/node
//@ts-check

import fs from 'fs';
import path from 'path';
import url from 'url';

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

  for (const filePath of readdirRecursiveSync(dir, { exclude: ['.git', '.github', 'node_modules', '_site'] })) {
    if (path.extname(filePath) != '.json')
      continue;

    console.info(`info: loading '${filePath}'...`);

    const json = fs.readFileSync(filePath, { encoding: 'utf8' });

    try {
      const schema = JSON.parse(json);
      if (!`${schema.$schema}`.startsWith('http://json-schema.org')) {
        console.info(`info: no $schema, skipping`);
        continue;
      }

      schemas[filePath] = schema;
    }
    catch (e) {
      console.warn(`warning: ${e}`);
    }

    console.info(`info: ok`);
  }

  return schemas;
}

/**
 * Parserizza una `$ref`.
 * @param {string} filePath Percorso del file contenente lo schema.
 * @param {string} ref `$ref`
 * @returns {{ type: 'hash', path: string[] } | { type: 'local', filePath: string } | { type: 'remote', url: string } | { type: 'unknown' }}
 */
function parseRef(filePath, ref) {
  try {
    const parsed = url.parse(ref);
    // "https://json.schemastore.org/something.json"
    if (parsed.host != null)
      return { type: 'remote', url: ref };

    // "#/definitions/my-definition"
    if (parsed.hash === parsed.href)
      return { type: 'hash', path: parsed.hash.substring(1).split('/').filter(x => x !== '') };

    // "./my-schemas/some-schema.json"
    return { type: 'local', filePath: path.join(filePath, '..', ref) };
  }
  catch (e) {
    console.warn(`warning: error parsing $ref '${ref}': ${e}`);
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

  baseSchema ??= /** @type {JSONSchema} */(converted); // HACK: cast
  baseSchemaSubPath ??= [];

  for (const k in schema) {
    const v = schema[k];
    if (typeof v === 'object' && v != null) {
      if (v.$ref == null) {
        converted[k] = convertLocalRefs(schemas, filePath, v, baseSchema, baseSchemaSubPath);
      }
      else {
        const parsed = parseRef(filePath, v.$ref);
        
        switch (parsed.type) {
          case 'hash':
          //  const s = extractPath(schemas[filePath], parsed.path);
          //  if (typeof s !== 'object' || s == null) {
          //    console.warn(`warning: invalid $ref '${v.$ref}'`);
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
            const d = baseSchema.definitions ??= {};
            d[definitionId] = convertLocalRefs(schemas, parsed.filePath, schemas[parsed.filePath], undefined, ['definitions', definitionId]);
            converted[k] = { $ref: `#/definitions/${definitionId}` };
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

  return /** @type {JSONSchema} */(converted); // HACK: cast
}

function build() {
  const schemas = loadSchemas('.');

  console.info(`info: converting local references into definitions...`);

  for (const filePath in schemas)
    schemas[filePath] = convertLocalRefs(schemas, filePath, schemas[filePath]);

  console.info(`info: building`);

  fs.rmSync('_site', { recursive: true, force: true });
  fs.mkdirSync('_site', { recursive: true });

  for (const filePath in schemas) {
    const json = JSON.stringify(schemas[filePath], null, '  ');
    const outFilePath = path.join('_site', filePath);

    fs.mkdirSync(path.join(outFilePath, '..'), { recursive: true });
    fs.writeFileSync(outFilePath, json);
  }
}

build();
