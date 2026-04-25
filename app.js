const {
  rulesBase,
  contextOptions,
  ruleContextMap,
  examples,
  batchSamples,
  slotBlueprints,
  slotConfigMap,
  aliasMap
} = window.ruleDemoData;

const severityRank = { low: 1, medium: 2, high: 3 };
const confidenceRank = { low: 1, medium: 2, high: 3 };
const fallbackRuleId = "R030";
const semanticEndpoint = "/api/semantic-assist";
const semanticTimeoutMs = 12000;
const localDraftsKey = "gender-rule-demo-local-drafts-v4";

const state = {
  input: examples?.[0] ?? "",
  selectedContext: contextOptions?.[0] ?? "不限",
  resultPageIndex: 0,
  similarityThreshold: 0.65,
  batchInput: (batchSamples?.length ? batchSamples : [
    "女孩要听话一点。",
    "都三十多了，再晚就不好找对象了。",
    "说话这么冲以后会吃亏。",
    "你太敏感了吧，我就开个玩笑。",
    "你今天穿得很好看。"
  ]).join("\n"),
  localDrafts: loadLocalDrafts(),
  rulesFileHandle: null,
  semanticAssist: {
    key: "",
    status: "idle",
    results: [],
    error: ""
  },
  semanticAssistTimer: null
};

const refs = {
  inputText: document.getElementById("inputText"),
  charCount: document.getElementById("charCount"),
  clearButton: document.getElementById("clearButton"),
  contextButtons: document.getElementById("contextButtons"),
  similarityRange: document.getElementById("similarityRange"),
  similarityValue: document.getElementById("similarityValue"),
  contextStatus: document.getElementById("contextStatus"),
  exampleList: document.getElementById("exampleList"),
  analysisRoot: document.getElementById("analysisRoot"),
  libraryMetrics: document.getElementById("libraryMetrics"),
  batchInputText: document.getElementById("batchInputText"),
  batchCount: document.getElementById("batchCount"),
  batchClearButton: document.getElementById("batchClearButton"),
  batchSummary: document.getElementById("batchSummary"),
  batchResultsRoot: document.getElementById("batchResultsRoot"),
  keywordHintRoot: document.getElementById("keywordHintRoot"),
  draftSummary: document.getElementById("draftSummary"),
  draftListRoot: document.getElementById("draftListRoot"),
  connectRulesButton: document.getElementById("connectRulesButton"),
  writeRulesButton: document.getElementById("writeRulesButton"),
  clearDraftsButton: document.getElementById("clearDraftsButton"),
  exportDraftsButton: document.getElementById("exportDraftsButton"),
  rulesFileStatus: document.getElementById("rulesFileStatus")
};

const stopPhraseSet = new Set([
  "你", "我", "他", "她", "它", "这个", "那个", "这样", "那样", "就是", "真的",
  "现在", "以后", "已经", "只是", "的话", "而已", "一个", "一种", "一点", "可以",
  "应该", "还是", "不要", "别太", "女生", "女孩", "女人", "老婆", "妻子", "对象",
  "而且", "因为", "所以", "然后", "就是啊", "的话呀", "可以吗", "一下", "一下子"
]);

function buildSlots(parts = [], options = {}) {
  const requiredIndexes = options.requiredIndexes ?? parts.map((_, index) => index);
  const weightMap = options.weightMap ?? {};

  return parts.map((keywords, index) => ({
    slotId: `S${index + 1}`,
    label: keywords.slice(0, 3).join(" / "),
    matchAny: keywords,
    required: requiredIndexes.includes(index),
    weight: weightMap[index] ?? (requiredIndexes.includes(index) ? 2 : 1)
  }));
}

const rules = rulesBase.map((rule) => ({
  ...rule,
  slots: slotBlueprints?.[rule.rule_id]
    ? buildSlots(slotBlueprints[rule.rule_id], slotConfigMap?.[rule.rule_id] ?? {})
    : []
}));

const fallbackRule = rules.find((rule) => rule.rule_id === fallbackRuleId);

