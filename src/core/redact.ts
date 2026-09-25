import { basename } from "node:path";

export interface SecretFinding {
  type: string;
  masked: string;
  index: number;
}

const PATTERNS: { type: string; re: RegExp }[] = [
  { type: "private key", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { type: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    type: "AWS secret access key",
    re: /aws_?secret_?access_?key["'\s:=]+[A-Za-z0-9/+]{40}\b/gi,
  },
  { type: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { type: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { type: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { type: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: "OpenAI API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "Stripe secret key", re: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/g },
  { type: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    type: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

function mask(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

/** Finds likely credentials in outgoing text. Heuristic by design: false positives are OK. */
export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      findings.push({ type, masked: mask(m[0]), index: m.index });
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

const DENIED_NAMES = [
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials(\..*)?$/i,
  /^\.git-credentials$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];

/** Files that must not be attached to messages without --force. */
export function isDeniedAttachment(path: string): boolean {
  const name = basename(path);
  return DENIED_NAMES.some((re) => re.test(name));
}
