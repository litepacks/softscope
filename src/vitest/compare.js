import fs from 'node:fs';

/**
 * Compares current Vitest test performance results against a saved baseline.
 *
 * @param {Array<Object>} currentTests - List of serialized test metadata from Vitest tasks
 * @param {Object|string} baseline - Baseline JSON object or file path
 * @param {Object} [options]
 * @param {number} [options.threshold=10] - Percentage degradation threshold to flag as regression
 * @param {number} [options.minAbsoluteDeltaMs=1.0] - Minimum absolute duration difference in ms before flagging
 * @returns {Object} Comparison report
 */
export function compareTestMetrics(currentTests = [], baseline, options = {}) {
  const thresholdPct = Number(options.threshold ?? 10);
  const minAbsoluteDeltaMs = Number(options.minAbsoluteDeltaMs ?? 1.0);

  let baselineData = null;
  let missingBaseline = false;

  if (typeof baseline === 'string') {
    try {
      if (fs.existsSync(baseline)) {
        baselineData = JSON.parse(fs.readFileSync(baseline, 'utf-8'));
      } else {
        missingBaseline = true;
      }
    } catch (err) {
      return {
        missingBaseline: true,
        error: `Failed to read baseline file: ${err.message}`,
        regressions: [],
        improvements: [],
        matches: [],
        newMetrics: [],
        removedMetrics: []
      };
    }
  } else if (baseline && typeof baseline === 'object') {
    baselineData = baseline;
  } else {
    missingBaseline = true;
  }

  if (missingBaseline || !baselineData) {
    return {
      missingBaseline: true,
      error: 'Baseline data not found or empty',
      regressions: [],
      improvements: [],
      matches: [],
      newMetrics: [],
      removedMetrics: []
    };
  }

  // Environment compatibility check
  const envWarnings = [];
  if (baselineData.environment) {
    const bEnv = baselineData.environment;
    if (bEnv.platform && bEnv.platform !== process.platform) {
      envWarnings.push(`Platform mismatch: baseline created on "${bEnv.platform}", current is "${process.platform}"`);
    }
    if (bEnv.arch && bEnv.arch !== process.arch) {
      envWarnings.push(`Architecture mismatch: baseline created on "${bEnv.arch}", current is "${process.arch}"`);
    }
  }

  // Index baseline tests by baselineKey
  const baselineMap = new Map(); // baselineKey -> { test, metricsMap: Map(metricKey -> metric) }
  const baselineItems = Array.isArray(baselineData.tests) ? baselineData.tests : [];

  for (const bTest of baselineItems) {
    const key = bTest.baselineKey || `${bTest.file} > ${bTest.testName}`;
    const metricsMap = new Map();
    if (Array.isArray(bTest.metrics)) {
      for (const m of bTest.metrics) {
        const mKey = `${m.name}@${m.file || ''}:${m.line || 0}`;
        metricsMap.set(mKey, m);
      }
    }
    baselineMap.set(key, { test: bTest, metricsMap, seen: false });
  }

  const regressions = [];
  const improvements = [];
  const matches = [];
  const newMetrics = [];
  const seenMetricKeys = new Set();

  for (const currTest of currentTests) {
    const tKey = currTest.baselineKey || `${currTest.file} > ${currTest.testName}`;
    const bEntry = baselineMap.get(tKey);

    // Track retry attempts
    const isRetry = Boolean(currTest.retry && currTest.retry > 0);
    const retryNotice = isRetry ? ` (retry #${currTest.retry})` : '';

    if (!bEntry) {
      // Entire test is new in current run
      for (const m of (currTest.metrics || [])) {
        newMetrics.push({
          testKey: tKey,
          testName: `${currTest.testName}${retryNotice}`,
          file: currTest.file,
          metric: m,
          status: 'new'
        });
      }
      continue;
    }

    bEntry.seen = true;

    // Compare each metric in current test
    for (const currM of (currTest.metrics || [])) {
      const mKey = `${currM.name}@${currM.file || ''}:${currM.line || 0}`;
      const compositeKey = `${tKey}::${mKey}`;
      seenMetricKeys.add(compositeKey);

      const baseM = bEntry.metricsMap.get(mKey);
      if (!baseM) {
        newMetrics.push({
          testKey: tKey,
          testName: `${currTest.testName}${retryNotice}`,
          file: currTest.file,
          metric: currM,
          status: 'new'
        });
        continue;
      }

      const baseDuration = Number(baseM.totalDurationMs || 0);
      const currDuration = Number(currM.totalDurationMs || 0);
      const deltaMs = Number((currDuration - baseDuration).toFixed(3));

      // Safe percentage calculation guarding against zero division
      let deltaPct = 0;
      if (baseDuration > 0.001) {
        deltaPct = Number(((deltaMs / baseDuration) * 100).toFixed(1));
      } else if (currDuration > 0.001) {
        deltaPct = 100.0;
      }

      const baseAvg = Number(baseM.avgDurationMs || 0);
      const currAvg = Number(currM.avgDurationMs || 0);

      const comparisonItem = {
        testKey: tKey,
        testName: `${currTest.testName}${retryNotice}`,
        file: currTest.file,
        name: currM.name,
        baselineCalls: baseM.calls || 0,
        currentCalls: currM.calls || 0,
        baselineDurationMs: baseDuration,
        currentDurationMs: currDuration,
        deltaMs,
        deltaPct,
        baselineAvgMs: baseAvg,
        currentAvgMs: currAvg,
        isRetry
      };

      // Both relative percentage AND minimum absolute delta must be exceeded
      const isRegressed = deltaMs >= minAbsoluteDeltaMs && (baseDuration > 0 ? deltaPct >= thresholdPct : deltaMs >= minAbsoluteDeltaMs);
      const isImproved = (-deltaMs) >= minAbsoluteDeltaMs && (baseDuration > 0 ? (-deltaPct) >= thresholdPct : false);

      if (isRegressed) {
        comparisonItem.status = 'regressed';
        regressions.push(comparisonItem);
      } else if (isImproved) {
        comparisonItem.status = 'improved';
        improvements.push(comparisonItem);
      } else {
        comparisonItem.status = 'matched';
        matches.push(comparisonItem);
      }
    }
  }

  // Detect removed metrics or tests from baseline
  const removedMetrics = [];
  for (const [tKey, bEntry] of baselineMap.entries()) {
    for (const [mKey, baseM] of bEntry.metricsMap.entries()) {
      const compositeKey = `${tKey}::${mKey}`;
      if (!seenMetricKeys.has(compositeKey)) {
        removedMetrics.push({
          testKey: tKey,
          testName: bEntry.test.testName,
          file: bEntry.test.file,
          metric: baseM,
          status: 'removed'
        });
      }
    }
  }

  return {
    missingBaseline: false,
    envWarnings,
    thresholdPct,
    minAbsoluteDeltaMs,
    regressions,
    improvements,
    matches,
    newMetrics,
    removedMetrics,
    hasRegressions: regressions.length > 0
  };
}
