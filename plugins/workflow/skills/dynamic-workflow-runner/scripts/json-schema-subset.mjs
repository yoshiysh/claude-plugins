export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const MAX_SCHEMA_EVALUATIONS = 10_000;

const KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "default", "examples",
  "type", "const", "enum", "properties", "required", "additionalProperties", "items",
  "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "minimum",
  "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minProperties", "maxProperties",
  "format", "allOf", "anyOf", "oneOf", "not",
]);

const CANONICAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

export function isCanonicalDateTime(value) {
  if (typeof value !== "string") return false;
  const match = CANONICAL_DATE_TIME.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function reject(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = "unsupported_result_schema";
    throw error;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function resolveRef(root, ref) {
  let current = root;
  for (const token of ref.slice(2).split("/")) {
    reject(token.length > 0 && current !== null && typeof current === "object" && Object.hasOwn(current, token), `Unresolved JSON Schema $ref: ${ref}`);
    current = current[token];
  }
  reject(current !== null && typeof current === "object" && !Array.isArray(current), `Invalid JSON Schema $ref target: ${ref}`);
  return current;
}

export function inspectJsonSchema(schema, root = schema, depth = 0, budget = { nodes: 0 }) {
  reject(schema !== null && typeof schema === "object" && !Array.isArray(schema), "JSON Schema boolean/non-object forms are unsupported");
  budget.nodes += 1;
  reject(depth <= 64 && budget.nodes <= 1000, "JSON Schema exceeds controller bounds");
  for (const key of Object.keys(schema)) reject(KEYWORDS.has(key), `Unsupported JSON Schema keyword: ${key}`);
  if (schema.$schema !== undefined) reject(schema.$schema === JSON_SCHEMA_DIALECT, "Unsupported JSON Schema dialect");
  for (const key of ["$id", "title", "description"]) {
    if (schema[key] !== undefined) reject(typeof schema[key] === "string", `JSON Schema ${key} must be a string`);
  }
  if (schema.examples !== undefined) reject(Array.isArray(schema.examples), "JSON Schema examples must be an array");
  if (schema.$ref !== undefined) reject(typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && !schema.$ref.includes("~"), "Only simple local fragment $ref values are supported");
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    reject(types.length > 0 && new Set(types).size === types.length && types.every((type) => ["null", "boolean", "object", "array", "number", "integer", "string"].includes(type)), "Unsupported JSON Schema type");
  }
  if (schema.required !== undefined) reject(Array.isArray(schema.required) && new Set(schema.required).size === schema.required.length && schema.required.every((item) => typeof item === "string"), "JSON Schema required must be a unique string array");
  if (schema.enum !== undefined) reject(Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 1000 && new Set(schema.enum.map(canonical)).size === schema.enum.length, "JSON Schema enum is invalid");
  for (const key of ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"]) {
    if (schema[key] !== undefined) reject(Number.isInteger(schema[key]) && schema[key] >= 0, `JSON Schema ${key} must be a non-negative integer`);
  }
  for (const [minimumKey, maximumKey] of [["minItems", "maxItems"], ["minLength", "maxLength"], ["minProperties", "maxProperties"]]) {
    if (schema[minimumKey] !== undefined && schema[maximumKey] !== undefined) reject(schema[minimumKey] <= schema[maximumKey], `JSON Schema ${minimumKey} exceeds ${maximumKey}`);
  }
  if (schema.uniqueItems !== undefined) reject(typeof schema.uniqueItems === "boolean", "JSON Schema uniqueItems must be boolean");
  if (schema.format !== undefined) reject(schema.format === "date-time", "Only JSON Schema format=date-time is supported");
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined) reject(typeof schema[key] === "number" && Number.isFinite(schema[key]), `JSON Schema ${key} must be a finite number`);
  }
  if (schema.multipleOf !== undefined) reject(typeof schema.multipleOf === "number" && Number.isFinite(schema.multipleOf) && schema.multipleOf > 0, "JSON Schema multipleOf must be a positive finite number");
  for (const key of ["properties", "$defs"]) {
    if (schema[key] !== undefined) {
      reject(schema[key] !== null && typeof schema[key] === "object" && !Array.isArray(schema[key]), `JSON Schema ${key} must be an object`);
      Object.values(schema[key]).forEach((child) => inspectJsonSchema(child, root, depth + 1, budget));
    }
  }
  if (schema.items !== undefined) inspectJsonSchema(schema.items, root, depth + 1, budget);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") inspectJsonSchema(schema.additionalProperties, root, depth + 1, budget);
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key] !== undefined) {
      reject(Array.isArray(schema[key]) && schema[key].length > 0 && schema[key].length <= 100, `JSON Schema ${key} is invalid`);
      schema[key].forEach((child) => inspectJsonSchema(child, root, depth + 1, budget));
    }
  }
  if (schema.not !== undefined) inspectJsonSchema(schema.not, root, depth + 1, budget);
  if (schema.$ref !== undefined) resolveRef(root, schema.$ref);
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

