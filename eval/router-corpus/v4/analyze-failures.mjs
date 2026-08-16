import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUT_FILES = {
  prompts: "blind-v4.prompts.jsonl",
  labels: "blind-v4.labels.jsonl",
  sources: "blind-v4.sources.jsonl",
  results: "blind-v4-results.json",
};
const OUTPUT_JSON = join(HERE, "failure-analysis.json");
const OUTPUT_MARKDOWN = join(HERE, "failure-analysis.md");
const ROUTES = ["bypass", "contract", "lattice", "probe"];
const EXPECTED_ROUTES = ["bypass", "contract", "lattice"];
const NUMERIC_FEATURES = [
  "characterCount",
  "wordCount",
  "headingCount",
  "listItemCount",
  "actionClauseCount",
  "pathOrCodeReferenceCount",
];
const SIGNAL_FEATURES = [
  "acceptance",
  "reproduction",
  "rollback",
  "permission",
  "sourceOfTruth",
  "multipleDeliverables",
  "stagedStructure",
];

function readUtf8(name) {
  return readFileSync(join(HERE, name), "utf8");
}

function readJsonl(name) {
  const content = readUtf8(name).trim();
  return content === "" ? [] : content.split(/\r?\n/u).map((line) => JSON.parse(line));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function indexUnique(rows, label) {
  const result = new Map();
  for (const row of rows) {
    assert(typeof row.id === "string" && row.id.length > 0, `${label} row is missing id`);
    assert(!result.has(row.id), `${label} contains duplicate id ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function countWords(text) {
  // Han characters are counted individually; other Unicode letter/number runs are words.
  return countMatches(text, /\p{Script=Han}|[\p{L}\p{N}]+/gu);
}

function splitClauses(text) {
  return text
    .split(/[\n.!?;:。！？；：]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function countActionClauses(text) {
  const englishAction =
    /\b(?:add|allow|apply|build|change|check|configure|convert|create|delete|disable|display|enable|ensure|expose|fix|generate|implement|install|migrate|move|prevent|publish|remove|rename|replace|restore|return|run|save|send|show|support|test|track|update|use|validate|verify|write)(?:s|ed|ing)?\b/iu;
  const chineseAction =
    /(?:新增|添加|允许|应用|构建|修改|检查|配置|转换|创建|删除|禁用|显示|启用|确保|暴露|修复|生成|实现|安装|迁移|移动|阻止|发布|移除|重命名|替换|恢复|返回|运行|保存|发送|展示|支持|测试|跟踪|更新|使用|验证|写入)/u;
  return splitClauses(text).filter(
    (clause) => englishAction.test(clause) || chineseAction.test(clause),
  ).length;
}

function countHeadings(text) {
  const lines = text.split(/\r?\n/u);
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^#{1,6}\s+\S/u.test(line) || /^\*\*[^*]+\*\*:?$/u.test(line)) {
      count += 1;
      continue;
    }
    // A short standalone line followed by body text is a structural section heading.
    if (
      line.length > 0 &&
      line.length <= 80 &&
      !/[.!?。！？]$/u.test(line) &&
      index + 1 < lines.length &&
      lines[index + 1].trim().length > 0 &&
      (index === 0 || lines[index - 1].trim().length === 0)
    ) {
      count += 1;
    }
  }
  return count;
}

function countListItems(text) {
  const lineItems = countMatches(text, /^\s*(?:[-+*]|\d+[.)])\s+\S/gmu);
  const inlineBullets = countMatches(text, /(?<!\S)[*+-]\s+(?=[\p{L}\p{N}*`])/gu);
  const inlineNumbers = countMatches(text, /(?<!\S)\d+[.)]\s+(?=[\p{L}\p{N}*`])/gu);
  return Math.max(lineItems, inlineBullets + inlineNumbers);
}

function countPathOrCodeReferences(text) {
  const fenced = countMatches(text, /```[\s\S]*?```/gu);
  const inlineCode = countMatches(text.replace(/```[\s\S]*?```/gu, ""), /`[^`\n]+`/gu);
  const paths = countMatches(
    text,
    /(?:^|[\s(])(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.@-]+(?:\.[\w.-]+)?(?=$|[\s),:;])/gmu,
  );
  const qualifiedSymbols = countMatches(
    text,
    /\b(?:[A-Za-z_$][\w$]*\.){1,}[A-Za-z_$][\w$]*(?:\(\))?/gu,
  );
  const omittedCode = countMatches(text, /\[code omitted\]/giu);
  return fenced + inlineCode + paths + qualifiedSymbols + omittedCode;
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractSignals(text, numeric) {
  const acceptance = hasAny(text, [
    /\b(?:acceptance criteria|expected (?:behavior|result|output)|definition of done|must (?:pass|return|produce|remain)|successfully|should (?:be|show|return|produce|allow|prevent))\b/iu,
    /(?:验收标准|预期(?:行为|结果|输出)|完成标准|必须(?:通过|返回|产生|保持)|成功时|应该(?:能够|显示|返回|生成|阻止))/u,
  ]);
  const reproduction = hasAny(text, [
    /\b(?:steps? to reproduce|reproduction|reproduce[ds]?|actual behavior|current behavior|stack trace|error message|observed)\b/iu,
    /(?:复现步骤|重现步骤|复现|重现|实际结果|当前行为|错误信息|堆栈|观察到)/u,
  ]);
  const rollback = hasAny(text, [
    /\b(?:roll\s?back|back\s?out|revert|restore (?:the )?(?:previous|prior|old)|downgrade|undo|down migration|fallback)\b/iu,
    /(?:回滚|撤销|还原到|恢复旧|降级|向下迁移|失败回退)/u,
  ]);
  const permission = hasAny(text, [
    /\b(?:permission|authorization|authorisation|access control|role-based|privilege|administrator|admin-only|ownership|security boundary|credential)\b/iu,
    /(?:权限|授权|访问控制|角色控制|管理员|特权|所有权|安全边界|凭据)/u,
  ]);
  const sourceOfTruth = hasAny(text, [
    /\b(?:source of truth|authoritative|canonical (?:source|record|state)|system of record|single source|reconcile|synchroni[sz]e|data provenance|truth source)\b/iu,
    /(?:单一真源|事实来源|权威(?:来源|记录|状态)|规范来源|记录系统|数据溯源|对账|同步一致)/u,
  ]);
  const stagedLanguage = hasAny(text, [
    /\b(?:phase|stage|milestone|wave|iteration|step\s+[1-9]|first.+then|before.+after)\b/isu,
    /(?:阶段|里程碑|分期|批次|迭代|第[一二三四五六七八九十]+步|先.+再|之前.+之后)/su,
  ]);
  const numberedSequence = countMatches(text, /(?:^|\n)\s*\d+[.)]\s+\S/gmu) >= 3;
  const stagedStructure = stagedLanguage || numberedSequence || numeric.headingCount >= 3;
  const conjunctionGroups = countMatches(
    text,
    /\b(?:and|as well as|plus)\b|(?:以及|并且|同时|另外|还要|分别)/giu,
  );
  const multipleDeliverables =
    (numeric.listItemCount >= 3 && numeric.actionClauseCount >= 2) ||
    numeric.actionClauseCount >= 4 ||
    (numeric.actionClauseCount >= 2 && conjunctionGroups >= 2);

  return {
    acceptance,
    reproduction,
    rollback,
    permission,
    sourceOfTruth,
    multipleDeliverables,
    stagedStructure,
  };
}

function extractFeatures(text) {
  const numeric = {
    characterCount: [...text].length,
    wordCount: countWords(text),
    headingCount: countHeadings(text),
    listItemCount: countListItems(text),
    actionClauseCount: countActionClauses(text),
    pathOrCodeReferenceCount: countPathOrCodeReferences(text),
  };
  return { ...numeric, ...extractSignals(text, numeric) };
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function aggregateFeatures(rows) {
  const numeric = {};
  for (const feature of NUMERIC_FEATURES) {
    const values = rows.map((row) => row.features[feature]).sort((left, right) => left - right);
    numeric[feature] = {
      min: values[0] ?? 0,
      median: round(median(values), 2),
      mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1), 2),
      max: values.at(-1) ?? 0,
    };
  }
  const signals = {};
  for (const feature of SIGNAL_FEATURES) {
    const count = rows.filter((row) => row.features[feature]).length;
    signals[feature] = {
      count,
      rate: round(count / Math.max(rows.length, 1)),
    };
  }
  return { count: rows.length, numeric, signals };
}

function compactText(text, limit = 240) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if ([...normalized].length <= limit) return normalized;
  return `${[...normalized].slice(0, limit - 3).join("")}...`;
}

