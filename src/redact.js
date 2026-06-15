// Scrub likely secrets from a bundle before it is uploaded. Because hosted
// projects are link-shareable by default, nothing secret should leave the
// machine. This is best-effort pattern matching — it reduces blast radius, it
// is not a guarantee — so the push flow also warns the user.
//
// Patterns cover the common, high-signal cases: provider keys, cloud creds,
// tokens, private-key blocks, and `KEY=secret` / `"password": "..."` style
// assignments. Each match is replaced with a typed placeholder so the dashboard
// still reads naturally.
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, '«anthropic-key»'],
  [/sk-[A-Za-z0-9_-]{16,}/g, '«openai-key»'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '«github-token»'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '«slack-token»'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '«aws-access-key»'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '«google-api-key»'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '«jwt»'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, '«private-key»'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, '«auth-token»'],
  // KEY=secret / API_TOKEN: "secret" — only when the name signals a secret.
  [/((?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}(["']?)/gi, '$1«redacted»$2'],
];

function scrubString(s) {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

// Deep-walk any JSON value, replacing string leaves. Returns a new structure;
// does not mutate the input.
function scrubValue(v) {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = scrubValue(v[k]);
    return out;
  }
  return v;
}

export function redactBundle(bundle) {
  return scrubValue(bundle);
}

// Exposed for tests / a future `vbrt push --dry-run` preview.
export { scrubString };