export function jsonSchemaErrors(schema, value, root = schema, instancePath = "$", refStack = new Set(), budget = { evaluations: 0 }) {
  budget.evaluations += 1;
  if (budget.evaluations > MAX_SCHEMA_EVALUATIONS) return [`${instancePath}: schema evaluation budget exceeded`];
  const errors = [];
  if (schema.$ref !== undefined) {
    if (refStack.has(schema.$ref)) return [`${instancePath}: cyclic $ref is unsupported`];
    const next = new Set(refStack);
    next.add(schema.$ref);
    errors.push(...jsonSchemaErrors(resolveRef(root, schema.$ref), value, root, instancePath, next, budget));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) errors.push(`${instancePath}: expected type ${types.join("|")}`);
  }
  if (Object.hasOwn(schema, "const") && canonical(value) !== canonical(schema.const)) errors.push(`${instancePath}: const mismatch`);
  if (schema.enum !== undefined && !schema.enum.some((item) => canonical(item) === canonical(value))) errors.push(`${instancePath}: enum mismatch`);
  if (Object.hasOwn(schema, "pattern")) errors.push(`${instancePath}: unsupported JSON Schema keyword pattern`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${instancePath}: shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${instancePath}: longer than maxLength`);
    if (schema.format === "date-time" && !isCanonicalDateTime(value)) errors.push(`${instancePath}: invalid canonical date-time`);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${instancePath}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${instancePath}: above maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${instancePath}: below exclusiveMinimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${instancePath}: above exclusiveMaximum`);
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-12) errors.push(`${instancePath}: not multipleOf`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${instancePath}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${instancePath}: too many items`);
    if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) errors.push(`${instancePath}: duplicate items`);
    if (schema.items !== undefined) value.forEach((item, index) => errors.push(...jsonSchemaErrors(schema.items, item, root, `${instancePath}[${index}]`, refStack, budget)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${instancePath}: too few properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${instancePath}: too many properties`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${instancePath}: missing property ${key}`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) errors.push(...jsonSchemaErrors(child, value[key], root, `${instancePath}.${key}`, refStack, budget));
    const extras = keys.filter((key) => !Object.hasOwn(schema.properties ?? {}, key));
    if (schema.additionalProperties === false && extras.length > 0) errors.push(`${instancePath}: additional properties ${extras.join(",")}`);
    else if (schema.additionalProperties && typeof schema.additionalProperties === "object") extras.forEach((key) => errors.push(...jsonSchemaErrors(schema.additionalProperties, value[key], root, `${instancePath}.${key}`, refStack, budget)));
  }
  for (const child of schema.allOf ?? []) errors.push(...jsonSchemaErrors(child, value, root, instancePath, refStack, budget));
  if (schema.anyOf !== undefined && !schema.anyOf.some((child) => jsonSchemaErrors(child, value, root, instancePath, refStack, budget).length === 0)) errors.push(`${instancePath}: anyOf mismatch`);
  if (schema.oneOf !== undefined && schema.oneOf.filter((child) => jsonSchemaErrors(child, value, root, instancePath, refStack, budget).length === 0).length !== 1) errors.push(`${instancePath}: oneOf mismatch`);
  if (schema.not !== undefined && jsonSchemaErrors(schema.not, value, root, instancePath, refStack, budget).length === 0) errors.push(`${instancePath}: not matched`);
  return errors.slice(0, 100);
}