function representativeRows(rows, allRows, limit = 5) {
  if (rows.length === 0) return [];
  const centroid = {};
  for (const feature of [...NUMERIC_FEATURES, ...SIGNAL_FEATURES]) {
    centroid[feature] =
      rows.reduce((sum, row) => sum + Number(row.features[feature]), 0) / rows.length;
  }
  const ranges = Object.fromEntries(
    NUMERIC_FEATURES.map((feature) => {
      const values = allRows.map((row) => row.features[feature]);
      return [feature, Math.max(...values) - Math.min(...values) || 1];
    }),
  );
  return [...rows]
    .map((row) => {
      const numericDistance = NUMERIC_FEATURES.reduce(
        (sum, feature) =>
          sum + Math.abs(row.features[feature] - centroid[feature]) / ranges[feature],
        0,
      );
      const signalDistance = SIGNAL_FEATURES.reduce(
        (sum, feature) => sum + Math.abs(Number(row.features[feature]) - centroid[feature]),
        0,
      );
      return { row, distance: numericDistance + signalDistance };
    })
    .sort((left, right) => left.distance - right.distance || left.row.id.localeCompare(right.row.id))
    .slice(0, limit)
    .map(({ row, distance }) => ({
      id: row.id,
      language: row.language,
      repository: row.repository,
      url: row.url,
      expected: row.expected,
      actual: row.actual,
      outcomeCritical: row.outcomeCritical,
      structuralDistanceFromCellCentroid: round(distance),
      summary: compactText(row.text),
      features: row.features,
    }));
}