function normalize(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[！!]/g, "!")
    .replace(/[？?]/g, "?")
    .replace(/[，,]/g, ",")
    .replace(/[。．.]/g, ".")
    .replace(/[；;]/g, ";")
    .replace(/[：:]/g, ":")
    .replace(/[“”"']/g, "")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function setRulesFileStatus(message, tone = "muted") {
  refs.rulesFileStatus.textContent = message;
  refs.rulesFileStatus.className = "draft-empty";
  if (tone === "connected") {
    refs.rulesFileStatus.classList.add("is-connected");
  }
  if (tone === "error") {
    refs.rulesFileStatus.classList.add("is-error");
  }
}

function getSemanticAssistKey(text, context) {
  return `${context}::${String(text ?? "").trim()}`;
}

function loadLocalDrafts() {
  try {
    const raw = window.localStorage.getItem(localDraftsKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalDrafts() {
  window.localStorage.setItem(localDraftsKey, JSON.stringify(state.localDrafts));
}

function getRuntimeAliasMap() {
  const merged = {};

  Object.entries(aliasMap ?? {}).forEach(([key, values]) => {
    merged[key] = Array.isArray(values) ? [...values] : [];
  });

  state.localDrafts.forEach((draft) => {
    if (!merged[draft.canonicalWord]) {
      merged[draft.canonicalWord] = [];
    }
    if (!merged[draft.canonicalWord].includes(draft.phrase)) {
      merged[draft.canonicalWord].push(draft.phrase);
    }
  });

  return merged;
}

function getAliases(keyword) {
  const merged = getRuntimeAliasMap();
  return merged[keyword] ?? merged[normalize(keyword)] ?? [];
}

function splitNormalizedSegments(normalizedText) {
  return normalizedText
    .split(/[,.!?:;，。！？：；]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function levenshteinDistance(source, target) {
  const rows = source.length + 1;
  const cols = target.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = source[row - 1] === target[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

function getStringSimilarity(source, target) {
  if (!source || !target) {
    return 0;
  }

  if (source === target) {
    return 1;
  }

  return 1 - levenshteinDistance(source, target) / Math.max(source.length, target.length);
}

function getSimilarityCandidates(normalizedText, keywordLength) {
  const segments = splitNormalizedSegments(normalizedText);
  const candidates = new Set();

  segments.forEach((segment) => {
    const minLength = Math.max(2, keywordLength - 2);
    const maxLength = Math.min(segment.length, keywordLength + 2);

    if (segment.length >= minLength) {
      candidates.add(segment);
    }

    for (let currentLength = minLength; currentLength <= maxLength; currentLength += 1) {
      for (let start = 0; start <= segment.length - currentLength; start += 1) {
        candidates.add(segment.slice(start, start + currentLength));
      }
    }
  });

  return Array.from(candidates);
}

function findKeywordSimilarityMatch(normalizedText, keyword) {
  const normalizedKeyword = normalize(keyword);

  if (!normalizedKeyword || normalizedKeyword.length < 3) {
    return null;
  }

  let bestMatch = null;
  const candidates = getSimilarityCandidates(normalizedText, normalizedKeyword.length);

  candidates.forEach((candidate) => {
    const similarity = getStringSimilarity(normalizedKeyword, candidate);
    if (similarity < state.similarityThreshold) {
      return;
    }
    if (!bestMatch || similarity > bestMatch.similarity) {
      bestMatch = {
        keyword,
        matchedText: candidate,
        similarity
      };
    }
  });

  return bestMatch;
}

function findKeywordMatch(normalizedText, keyword) {
  const normalizedKeyword = normalize(keyword);

  if (!normalizedKeyword) {
    return null;
  }

  if (normalizedText.includes(normalizedKeyword)) {
    return { keyword, matchedText: keyword, mode: "exact", similarity: 1 };
  }

  const aliases = getAliases(keyword);
  const matchedAlias = aliases.find((alias) => normalizedText.includes(normalize(alias)));
  if (matchedAlias) {
    return { keyword, matchedText: matchedAlias, mode: "alias", similarity: 1 };
  }

  if (normalizedKeyword.length >= 6) {
    const parts = normalizedKeyword.match(/.{1,2}/g) ?? [];
    const longParts = parts.filter((part) => part.length >= 2);
    if (longParts.length >= 3 && longParts.every((part) => normalizedText.includes(part))) {
      return { keyword, matchedText: keyword, mode: "fragment", similarity: 0.66 };
    }
  }

  const similarityMatch = findKeywordSimilarityMatch(normalizedText, keyword);
  if (similarityMatch) {
    return {
      keyword,
      matchedText: similarityMatch.matchedText,
      mode: "similar",
      similarity: similarityMatch.similarity
    };
  }

  return null;
}

function buildLegacySlots(rule) {
  return [
    {
      slotId: "legacy-1",
      label: "主体词",
      matchAny: rule.must_include_any ?? [],
      required: (rule.must_include_any ?? []).length > 0,
      weight: (rule.must_include_any ?? []).length > 0 ? 2 : 1
    },
    {
      slotId: "legacy-2",
      label: "判断词",
      matchAny: rule.must_include_any_2 ?? [],
      required: (rule.must_include_any_2 ?? []).length > 0,
      weight: (rule.must_include_any_2 ?? []).length > 0 ? 2 : 1
    }
  ].filter((slot) => slot.required || slot.matchAny.length > 0);
}

function matchRule(text, rule, options = {}) {
  const normalizedText = normalize(text);
  const allowPartial = options.allowPartial ?? false;

  const hitExclude = (rule.exclude_any ?? []).some((word) => !!findKeywordMatch(normalizedText, word));
  if (hitExclude) {
    return null;
  }

  const slots = rule.slots?.length ? rule.slots : buildLegacySlots(rule);
  const slotHits = [];
  let missingRequiredCount = 0;

  for (const slot of slots) {
    const matches = slot.matchAny
      .map((word) => findKeywordMatch(normalizedText, word))
      .filter(Boolean);

    if (slot.required && matches.length === 0) {
      missingRequiredCount += 1;
      if (!allowPartial) {
        return null;
      }
    }

    slotHits.push({
      slotId: slot.slotId,
      label: slot.label,
      required: !!slot.required,
      weight: slot.weight ?? 1,
      matches
    });
  }

  const hitWords = slotHits.flatMap((slot) => slot.matches.map((match) => match.keyword));
  const matchedSlotCount = slotHits.filter((slot) => slot.matches.length > 0).length;
  const weightedSlotScore = slotHits.reduce((sum, slot) => {
    return sum + (slot.matches.length > 0 ? slot.weight : 0);
  }, 0);

  if (!allowPartial && matchedSlotCount === 0) {
    return null;
  }

  return {
    ...rule,
    slotHits,
    hitWords: Array.from(new Set(hitWords)),
    matchedSlotCount,
    weightedSlotScore,
    missingRequiredCount,
    missingRequiredSlots: slotHits.filter((slot) => slot.required && slot.matches.length === 0),
    score: hitWords.length + matchedSlotCount + weightedSlotScore
  };
}

function analyzeText(text, selectedContext) {
  if (!String(text ?? "").trim()) {
    return null;
  }

  const matches = rules
    .filter((rule) => rule.rule_id !== fallbackRuleId)
    .map((rule) => {
      const matched = matchRule(text, rule);
      if (!matched) {
        return null;
      }

      const supportedContexts = ruleContextMap?.[rule.rule_id] ?? [];
      const contextBoost =
        selectedContext && selectedContext !== "不限" && supportedContexts.includes(selectedContext)
          ? 2
          : 0;

      return {
        ...matched,
        supportedContexts,
        contextBoost,
        totalScore: matched.score + contextBoost
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      if ((b.priority ?? 0) !== (a.priority ?? 0)) {
        return (b.priority ?? 0) - (a.priority ?? 0);
      }
      if (confidenceRank[b.confidence_default] !== confidenceRank[a.confidence_default]) {
        return confidenceRank[b.confidence_default] - confidenceRank[a.confidence_default];
      }
      return severityRank[b.severity_default] - severityRank[a.severity_default];
    });

  if (!matches.length) {
    return {
      primary: fallbackRule,
      topMatches: [fallbackRule]
    };
  }

  return {
    primary: matches[0],
    topMatches: matches.slice(0, 3)
  };
}

function shouldUseSemanticAssist(analysis) {
  const primary = analysis?.primary ?? fallbackRule;
  const topScore = analysis?.topMatches?.[0]?.totalScore ?? primary?.totalScore ?? primary?.score ?? 0;
  return primary?.rule_id === fallbackRuleId || topScore < 8;
}

function resetSemanticAssist() {
  window.clearTimeout(state.semanticAssistTimer);
  state.semanticAssist = {
    key: "",
    status: "idle",
    results: [],
    error: ""
  };
}

function requestSemanticAssist(text, selectedContext) {
  if (!String(text ?? "").trim()) {
    return;
  }

  const key = getSemanticAssistKey(text, selectedContext);
  if (state.semanticAssist.key === key && ["loading", "ready", "error"].includes(state.semanticAssist.status)) {
    return;
  }

  state.semanticAssist = {
    key,
    status: "loading",
    results: [],
    error: ""
  };

  if (window.location?.protocol === "file:") {
    state.semanticAssist = {
      key,
      status: "error",
      results: [],
      error: "当前是本地 file 页面，语义辅助只有部署后才可用。规则分析和补词本身仍可正常使用。"
    };
    return;
  }

  window.clearTimeout(state.semanticAssistTimer);
  state.semanticAssistTimer = window.setTimeout(() => {
    Promise.race([
      fetch(semanticEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          context: selectedContext,
          topK: 3
        })
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.error || `server ${response.status}`);
        }
        const payload = await response.json();
        return payload?.results ?? [];
      }),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error("semantic timeout")), semanticTimeoutMs);
      })
    ])
      .then((results) => {
        if (state.semanticAssist.key !== key) {
          return;
        }
        state.semanticAssist = {
          key,
          status: "ready",
          results,
          error: ""
        };
        renderAnalysis();
      })
      .catch((error) => {
        if (state.semanticAssist.key !== key) {
          return;
        }
        state.semanticAssist = {
          key,
          status: "error",
          results: [],
          error: error?.message === "semantic timeout"
            ? "语义辅助超时，已自动跳过。"
            : error?.message || "语义辅助暂时不可用。"
        };
        renderAnalysis();
      });
  }, 350);
}

