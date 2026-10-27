// Secrets arrive through two very different fields and it is easy to confuse
// them: `keyEnv` names an environment variable, `apiKey` holds a literal value.
// Users (and earlier versions of this plugin) routinely paste the literal key
// into the `*Env` field, which then resolves to `undefined` and silently drops
// the Authorization header. That failure is invisible: the request still 401s,
// so every real decision fails while a shallow probe reports "connected".
//
// Resolution is therefore tolerant and explicit:
//   1. a literal value that is clearly not an identifier (contains characters
//      env var names cannot hold, e.g. '-' or '.') is used as the key itself;
//   2. otherwise treat it as an env var name and read the environment;
//   3. fall back to the literal `apiKey` field.
// The chosen source is reported so the settings UI can tell the user which one
// took effect instead of guessing.

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const clean = value => typeof value === 'string' ? value.trim() : '';

/** True when the value can only be a literal secret, never an env var name. */
export function isLiteralSecret(value) {
  const text = clean(value);
  return Boolean(text) && !ENV_NAME.test(text);
}

/**
 * Resolve an API key from a configuration pair.
 * @returns {{value: string|undefined, source: 'literal'|'env'|'apiKey'|'none', missingEnv?: string}}
 */
export function resolveApiKey({ keyEnv, apiKey } = {}, env = process.env) {
  const keyField = clean(keyEnv);
  const literal = clean(apiKey);
  if (keyField) {
    if (isLiteralSecret(keyField)) return { value: keyField, source: 'literal' };
    const fromEnv = clean(env?.[keyField]);
    // An empty env var means "configured but unset"; a literal apiKey is still
    // a better answer than sending no credentials at all.
    if (fromEnv) return { value: fromEnv, source: 'env' };
    if (literal) return { value: literal, source: 'apiKey' };
    return { value: undefined, source: 'none', missingEnv: keyField };
  }
  if (literal) return { value: literal, source: 'apiKey' };
  return { value: undefined, source: 'none' };
}

/** A short, secret-free description of where the key came from, for UI copy. */
export function describeKeySource(resolved) {
  if (!resolved || resolved.source === 'none') {
    return resolved?.missingEnv ? `环境变量 ${resolved.missingEnv} 未设置` : '未配置密钥';
  }
  if (resolved.source === 'literal') return '密钥取自字段值';
  if (resolved.source === 'env') return '密钥取自环境变量';
  return '密钥取自 apiKey 字段';
}
