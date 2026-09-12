function numeric(value) {
  return typeof value === "number" ? value : null;
}

function lineHeight(node) {
  const fontSize = Math.max(numeric(node.fontSize) ?? 16,
    ...(node.textRuns || []).map(run => numeric(run.fontSize) ?? 0));
  if (typeof node.lineHeight === "number") return node.lineHeight;
  if (node.lineHeight?.unit === "PIXELS") return node.lineHeight.value;
  if (node.lineHeight?.unit === "PERCENT") return fontSize * node.lineHeight.value / 100;
  return fontSize * 1.2;
}

function estimatedTextWidth(text, fontSize) {
  let units = 0;
  for (const character of text) {
    if (/\s/u.test(character)) units += 0.33;
    else if (/[.,:;!|·—\-]/u.test(character)) units += 0.38;
    else if (/[MWШЩЮЖФ]/u.test(character)) units += 0.82;
    else units += 0.66;
  }
  return units * fontSize;
}

function estimatedLines(node, width) {
  const paragraphs = String(node.content ?? "").split("\n");
  if (!width) return Math.max(1, paragraphs.length);
  const fontSize = Math.max(numeric(node.fontSize) ?? 16,
    ...(node.textRuns || []).map(run => numeric(run.fontSize) ?? 0));
  return paragraphs.reduce((total, paragraph) => {
    const words = paragraph.split(/(\s+)/u).filter(Boolean);
    let lines = 1;
    let used = 0;
    for (const word of words) {
      const wordWidth = estimatedTextWidth(word, fontSize);
      if (!/^\s+$/u.test(word) && wordWidth > width) {
        if (used > 0) lines += 1;
        const fragments = Math.ceil(wordWidth / width);
        lines += fragments - 1;
        used = wordWidth % width;
        continue;
      }
      if (used > 0 && used + wordWidth > width) {
        lines += 1;
        used = /^\s+$/u.test(word) ? 0 : wordWidth;
      } else {
        used += wordWidth;
      }
    }
    return total + lines;
  }, 0);
}

function textBounds(node) {
  const width = numeric(node.width);
  if (width === null) return null;
  const measuredHeight = estimatedLines(node, width) * lineHeight(node);
  const fixedHeight = numeric(node.height);
  return {
    x: numeric(node.x) ?? 0,
    y: numeric(node.y) ?? 0,
    width,
    height: fixedHeight ?? measuredHeight,
  };
}

function intersects(a, b) {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5
    && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;
}

function overflowDirections(bounds, clip) {
  const directions = [];
  if (bounds.x < clip.x - 0.5) directions.push("left");
  if (bounds.y < clip.y - 0.5) directions.push("top");
  if (bounds.x + bounds.width > clip.x + clip.width + 0.5) directions.push("right");
  if (bounds.y + bounds.height > clip.y + clip.height + 0.5) directions.push("bottom");
  return directions;
}

function translated(bounds, origin) {
  return { ...bounds, x: bounds.x + origin.x, y: bounds.y + origin.y };
}

export function analyzeNormalizedGeometry(spec, { warningLimit = 200 } = {}) {
  const warnings = [];
  let totalWarnings = 0;

  function addWarning(warning) {
    totalWarnings += 1;
    if (warnings.length < warningLimit) warnings.push(warning);
  }

  function visit(parent, { inheritedVisible = true, origin = { x: 0, y: 0 }, clips = [] } = {}) {
    if (!inheritedVisible || parent.visible === false) return;
    const children = parent.children || [];
    const freeLayout = parent.layout?.direction === "none";
    const parentWidth = numeric(parent.width);
    const parentHeight = numeric(parent.height);
    const activeClips = parent.clipContent && parentWidth !== null && parentHeight !== null
      ? [...clips, { key: parent.key, x: origin.x, y: origin.y, width: parentWidth, height: parentHeight }]
      : clips;

    const texts = children
      .filter(node => node.type === "text" && node.visible !== false
        && (freeLayout || node.layoutPositioning === "ABSOLUTE"))
      .map(node => ({ node, bounds: textBounds(node) }))
      .filter(item => item.bounds);
    for (const item of texts) item.bounds = translated(item.bounds, origin);

    if (texts.length) {
      for (let left = 0; left < texts.length; left += 1) {
        for (let right = left + 1; right < texts.length; right += 1) {
          if (!intersects(texts[left].bounds, texts[right].bounds)) continue;
          const keys = [texts[left].node.key, texts[right].node.key];
          addWarning({
            code: "TEXT_OVERLAP",
            parentKey: parent.key,
            keys,
            message: freeLayout
              ? `Текстовые узлы ${keys[0]} и ${keys[1]} могут перекрываться в свободной раскладке ${parent.key}.`
              : `Абсолютные текстовые узлы ${keys[0]} и ${keys[1]} могут перекрываться в Auto Layout ${parent.key}.`,
          });
        }
      }

      for (const { node, bounds } of texts) {
        for (const clip of activeClips) {
          const overflow = overflowDirections(bounds, clip);
          if (!overflow.length) continue;
          addWarning({
            code: "TEXT_CLIPPED",
            parentKey: clip.key,
            keys: [node.key],
            overflow,
            message: `Текстовый узел ${node.key} может обрезаться контейнером ${clip.key}: ${overflow.join(", ")}.`,
          });
        }
      }
    }

    for (const child of children) {
      if (!child.children) continue;
      if (freeLayout || child.layoutPositioning === "ABSOLUTE") {
        visit(child, {
          inheritedVisible: child.visible !== false,
          origin: {
            x: origin.x + (numeric(child.x) ?? 0),
            y: origin.y + (numeric(child.y) ?? 0),
          },
          clips: activeClips,
        });
      } else {
        // Auto Layout determines this child's position at runtime. Start a new
        // local coordinate chain so the child can still validate its own free layout.
        visit(child, { inheritedVisible: child.visible !== false });
      }
    }
  }

  visit(spec);
  return { warnings, totalWarnings, truncated: totalWarnings > warnings.length };
}