function resolveSemanticRule(result, text) {
  if (!result) {
    return null;
  }

  const matchedRule =
    (result.rule_id ? rules.find((rule) => rule.rule_id === result.rule_id) : null) ||
    (result.name ? rules.find((rule) => rule.name === result.name) : null);

  if (!matchedRule) {
    return null;
  }

  const localPartial = text ? matchRule(text, matchedRule, true) : null;

  return {
    ...matchedRule,
    ...(localPartial ?? {}),
    ...result,
    labels: result.labels ?? matchedRule.labels ?? [],
    confidence_default: result.confidence_default ?? matchedRule.confidence_default,
    severity_default: result.severity_default ?? matchedRule.severity_default,
    surface_meaning_template: result.surface_meaning_template ?? matchedRule.surface_meaning_template,
    hidden_structure_template: result.hidden_structure_template ?? matchedRule.hidden_structure_template,
    impact_template: result.impact_template ?? matchedRule.impact_template,
    gentle_response: result.gentle_response ?? matchedRule.gentle_response,
    boundary_response: result.boundary_response ?? matchedRule.boundary_response,
    question_response: result.question_response ?? matchedRule.question_response
  };
}

function getSemanticCandidates(text, selectedContext) {
  const key = getSemanticAssistKey(text, selectedContext);

  if (state.semanticAssist.key !== key || state.semanticAssist.status !== "ready") {
    return [];
  }

  return (state.semanticAssist.results ?? [])
    .map((item) => {
      const resolved = resolveSemanticRule(item, text);
      if (!resolved) {
        return null;
      }

      return {
        ...resolved,
        semanticSimilarity: Number(item.semanticSimilarity || resolved.semanticSimilarity || 0)
      };
    })
    .filter(Boolean);
}

function getNearMisses(text, selectedContext) {
  if (!String(text ?? "").trim()) {
    return [];
  }

  return rules
    .filter((rule) => rule.rule_id !== fallbackRuleId)
    .map((rule) => {
      const partial = matchRule(text, rule, { allowPartial: true });
      if (!partial || partial.matchedSlotCount === 0) {
        return null;
      }

      const supportedContexts = ruleContextMap?.[rule.rule_id] ?? [];
      const contextBoost =
        selectedContext && selectedContext !== "不限" && supportedContexts.includes(selectedContext)
          ? 2
          : 0;

      return {
        ...partial,
        partialScore:
          partial.matchedSlotCount * 2 + partial.weightedSlotScore - partial.missingRequiredCount + contextBoost
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.partialScore - a.partialScore)
    .slice(0, 4);
}

function extractCandidatePhrases(sentence, hitWords = []) {
  const text = String(sentence ?? "");
  const phrases = new Set();
  const segments = text
    .replace(/[，。！？；：,.!?:;"'“”‘’（）()【】[\]<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  segments.forEach((segment) => {
    if (segment.length >= 2 && segment.length <= 12 && !stopPhraseSet.has(segment)) {
      if (!hitWords.some((word) => segment.includes(word) || word.includes(segment))) {
        phrases.add(segment);
      }
    }

    for (let size = 2; size <= Math.min(segment.length, 6); size += 1) {
      for (let index = 0; index <= segment.length - size; index += 1) {
        const slice = segment.slice(index, index + size);
        if (
          slice.length >= 2 &&
          !stopPhraseSet.has(slice) &&
          !hitWords.some((word) => slice.includes(word) || word.includes(slice))
        ) {
          phrases.add(slice);
        }
      }
    }
  });

  return Array.from(phrases).slice(0, 12);
}

function addDraft(phrase, rule, slot) {
  const cleanPhrase = String(phrase ?? "").trim();
  if (!cleanPhrase) {
    return;
  }

  const canonicalWord = slot?.matchAny?.[0] ?? cleanPhrase;
  const exists = state.localDrafts.some((draft) => {
    return draft.phrase === cleanPhrase
      && draft.ruleId === rule.rule_id
      && draft.canonicalWord === canonicalWord;
  });

  if (exists) {
    setRulesFileStatus("这条补词已经在本地草稿里了。");
    return;
  }

  state.localDrafts.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    phrase: cleanPhrase,
    canonicalWord,
    ruleId: rule.rule_id,
    ruleName: rule.name,
    slotId: slot?.slotId ?? "alias",
    slotLabel: slot?.label ?? canonicalWord,
    createdAt: new Date().toISOString()
  });

  saveLocalDrafts();
  setRulesFileStatus(`已把“${cleanPhrase}”加入本地补词，当前页面会立刻用它重新匹配。`, state.rulesFileHandle ? "connected" : "muted");
  renderAnalysis();
  renderBatchAndHints();
}