function groupedFailureSummary(rows, keyFor, allKeyValues) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const current = grouped.get(key) ?? { total: 0, failures: 0 };
    current.total += 1;
    current.failures += Number(!row.correct);
    grouped.set(key, current);
  }
  const keys = allKeyValues ?? [...grouped.keys()].sort();
  return Object.fromEntries(
    keys.map((key) => {
      const value = grouped.get(key) ?? { total: 0, failures: 0 };
      return [key, { ...value, failureRate: round(value.failures / Math.max(value.total, 1)) }];
    }),
  );
}

function markdownTable(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, separator, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function renderMarkdown(report) {
  const lines = [
    "# V4 Router Failure Analysis",
    "",
    "This is a deterministic derived report. The frozen V4 prompts, labels, sources, and results are not modified.",
    "",
    "## Dataset",
    "",
    `- Samples: ${report.dataset.samples}`,
    `- Correct: ${report.dataset.correct}`,
    `- Failures: ${report.dataset.failures}`,
    `- Accuracy reconstructed from joined rows: ${report.dataset.accuracy}`,
    `- Frozen release gate passed: ${report.dataset.releaseGatePassed}`,
    "",
    "## Failed Classifications",
    "",
    markdownTable(
      ["Expected -> actual", "Total", "Failures", "Failure rate"],
      Object.entries(report.failures.byExpectedActual)
        .filter(([, value]) => value.failures > 0)
        .map(([key, value]) => [key, value.total, value.failures, value.failureRate]),
    ),
    "",
    "## Failures by Language",
    "",
    markdownTable(
      ["Language", "Total", "Failures", "Failure rate"],
      Object.entries(report.failures.byLanguage).map(([key, value]) => [
        key,
        value.total,
        value.failures,
        value.failureRate,
      ]),
    ),
    "",
    "## Failures by Source Repository",
    "",
    markdownTable(
      ["Repository", "Total", "Failures", "Failure rate"],
      Object.entries(report.failures.bySourceRepository).map(([key, value]) => [
        key,
        value.total,
        value.failures,
        value.failureRate,
      ]),
    ),
    "",
    "## Structural Comparison",
    "",
    markdownTable(
      ["Feature", "All mean", "Correct mean", "Failure mean"],
      NUMERIC_FEATURES.map((feature) => [
        feature,
        report.structuralStatistics.allSamples.numeric[feature].mean,
        report.structuralStatistics.correctSamples.numeric[feature].mean,
        report.structuralStatistics.failedSamples.numeric[feature].mean,
      ]),
    ),
    "",
    markdownTable(
      ["Signal", "All rate", "Correct rate", "Failure rate"],
      SIGNAL_FEATURES.map((feature) => [
        feature,
        report.structuralStatistics.allSamples.signals[feature].rate,
        report.structuralStatistics.correctSamples.signals[feature].rate,
        report.structuralStatistics.failedSamples.signals[feature].rate,
      ]),
    ),
    "",
    "## Confusion Cells",
    "",
  ];

  for (const [key, cell] of Object.entries(report.confusionCells)) {
    lines.push(`### ${key}`, "");
    lines.push(
      `Count: ${cell.count}. Languages: ${JSON.stringify(cell.byLanguage)}. Repositories: ${JSON.stringify(cell.bySourceRepository)}.`,
      "",
    );
    if (cell.representatives.length === 0) {
      lines.push("No samples.", "");
      continue;
    }
    for (const sample of cell.representatives) {
      const summary = sample.summary.replace(/\|/gu, "\\|");
      lines.push(
        `- [${sample.id}](${sample.url}) (${sample.language}, ${sample.repository}, critical=${sample.outcomeCritical}): ${summary}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function main() {
  const rawInputs = Object.fromEntries(
    Object.entries(INPUT_FILES).map(([key, name]) => [key, readUtf8(name)]),
  );
  const prompts = readJsonl(INPUT_FILES.prompts);
  const labels = readJsonl(INPUT_FILES.labels);
  const sources = readJsonl(INPUT_FILES.sources);
  const results = JSON.parse(rawInputs.results);
  const promptById = indexUnique(prompts, "prompts");
  const labelById = indexUnique(labels, "labels");
  const sourceById = indexUnique(sources, "sources");
  const failureById = indexUnique(results.failures, "results.failures");

  assert(prompts.length > 0, "prompts are empty");
  assert(prompts.length === labels.length, "prompt and label counts differ");
  assert(prompts.length === sources.length, "prompt and source counts differ");
  for (const id of promptById.keys()) {
    assert(labelById.has(id), `missing label for ${id}`);
    assert(sourceById.has(id), `missing source for ${id}`);
  }
  for (const id of failureById.keys()) {
    assert(promptById.has(id), `failure ${id} is absent from prompts`);
  }

  const rows = prompts
    .map((prompt) => {
      const label = labelById.get(prompt.id);
      const source = sourceById.get(prompt.id);
      const failure = failureById.get(prompt.id);
      const actual = failure?.actual ?? label.expected;
      assert(EXPECTED_ROUTES.includes(label.expected), `invalid expected route for ${prompt.id}`);
      assert(ROUTES.includes(actual), `invalid actual route for ${prompt.id}`);
      if (failure) {
        assert(failure.expected === label.expected, `failure expected mismatch for ${prompt.id}`);
        assert(failure.language === prompt.language, `failure language mismatch for ${prompt.id}`);
      }
      return {
        id: prompt.id,
        language: prompt.language,
        text: prompt.text,
        expected: label.expected,
        actual,
        correct: actual === label.expected,
        outcomeCritical: label.outcomeCritical,
        repository: source.repository,
        url: source.url,
        features: extractFeatures(prompt.text),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const derivedConfusion = {};
  for (const expected of EXPECTED_ROUTES) {
    for (const actual of ROUTES) {
      const key = `${expected}->${actual}`;
      derivedConfusion[key] = rows.filter(
        (row) => row.expected === expected && row.actual === actual,
      ).length;
      assert(
        derivedConfusion[key] === (results.confusion[key] ?? 0),
        `derived confusion count differs from frozen results for ${key}`,
      );
    }
  }

  const correctRows = rows.filter((row) => row.correct);
  const failedRows = rows.filter((row) => !row.correct);
  assert(failedRows.length === results.failures.length, "derived failure count differs from results");
  const expectedActualKeys = Object.keys(derivedConfusion);
  const languages = [...new Set(rows.map((row) => row.language))].sort();
  const repositories = [...new Set(rows.map((row) => row.repository))].sort();

  const confusionCells = Object.fromEntries(
    expectedActualKeys.map((key) => {
      const cellRows = rows.filter((row) => `${row.expected}->${row.actual}` === key);
      return [
        key,
        {
          count: cellRows.length,
          byLanguage: Object.fromEntries(
            languages.map((language) => [
              language,
              cellRows.filter((row) => row.language === language).length,
            ]),
          ),
          bySourceRepository: Object.fromEntries(
            repositories
              .map((repository) => [
                repository,
                cellRows.filter((row) => row.repository === repository).length,
              ])
              .filter(([, count]) => count > 0),
          ),
          structuralStatistics: aggregateFeatures(cellRows),
          representatives: representativeRows(cellRows, rows),
        },
      ];
    }),
  );

  const report = {
    schemaVersion: 1,
    derivation: {
      deterministic: true,
      inputs: Object.fromEntries(
        Object.entries(INPUT_FILES).map(([key, name]) => [
          key,
          { file: name, sha256: sha256(rawInputs[key]) },
        ]),
      ),
      representativeSelection:
        "Up to five rows nearest the confusion-cell centroid across normalized structural counts and Boolean signals; ties use id order.",
    },
    dataset: {
      samples: rows.length,
      correct: correctRows.length,
      failures: failedRows.length,
      accuracy: round(correctRows.length / rows.length),
      releaseGatePassed: results.releaseGatePassed,
    },
    failures: {
      byExpectedActual: groupedFailureSummary(
        rows,
        (row) => `${row.expected}->${row.actual}`,
        expectedActualKeys,
      ),
      byLanguage: groupedFailureSummary(rows, (row) => row.language, languages),
      bySourceRepository: groupedFailureSummary(rows, (row) => row.repository, repositories),
    },
    structuralStatistics: {
      allSamples: aggregateFeatures(rows),
      correctSamples: aggregateFeatures(correctRows),
      failedSamples: aggregateFeatures(failedRows),
    },
    confusionCells,
  };

  writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(OUTPUT_MARKDOWN, renderMarkdown(report));
  process.stdout.write(
    `Wrote ${OUTPUT_JSON}\nWrote ${OUTPUT_MARKDOWN}\nAnalyzed ${rows.length} rows: ${correctRows.length} correct, ${failedRows.length} failures.\n`,
  );
}

main();
