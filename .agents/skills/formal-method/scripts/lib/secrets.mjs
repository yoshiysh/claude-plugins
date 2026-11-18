// 秘密値の走査（cli-contract.md「run の領域の配置」）。型は閉じた 4 つだけで、この集合に無い形は検出しない。
// 見つけた値は返さず、型と行の番号だけを返す。
const PATTERNS = Object.freeze([
  ['private_key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ['aws_access_key_id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
]);

// JSON の文字列のエスケープ（\n・\t・\uXXXX など）を同じ長さの空白に置く。JSON に書いた記録では、値の中の改行・タブの
// 直後のトークンが「\n」の n に続いて \b に当たらないため、元の行と置いた行の両方で照らす（行の番号は変わらない）。
const JSON_ESCAPE = /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const blankEscapes = (line) => line.replace(JSON_ESCAPE, (m) => ' '.repeat(m.length));

export function scanSecrets(input) {
  const text = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const unescaped = blankEscapes(line);
    for (const [type, re] of PATTERNS) if (re.test(line) || re.test(unescaped)) hits.push({ type, line: i + 1 });
  });
  return hits;
}

export const describeHits = (hits) => hits.map((h) => `${h.type}（${h.line} 行目）`).join('・');
