const rules = [
  ['opencode-session-id', /\bses_[A-Za-z0-9]{15,}\b/g],
  ['figma-file-id', /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/[A-Za-z0-9]{20,64}(?=$|[^A-Za-z0-9_-])/g],
  ['figma-file-id', /\bfileKey["'`]?\s*(?:=|:)\s*["'`]?[A-Za-z0-9_-]{20,64}(?=["'`\s,})]|$)/gi],
  ['figma-file-id', /(?:файле|файл)\s+[`"'][A-Za-z0-9]{20,64}[`"']/gi],
];

// Возвращаем только правило и строку, никогда исходное значение идентификатора.
export function findSensitiveIdentifiers(text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const found = new Set();
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(line) && !found.has(rule)) {
        findings.push({ rule, line: index + 1 });
        found.add(rule);
      }
    }
  }
  return findings;
}