function removeDraft(draftId) {
  state.localDrafts = state.localDrafts.filter((draft) => draft.id !== draftId);
  saveLocalDrafts();
  setRulesFileStatus("已移除这条本地补词。", state.rulesFileHandle ? "connected" : "muted");
  renderAnalysis();
  renderBatchAndHints();
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportDrafts() {
  downloadTextFile(
    `local-drafts-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(state.localDrafts, null, 2)
  );
}

function buildMergedAliasMap() {
  const merged = getRuntimeAliasMap();
  const ordered = {};

  Object.keys(aliasMap ?? {}).forEach((key) => {
    ordered[key] = Array.from(new Set(merged[key] ?? []));
  });

  Object.keys(merged).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = Array.from(new Set(merged[key] ?? []));
    }
  });

  return ordered;
}

function serializeAliasMapBlock(map) {
  const lines = Object.entries(map).map(([key, values]) => {
    const serializedValues = Array.from(new Set(values))
      .map((item) => JSON.stringify(item))
      .join(", ");
    return `    ${JSON.stringify(key)}: [${serializedValues}],`;
  });

  return `  aliasMap: {\n${lines.join("\n")}\n  },`;
}

async function connectRulesFile() {
  if (!window.showOpenFilePicker) {
    setRulesFileStatus("当前浏览器不支持直接连接本地文件。可以先用“导出补词草稿”，或部署后再用。", "error");
    return;
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "JavaScript",
          accept: { "text/javascript": [".js"] }
        }
      ],
      excludeAcceptAllOption: false
    });

    const file = await handle.getFile();
    if (!/rules\.js$/i.test(file.name)) {
      setRulesFileStatus("选中的不是 rules.js，请重新连接。", "error");
      return;
    }

    state.rulesFileHandle = handle;
    setRulesFileStatus(`已连接 ${file.name}，现在可以把本地补词直接写回 aliasMap。`, "connected");
  } catch (error) {
    if (error?.name === "AbortError") {
      setRulesFileStatus("你取消了连接 rules.js。");
      return;
    }
    setRulesFileStatus(`连接 rules.js 失败：${error?.message || "未知错误"}`, "error");
  }
}

async function writeDraftsToRulesFile() {
  if (!state.localDrafts.length) {
    setRulesFileStatus("还没有本地补词，先点候选词把它们加进草稿。");
    return;
  }

  if (!state.rulesFileHandle) {
    setRulesFileStatus("请先连接 rules.js。", "error");
    return;
  }

  try {
    const file = await state.rulesFileHandle.getFile();
    const content = await file.text();
    const aliasBlockPattern = /(^\s*aliasMap:\s*\{)([\s\S]*?)(^\s*\},\s*$)([\s\S]*?^\s*examples:)/m;
    const mergedAliasMap = buildMergedAliasMap();
    const serialized = serializeAliasMapBlock(mergedAliasMap);

    if (!aliasBlockPattern.test(content)) {
      setRulesFileStatus("没有在 rules.js 里找到 aliasMap 段，暂时无法自动写回。", "error");
      return;
    }

    const updated = content.replace(aliasBlockPattern, `${serialized}\n$4`);
    const writable = await state.rulesFileHandle.createWritable();
    await writable.write(updated);
    await writable.close();

    setRulesFileStatus(`已把 ${state.localDrafts.length} 条本地补词写回 rules.js 的 aliasMap。`, "connected");
  } catch (error) {
    setRulesFileStatus(`写回失败：${error?.message || "未知错误"}`, "error");
  }
}

function createBadge(label, tone = "medium") {
  return `<span class="badge tone-${tone}">${escapeHtml(label)}</span>`;
}

function getBadges(items = []) {
  return items
    .filter(Boolean)
    .map((item) => createBadge(item.label, item.tone ?? "medium"))
    .join("");
}

function getModeLabel(mode) {
  return {
    exact: "原词",
    alias: "alias",
    fragment: "片段",
    similar: "近似"
  }[mode] ?? mode;
}

function renderSemanticStatus(text, selectedContext) {
  const key = getSemanticAssistKey(text, selectedContext);

  if (state.semanticAssist.key !== key || state.semanticAssist.status === "idle") {
    return "";
  }

  if (state.semanticAssist.status === "loading") {
    return `<div class="helper-note is-muted">正在补充语义方向。如果 12 秒内没有结果，会自动跳过，不会卡住规则分析。</div>`;
  }

  if (state.semanticAssist.status === "error") {
    return `<div class="helper-note is-muted">语义辅助当前不可用：${escapeHtml(state.semanticAssist.error)}</div>`;
  }

  return "";
}

function buildAnalysisPages(analysis) {
  const result = analysis?.primary ?? fallbackRule;
  const topMatches = analysis?.topMatches ?? [];
  const nearMisses = getNearMisses(state.input, state.selectedContext);
  const semanticCandidates = getSemanticCandidates(state.input, state.selectedContext);
  const pages = [];
  const usedRuleIds = new Set();

  const pushPage = (page) => {
    if (!page?.rule) {
      return;
    }

    const ruleId = page.rule.rule_id;
    if (ruleId && usedRuleIds.has(ruleId)) {
      return;
    }

    if (ruleId) {
      usedRuleIds.add(ruleId);
    }

    pages.push(page);
  };

  if (result.rule_id !== fallbackRuleId) {
    pushPage({
      sourceLabel: "规则命中",
      introTitle: "这是当前最优先的命中结果",
      introCopy: "优先按规则命中和分数排序，它是当前最稳的主分析。",
      rule: result,
      badges: [
        { label: `置信度 ${result.confidence_default ?? "low"}`, tone: result.confidence_default ?? "low" },
        { label: `严重度 ${result.severity_default ?? "low"}`, tone: result.severity_default ?? "low" },
        { label: `场景 ${state.selectedContext}`, tone: "low" }
      ],
      supportTitle: "命中词",
      supportCopy: result.hitWords?.slice(0, 8).join("、") || "无"
    });
  }

  semanticCandidates.forEach((candidate) => {
    if (pages.length >= 2) {
      return;
    }

    pushPage({
      sourceLabel: "语义接近",
      introTitle: "这是语义上也很接近的一种解释",
      introCopy: "它不一定排到主命中，但和这句话的整体语义很贴近，可以作为第二分析参考。",
      rule: candidate,
      badges: [
        { label: `相似度 ${formatPercent(candidate.semanticSimilarity)}`, tone: "medium" },
        { label: `置信度 ${candidate.confidence_default ?? "low"}`, tone: candidate.confidence_default ?? "low" },
        { label: `场景 ${state.selectedContext}`, tone: "low" }
      ],
      supportTitle: "语义来源",
      supportCopy: "来自服务端语义辅助返回的候选规则。"
    });
  });

  const secondMatched = topMatches.find((item) => item.rule_id !== result.rule_id && item.rule_id !== fallbackRuleId);
  if (pages.length < 2 && secondMatched) {
    pushPage({
      sourceLabel: "第二分析",
      introTitle: "另一条也比较接近的规则命中",
      introCopy: "它同样是规则层面接得住的解释，只是优先度低于当前主命中。",
      rule: secondMatched,
      badges: [
        { label: `分数 ${secondMatched.totalScore ?? secondMatched.score ?? 0}`, tone: "medium" },
        { label: `置信度 ${secondMatched.confidence_default ?? "low"}`, tone: secondMatched.confidence_default ?? "low" },
        { label: `场景 ${state.selectedContext}`, tone: "low" }
      ],
      supportTitle: "命中词",
      supportCopy: secondMatched.hitWords?.slice(0, 8).join("、") || "无"
    });
  }

  nearMisses.forEach((candidate) => {
    if (pages.length >= 2) {
      return;
    }

    pushPage({
      sourceLabel: "接近方向",
      introTitle: "这句更像在往这个方向靠近",
      introCopy: "它没有完全命中，但已命中的词和缺失槽位说明这是一个很接近的判断方向。",
      rule: candidate,
      badges: [
        { label: `近失配 ${candidate.partialScore ?? 0}`, tone: "medium" },
        { label: `置信度 ${candidate.confidence_default ?? "low"}`, tone: candidate.confidence_default ?? "low" },
        { label: `场景 ${state.selectedContext}`, tone: "low" }
      ],
      supportTitle: "接近方向",
      supportCopy:
        candidate.missingRequiredCount > 0
          ? `还差：${candidate.missingRequiredCount} 个关键槽位`
          : candidate.name
    });
  });

  if (!pages.length) {
    pushPage({
      sourceLabel: "暂未稳定命中",
      introTitle: "这句话当前没有足够稳定的分析",
      introCopy: "可以再补一点上下文，或者继续完善规则后再看。",
      rule: fallbackRule,
      badges: [{ label: `场景 ${state.selectedContext}`, tone: "low" }],
      supportTitle: "继续判断",
      supportCopy: "看看它是不是在要求你更顺从、缩小自己、放弃发展，或者把责任更多推回女性身上。"
    });
  }

  return pages.slice(0, 2);
}

function renderContextButtons() {
  refs.contextButtons.innerHTML = (contextOptions ?? [])
    .map((context) => {
      const activeClass = context === state.selectedContext ? " is-active" : "";
      return `<button type="button" class="chip-button${activeClass}" data-context="${escapeHtml(context)}">${escapeHtml(context)}</button>`;
    })
    .join("");

  refs.contextButtons.querySelectorAll("[data-context]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedContext = button.dataset.context;
      state.resultPageIndex = 0;
      renderContextButtons();
      renderAnalysis();
      renderBatchAndHints();
    });
  });
}

function renderExamples() {
  refs.exampleList.innerHTML = (examples ?? [])
    .map((example) => `<button type="button" class="chip-button is-example" data-example="${escapeHtml(example)}">${escapeHtml(example)}</button>`)
    .join("");

  refs.exampleList.querySelectorAll("[data-example]").forEach((button) => {
    button.addEventListener("click", () => {
      setInput(button.dataset.example);
      refs.inputText.focus();
    });
  });
}

function renderLibraryMetrics() {
  const metricItems = [
    { value: rules.length - 1, label: "规则数" },
    { value: contextOptions.length - 1, label: "场景数" },
    { value: Object.keys(slotBlueprints ?? {}).length, label: "槽位规则" },
    { value: Object.keys(aliasMap ?? {}).length, label: "Alias 键数" }
  ];

  refs.libraryMetrics.innerHTML = metricItems.map((item) => `
    <div class="metric-card">
      <div class="metric-value">${escapeHtml(item.value)}</div>
      <div class="metric-label">${escapeHtml(item.label)}</div>
    </div>
  `).join("");
}

function renderAnalysis() {
  refs.contextStatus.textContent = `当前场景：${state.selectedContext}`;

  if (!state.input.trim()) {
    refs.analysisRoot.innerHTML = `
      <div class="empty-state">
        先输入一句话。<br />
        这里会按分板块展示主规则、槽位命中、候选规则和补词线索。
      </div>
    `;
    return;
  }

  const analysis = analyzeText(state.input, state.selectedContext);
  const result = analysis?.primary ?? fallbackRule;
  const topMatches = analysis?.topMatches ?? [fallbackRule];
  const nearMisses = getNearMisses(state.input, state.selectedContext);
  const useSemanticAssist = shouldUseSemanticAssist(analysis);

  if (useSemanticAssist) {
    requestSemanticAssist(state.input, state.selectedContext);
  } else if (state.semanticAssist.status !== "idle") {
    resetSemanticAssist();
  }

  const pages = buildAnalysisPages(analysis);
  const currentIndex = Math.min(state.resultPageIndex, Math.max(pages.length - 1, 0));
  state.resultPageIndex = currentIndex;
  const currentPage = pages[currentIndex] ?? pages[0];
  const currentRule = currentPage?.rule ?? result;

  refs.analysisRoot.innerHTML = `
    ${
      pages.length > 1
        ? `
          <div class="result-tabs">
            ${pages.map((item, index) => `
              <button
                type="button"
                class="result-tab${index === currentIndex ? " is-active" : ""}"
                data-result-page="${index}"
              >
                <span>${escapeHtml(index === 0 ? "分析 1" : "分析 2")}</span>
                <span class="result-tab-meta">${escapeHtml(item.sourceLabel)}</span>
              </button>
            `).join("")}
          </div>
        `
        : ""
    }

    <div class="analysis-hero">
      <div>
        <div class="eyebrow">${escapeHtml(currentPage?.sourceLabel ?? "Primary Match")}</div>
        <h3 class="result-name">${escapeHtml(currentRule.name ?? "未命中")}</h3>
        <div class="info-copy">${escapeHtml(currentPage?.introCopy ?? "这里展示当前最值得优先看的分析方向。")}</div>
        <div class="badge-row">${getBadges(currentPage?.badges ?? [])}</div>
      </div>
      <div class="score-tile">
        <div class="score-label">${escapeHtml(currentPage?.sourceLabel ?? "Score")}</div>
        <div class="score-value">${escapeHtml(currentRule.totalScore ?? currentRule.score ?? currentRule.partialScore ?? 0)}</div>
      </div>
    </div>

    <div class="analysis-grid">
      <div class="info-card">
        <h3 class="info-title">标签</h3>
        <div class="meta-list">
          ${(currentRule.labels ?? []).map((label) => `<span class="hit-chip">${escapeHtml(label)}</span>`).join("") || `<span class="muted-inline">无</span>`}
        </div>
      </div>

      <div class="info-card">
        <h3 class="info-title">${escapeHtml(currentPage?.supportTitle ?? "命中词")}</h3>
        <div class="meta-list">
          ${
            currentRule.hitWords?.length
              ? currentRule.hitWords.map((word) => `<span class="hit-chip">${escapeHtml(word)}</span>`).join("")
              : `<span class="muted-inline">${escapeHtml(currentPage?.supportCopy ?? "无")}</span>`
          }
        </div>
      </div>

      <div class="info-card">
        <h3 class="info-title">表层意思</h3>
        <div class="info-copy">${escapeHtml(currentRule.surface_meaning_template ?? "")}</div>
      </div>

      <div class="info-card">
        <h3 class="info-title">隐含结构</h3>
        <div class="info-copy">${escapeHtml(currentRule.hidden_structure_template ?? "")}</div>
      </div>

      <div class="info-card">
        <h3 class="info-title">可能影响</h3>
        <div class="info-copy">${escapeHtml(currentRule.impact_template ?? "")}</div>
      </div>

      <div class="info-card">
        <h3 class="info-title">回应方式</h3>
        <div class="response-list">
          <div class="response-item"><span class="response-label">温和版</span>${escapeHtml(currentRule.gentle_response ?? "")}</div>
          <div class="response-item"><span class="response-label">边界版</span>${escapeHtml(currentRule.boundary_response ?? "")}</div>
          <div class="response-item"><span class="response-label">反问版</span>${escapeHtml(currentRule.question_response ?? "")}</div>
        </div>
      </div>

      <div class="info-card span-2">
        <h3 class="info-title">槽位命中</h3>
        <div class="slot-list">
          ${
            (currentRule.slotHits ?? []).length
              ? (currentRule.slotHits ?? []).map((slot) => {
            const isHit = slot.matches.length > 0;
            return `
              <div class="slot-row ${isHit ? "is-hit" : "is-miss"}">
                <div class="slot-state ${isHit ? "is-hit" : "is-miss"}">${isHit ? "命中" : "缺失"}</div>
                <div class="slot-title">${escapeHtml(slot.slotId)} · ${escapeHtml(slot.label || "未命名槽位")}</div>
                <div class="slot-copy">要求：${slot.required ? "必选" : "可选"} · 权重：${escapeHtml(slot.weight)}</div>
                <div class="slot-trace">
                  ${escapeHtml(slot.matches.map((item) => `${item.keyword}（${getModeLabel(item.mode)}）`).join("、") || "未命中")}
                </div>
              </div>
            `;
          }).join("")
              : `<div class="helper-note is-muted">这一页主要来自${escapeHtml(currentPage?.sourceLabel ?? "辅助分析")}，当前没有稳定的槽位命中明细。</div>`
          }
        </div>
      </div>

      <div class="info-card span-2">
        <h3 class="info-title">其他候选规则</h3>
        <div class="candidate-list">
          ${topMatches.map((item, index) => `
            <div class="candidate-card${index === 0 ? " is-primary" : ""}">
              <div class="candidate-top">
                <h4 class="candidate-title">${escapeHtml(index + 1)}. ${escapeHtml(item.name ?? "未命中")}</h4>
                <div class="candidate-score">分数 ${escapeHtml(item.totalScore ?? item.score ?? 0)}</div>
              </div>
              <div class="candidate-meta">
                ${(item.labels ?? []).map((label) => `<span class="hit-chip">${escapeHtml(label)}</span>`).join("") || `<span class="muted-inline">无标签</span>`}
              </div>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="info-card span-2">
        <h3 class="info-title">补词线索</h3>
        ${
          nearMisses.length
            ? `
              <div class="hint-list">
                ${nearMisses.map((item) => {
                  const targetSlot =
                    item.missingRequiredSlots?.[0]
                    ?? item.slotHits?.find((slot) => slot.required && slot.matches.length === 0)
                    ?? item.slotHits?.[0];
                  const candidatePhrases = extractCandidatePhrases(state.input, item.hitWords ?? []);

                  return `
                    <div class="hint-card">
                      <div class="hint-top">
                        <div>
                          <div class="hint-title">${escapeHtml(item.name)}</div>
                          <div class="hint-copy">
                            已命中：${escapeHtml((item.hitWords ?? []).join("、") || "无")} ·
                            还差：${escapeHtml(item.missingRequiredSlots?.map((slot) => slot.label || slot.slotId).join("、") || "无")}
                          </div>
                        </div>
                        <div class="candidate-score">近失配 ${escapeHtml(item.partialScore ?? 0)}</div>
                      </div>
                      <div class="phrase-cloud">
                        ${
                          candidatePhrases.length
                            ? candidatePhrases.map((phrase) => `
                              <button
                                type="button"
                                class="phrase-chip phrase-chip-button"
                                data-add-phrase="${escapeHtml(phrase)}"
                                data-rule-id="${escapeHtml(item.rule_id)}"
                                data-slot-id="${escapeHtml(targetSlot?.slotId ?? "")}"
                              >
                                + ${escapeHtml(phrase)}
                              </button>
                            `).join("")
                            : `<div class="hint-note">这句话更像需要新增规则，而不只是补词。</div>`
                        }
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            `
            : `<div class="helper-note is-muted">这句话已经有比较稳定的规则命中，当前没有明显需要补的词。</div>`
        }
      </div>

      ${renderSemanticStatus(state.input, state.selectedContext)}
    </div>
  `;

  refs.analysisRoot.querySelectorAll("[data-result-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.resultPageIndex = Number(button.dataset.resultPage);
      renderAnalysis();
    });
  });

  refs.analysisRoot.querySelectorAll("[data-add-phrase]").forEach((button) => {
    button.addEventListener("click", () => {
      const rule = rules.find((item) => item.rule_id === button.dataset.ruleId);
      const slot = rule?.slots?.find((item) => item.slotId === button.dataset.slotId);
      if (rule) {
        addDraft(button.dataset.addPhrase, rule, slot);
      }
    });
  });
}

function getBatchStatus(row) {
  if (!row.isFallback) {
    return { label: "命中", cls: "status-hit" };
  }
  if (row.nearMisses.length) {
    return { label: "擦边", cls: "status-near" };
  }
  return { label: "未命中", cls: "status-fallback" };
}

function renderDrafts() {
  refs.draftSummary.textContent = `本地补词 ${state.localDrafts.length} 条`;

  if (!state.localDrafts.length) {
    refs.draftListRoot.innerHTML = `<div class="draft-empty">还没有本地补词。主分析区和 Batch Lab 里的“+词”按钮都会把候选短语加到这里，并立即参与当前页面匹配。</div>`;
    return;
  }

  refs.draftListRoot.innerHTML = state.localDrafts.map((draft) => `
    <div class="draft-card">
      <div class="draft-top">
        <div class="draft-title">${escapeHtml(draft.phrase)}</div>
        <button type="button" class="ghost-button" data-remove-draft="${escapeHtml(draft.id)}">移除</button>
      </div>
      <div class="draft-meta">
        <div>挂到规则：${escapeHtml(draft.ruleName)} (${escapeHtml(draft.ruleId)})</div>
        <div>目标槽位：${escapeHtml(draft.slotId)} · 归并到：${escapeHtml(draft.canonicalWord)}</div>
      </div>
    </div>
  `).join("");

  refs.draftListRoot.querySelectorAll("[data-remove-draft]").forEach((button) => {
    button.addEventListener("click", () => {
      removeDraft(button.dataset.removeDraft);
    });
  });
}

function renderBatchAndHints() {
  const lines = state.batchInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);

  refs.batchCount.textContent = `${lines.length} 句`;

  if (!lines.length) {
    refs.batchSummary.textContent = "等待批量测试";
    refs.batchResultsRoot.innerHTML = `<div class="hint-empty">一行一句，把那些“应该命中但没命中”的句子贴进来，这里会展示命中情况。</div>`;
    refs.keywordHintRoot.innerHTML = `<div class="draft-empty">批量区为空时，这里会展示高频失败模式和可补词方向。</div>`;
    renderDrafts();
    return;
  }

  const rows = lines.map((sentence) => {
    const analysis = analyzeText(sentence, state.selectedContext);
    const primary = analysis?.primary ?? fallbackRule;
    const nearMisses = getNearMisses(sentence, state.selectedContext);
    return {
      sentence,
      primary,
      nearMisses,
      isFallback: primary?.rule_id === fallbackRuleId
    };
  });

  const hitCount = rows.filter((row) => !row.isFallback).length;
  const nearCount = rows.filter((row) => row.isFallback && row.nearMisses.length > 0).length;
  const fallbackCount = rows.length - hitCount - nearCount;

  refs.batchSummary.textContent = `共 ${rows.length} 句 · 命中 ${hitCount} · 擦边 ${nearCount} · 未命中 ${fallbackCount}`;

  refs.batchResultsRoot.innerHTML = rows.map((row, index) => {
    const status = getBatchStatus(row);
    return `
      <div class="batch-card">
        <div class="batch-top">
          <div class="batch-title">${escapeHtml(index + 1)}. ${escapeHtml(row.sentence)}</div>
          <div class="status-chip ${status.cls}">${escapeHtml(status.label)}</div>
        </div>
        <div class="batch-grid-meta">
          <div><strong>规则：</strong>${escapeHtml(row.primary?.name ?? "未命中")} (${escapeHtml(row.primary?.rule_id ?? fallbackRuleId)})</div>
          <div><strong>标签：</strong>${escapeHtml((row.primary?.labels ?? []).join("、") || "无")}</div>
        </div>
        <div class="batch-actions">
          <button type="button" class="ghost-button" data-fill-input="${escapeHtml(row.sentence)}">放到主分析区</button>
        </div>
      </div>
    `;
  }).join("");

  refs.batchResultsRoot.querySelectorAll("[data-fill-input]").forEach((button) => {
    button.addEventListener("click", () => {
      setInput(button.dataset.fillInput);
      refs.inputText.focus();
    });
  });

  const weakRows = rows.filter((row) => row.isFallback || row.nearMisses.length > 0);

  refs.keywordHintRoot.innerHTML = weakRows.length
    ? weakRows.map((row) => {
      const topNear = row.nearMisses[0] ?? null;
      const targetSlot =
        topNear?.missingRequiredSlots?.[0]
        ?? topNear?.slotHits?.find((slot) => slot.required && slot.matches.length === 0)
        ?? topNear?.slotHits?.[0];
      const candidatePhrases = extractCandidatePhrases(row.sentence, topNear?.hitWords ?? []);

      return `
        <div class="hint-card">
          <div class="hint-top">
            <div>
              <div class="hint-title">${escapeHtml(row.sentence)}</div>
              <div class="hint-copy">当前结果：${escapeHtml(row.primary?.name ?? "未命中")}</div>
            </div>
            <div class="candidate-score">${topNear ? `近失配 ${escapeHtml(topNear.partialScore)}` : "更像新规则"}</div>
          </div>
          ${
            topNear
              ? `
                <div class="missing-list">
                  ${(topNear.missingRequiredSlots ?? []).map((slot) => `<span class="missing-chip">${escapeHtml(slot.label || slot.slotId)}</span>`).join("")}
                </div>
                <div class="phrase-cloud">
                  ${
                    candidatePhrases.length
                      ? candidatePhrases.map((phrase) => `
                        <button
                          type="button"
                          class="phrase-chip phrase-chip-button"
                          data-add-phrase="${escapeHtml(phrase)}"
                          data-rule-id="${escapeHtml(topNear.rule_id)}"
                          data-slot-id="${escapeHtml(targetSlot?.slotId ?? "")}"
                        >
                          + ${escapeHtml(phrase)}
                        </button>
                      `).join("")
                      : `<div class="hint-note">这句更像需要新增规则，而不只是补 alias。</div>`
                  }
                </div>
              `
              : `<div class="hint-note">当前没有明显接近规则，更像需要新增规则或新增一组槽位。</div>`
          }
        </div>
      `;
    }).join("")
    : `<div class="draft-empty">当前这批句子都能被规则接住，继续扩大样本就好。</div>`;

  refs.keywordHintRoot.querySelectorAll("[data-add-phrase]").forEach((button) => {
    button.addEventListener("click", () => {
      const rule = rules.find((item) => item.rule_id === button.dataset.ruleId);
      const slot = rule?.slots?.find((item) => item.slotId === button.dataset.slotId);
      if (rule) {
        addDraft(button.dataset.addPhrase, rule, slot);
      }
    });
  });

  renderDrafts();
}

function updateCharCount() {
  refs.charCount.textContent = `${state.input.length} 字`;
}

function updateSimilarityValue() {
  refs.similarityValue.textContent = formatPercent(state.similarityThreshold);
  refs.similarityRange.value = String(state.similarityThreshold);
}

function setInput(value) {
  state.input = value;
  state.resultPageIndex = 0;
  refs.inputText.value = value;
  updateCharCount();
  renderAnalysis();
}

function setBatchInput(value) {
  state.batchInput = value;
  refs.batchInputText.value = value;
  renderBatchAndHints();
}

function bindEvents() {
  refs.inputText.addEventListener("input", (event) => {
    state.input = event.target.value;
    state.resultPageIndex = 0;
    updateCharCount();
    renderAnalysis();
  });

  refs.clearButton.addEventListener("click", () => {
    setInput("");
    refs.inputText.focus();
  });

  refs.similarityRange.addEventListener("input", (event) => {
    state.similarityThreshold = Number(event.target.value);
    updateSimilarityValue();
    renderAnalysis();
    renderBatchAndHints();
  });

  refs.batchInputText.addEventListener("input", (event) => {
    state.batchInput = event.target.value;
    renderBatchAndHints();
  });

  refs.batchClearButton.addEventListener("click", () => {
    setBatchInput("");
    refs.batchInputText.focus();
  });

  refs.clearDraftsButton.addEventListener("click", () => {
    state.localDrafts = [];
    saveLocalDrafts();
    setRulesFileStatus("已清空本地补词。", state.rulesFileHandle ? "connected" : "muted");
    renderAnalysis();
    renderBatchAndHints();
  });

  refs.exportDraftsButton.addEventListener("click", () => {
    exportDrafts();
    setRulesFileStatus("已导出本地补词草稿。", state.rulesFileHandle ? "connected" : "muted");
  });

  refs.connectRulesButton.addEventListener("click", async () => {
    await connectRulesFile();
  });

  refs.writeRulesButton.addEventListener("click", async () => {
    await writeDraftsToRulesFile();
  });
}

function init() {
  renderContextButtons();
  renderExamples();
  renderLibraryMetrics();
  bindEvents();
  updateSimilarityValue();
  setRulesFileStatus("主分析区和补词功能已恢复。补词先加到本地草稿里，当前页会立刻重新匹配；连接 rules.js 后可以直接写回 aliasMap。");
  setInput(state.input);
  setBatchInput(state.batchInput);
}

init();
