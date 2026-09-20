import { parseSync } from 'oxc-parser';

export function parseSource(filename, sourceText) {
  try {
    const result = parseSync(filename, sourceText, {
      sourceType: 'unambiguous',
      preserveParens: true
    });
    return {
      ast: result.program,
      errors: result.errors,
      comments: result.comments
    };
  } catch (err) {
    return {
      ast: null,
      errors: [err],
      comments: []
    };
  }
}

export function createSourceLocator(sourceText) {
  const lineStarts = [0];
  const len = sourceText.length;
  for (let i = 0; i < len; i++) {
    if (sourceText.charCodeAt(i) === 10 /* \n */) {
      lineStarts.push(i + 1);
    }
  }

  return function getLoc(offset) {
    if (offset < 0) return { line: 1, column: 1 };
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lineStarts[mid] <= offset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const lineIndex = high;
    const line = lineIndex + 1;
    const column = offset - lineStarts[lineIndex] + 1;
    return { line, column };
  };
}
