const {
  rulesBase,
  contextOptions,
  ruleContextMap,
  examples,
  slotBlueprints,
  slotConfigMap,
  aliasMap
} = window.ruleDemoData;

const severityRank = { low: 1, medium: 2, high: 3 };
const confidenceRank = { low: 1, medium: 2, high: 3 };
const fallbackRuleId = "R030";
const SEMANTIC_TIMEOUT_MS = 12000;
const SEMANTIC_ENDPOINT = "/api/semantic-assist";

const state = {
  input: examples?.[0] ?? "",
  selectedContext: "不限",
  semanticAssist: {
    key: "",
    status: "idle",
    results: [],
    error: ""
  },
  semanticAssistTimer: null
};

const refs = {
  userInput: document.getElementById("userInput"),
  charCount: document.getElementById("charCount"),
  analyzeButton: document.getElementById("analyzeButton"),
  clearButton: document.getElementById("clearButton"),
  contextButtons: document.getElementById("contextButtons"),
  contextStatus: document.getElementById("contextStatus"),
  exampleList: document.getElementById("exampleList"),
  resultRoot: document.getElementById("resultRoot")
};

function buildSlots(parts = [], options = {}) {
  const requiredIndexes = options.requiredIndexes ?? parts.map((_, index) => index);
  const weightMap = options.weightMap ?? {};

  return parts.map((keywords, index) => ({
    slotId: `S${index + 1}`,
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
    .replace(/[！]/g, "!")
    .replace(/[？]/g, "?")
    .replace(/[，]/g, ",")
    .replace(/[。]/g, ".")
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

function getAliases(keyword) {
  return aliasMap[keyword] ?? aliasMap[normalize(keyword)] ?? [];
}

function getSemanticAssistKey(text, context) {
  return `${context}::${String(text ?? "").trim()}`;
}

function buildLegacySlots(rule) {
  return [
    {
      slotId: "legacy-1",
      matchAny: rule.must_include_any ?? [],
      required: (rule.must_include_any ?? []).length > 0,
      weight: (rule.must_include_any ?? []).length > 0 ? 2 : 1
    },
    {
      slotId: "legacy-2",
      matchAny: rule.must_include_any_2 ?? [],
      required: (rule.must_include_any_2 ?? []).length > 0,
      weight: (rule.must_include_any_2 ?? []).length > 0 ? 2 : 1
    }
  ].filter((slot) => slot.required || slot.matchAny.length > 0);
}

function findKeywordMatch(normalizedText, keyword) {
  const normalizedKeyword = normalize(keyword);

  if (!normalizedKeyword) {
    return null;
  }

  if (normalizedText.includes(normalizedKeyword)) {
    return { keyword, mode: "exact" };
  }

  const aliases = getAliases(keyword);
  const matchedAlias = aliases.find((alias) => normalizedText.includes(normalize(alias)));

  if (matchedAlias) {
    return { keyword: matchedAlias, mode: "alias" };
  }

  if (normalizedKeyword.length >= 6) {
    const parts = normalizedKeyword.match(/.{1,2}/g) ?? [];
    const longParts = parts.filter((part) => part.length >= 2);
    if (longParts.length >= 3 && longParts.every((part) => normalizedText.includes(part))) {
      return { keyword, mode: "fragment" };
    }
  }

  return null;
}

function matchRule(text, rule, allowPartial = false) {
  const normalizedText = normalize(text);

  if ((rule.exclude_any ?? []).some((word) => {
    const normalizedWord = normalize(word);
    return normalizedWord && (
      normalizedText.includes(normalizedWord)
      || getAliases(word).some((alias) => normalizedText.includes(normalize(alias)))
    );
  })) {
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
    hitWords: Array.from(new Set(hitWords)),
    matchedSlotCount,
    weightedSlotScore,
    missingRequiredCount,
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

  if (
    state.semanticAssist.key === key
    && (
      state.semanticAssist.status === "loading"
      || state.semanticAssist.status === "ready"
      || state.semanticAssist.status === "error"
    )
  ) {
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
      error: "当前是本地 file 页面，服务端语义辅助只有部署后才能用"
    };
    return;
  }

  window.clearTimeout(state.semanticAssistTimer);
  state.semanticAssistTimer = window.setTimeout(() => {
    Promise.race([
      fetch(SEMANTIC_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          context: selectedContext,
          topK: 2
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
        window.setTimeout(() => reject(new Error("semantic timeout")), SEMANTIC_TIMEOUT_MS);
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
        renderResult();
      })
      .catch((error) => {
        if (state.semanticAssist.key !== key) {
          return;
        }

        state.semanticAssist = {
          key,
          status: "error",
          results: [],
          error:
            error?.message === "semantic timeout"
              ? "语义辅助超时，已自动跳过"
              : error?.message || "语义辅助暂不可用"
        };
        renderResult();
      });
  }, 450);
}

function renderSemanticAssist(text, selectedContext) {
  const key = getSemanticAssistKey(text, selectedContext);

  if (state.semanticAssist.key !== key || state.semanticAssist.status === "idle") {
    return "";
  }

  if (state.semanticAssist.status === "loading") {
    return `
      <div class="hint-block">
        <strong>语义辅助</strong>
        正在请求服务端语义辅助。这不是进度条；如果 12 秒内没结果，会自动跳过。
      </div>
    `;
  }

  if (state.semanticAssist.status === "error") {
    return `
      <div class="hint-block">
        <strong>语义辅助</strong>
        ${escapeHtml(state.semanticAssist.error)}
      </div>
    `;
  }

  if (!state.semanticAssist.results.length) {
    return `
      <div class="hint-block">
        <strong>语义辅助</strong>
        没有找到更接近的规则，当前仍以规则命中结果为准。
      </div>
    `;
  }

  return `
    <div class="hint-block">
      <strong>语义上最接近的方向</strong>
      <div class="mt-2">${state.semanticAssist.results.map((item) => `${escapeHtml(item.name)} (${formatPercent(item.semanticSimilarity)})`).join("、")}</div>
    </div>
  `;
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function resolveSemanticRule(result) {
  if (!result) {
    return null;
  }

  const matchedRule =
    (result.rule_id ? rules.find((rule) => rule.rule_id === result.rule_id) : null)
    || (result.name ? rules.find((rule) => rule.name === result.name) : null);

  if (!matchedRule) {
    return result;
  }

  return {
    ...matchedRule,
    ...result,
    rule_id: result.rule_id ?? matchedRule.rule_id,
    name: result.name ?? matchedRule.name,
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

function getSemanticPrimary(text, selectedContext) {
  const key = getSemanticAssistKey(text, selectedContext);

  if (state.semanticAssist.key !== key || state.semanticAssist.status !== "ready") {
    return null;
  }

  if (!state.semanticAssist.results.length) {
    return null;
  }

  const primary = resolveSemanticRule(state.semanticAssist.results[0]);

  if (!primary) {
    return null;
  }

  return {
    ...primary,
    semanticSource: true,
    semanticSimilarity: Number(primary.semanticSimilarity || 0)
  };
}

function renderSemanticFallback(semanticPrimary, nearMisses = []) {
  refs.resultRoot.innerHTML = `
    <div class="result-card">
      <div class="result-hero">
        <div class="panel-kicker">语义近似匹配</div>
        <h2 class="result-title">${escapeHtml(semanticPrimary.name ?? fallbackRule.name)}</h2>
        <p class="result-copy">${escapeHtml(semanticPrimary.surface_meaning_template ?? fallbackRule.surface_meaning_template)}</p>
        <div class="badge-row">
          <span class="badge medium">近似度 ${formatPercent(semanticPrimary.semanticSimilarity)}</span>
          <span class="badge">${escapeHtml(semanticPrimary.confidence_default ?? "medium")}</span>
          <span class="badge low">${escapeHtml(state.selectedContext)}</span>
        </div>
      </div>

      <div class="hint-block">
        <strong>说明</strong>
        这句话没有精确命中现有规则，以下分析基于最接近的语义规则生成，适合作为参考而不是最终定论。
      </div>

      <div class="result-grid">
        <div class="info-panel">
          <div class="info-title">隐含结构</div>
          <div class="panel-copy">${escapeHtml(semanticPrimary.hidden_structure_template ?? fallbackRule.hidden_structure_template)}</div>
        </div>

        <div class="info-panel">
          <div class="info-title">可能影响</div>
          <div class="panel-copy">${escapeHtml(semanticPrimary.impact_template ?? fallbackRule.impact_template)}</div>
        </div>
      </div>

      <div class="result-grid">
        <div class="info-panel">
          <div class="info-title">你可以这样回</div>
          <div class="panel-copy"><strong>温和版：</strong>${escapeHtml(semanticPrimary.gentle_response ?? fallbackRule.gentle_response ?? "")}</div>
          <div class="panel-copy"><strong>边界版：</strong>${escapeHtml(semanticPrimary.boundary_response ?? fallbackRule.boundary_response ?? "")}</div>
          <div class="panel-copy"><strong>反问版：</strong>${escapeHtml(semanticPrimary.question_response ?? fallbackRule.question_response ?? "")}</div>
        </div>

        <div class="info-panel">
          <div class="info-title">接近的方向</div>
          <div class="panel-copy">${escapeHtml(nearMisses.map((item) => item.name).join("、") || semanticPrimary.name || "暂无")}</div>
        </div>
      </div>
    </div>
  `;
}

function getNearMisses(text, selectedContext) {
  if (!String(text ?? "").trim()) {
    return [];
  }

  return rules
    .filter((rule) => rule.rule_id !== fallbackRuleId)
    .map((rule) => {
      const partial = matchRule(text, rule, true);
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
    .slice(0, 2);
}

function renderContextButtons() {
  refs.contextButtons.innerHTML = contextOptions
    .map((context) => {
      const activeClass = context === state.selectedContext ? " is-active" : "";
      return `<button type="button" class="context-chip${activeClass}" data-context="${escapeHtml(context)}">${escapeHtml(context)}</button>`;
    })
    .join("");

  refs.contextButtons.querySelectorAll("[data-context]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedContext = button.dataset.context;
      refs.contextStatus.textContent = `当前场景：${state.selectedContext}`;
      renderContextButtons();
      renderResult();
    });
  });
}

function renderExamples() {
  refs.exampleList.innerHTML = (examples ?? [])
    .map((example) => {
      return `<button type="button" class="example-pill" data-example="${escapeHtml(example)}">${escapeHtml(example)}</button>`;
    })
    .join("");

  refs.exampleList.querySelectorAll("[data-example]").forEach((button) => {
    button.addEventListener("click", () => {
      setInput(button.dataset.example);
      renderResult();
      refs.userInput.focus();
    });
  });
}

function renderEmptyState() {
  refs.resultRoot.innerHTML = `
    <div class="result-card">
      <div class="result-hero">
        <div class="panel-kicker">Ready</div>
        <h2 class="result-title">先放一句话进来</h2>
        <p class="result-copy">这里会给你一个保守但清晰的解释，再附上可回应的说法。</p>
      </div>
    </div>
  `;
}

function renderFallback(analysis) {
  const nearMisses = getNearMisses(state.input, state.selectedContext);
  const useSemanticAssist = shouldUseSemanticAssist(analysis);

  if (useSemanticAssist) {
    requestSemanticAssist(state.input, state.selectedContext);
  }

  const semanticPrimary = getSemanticPrimary(state.input, state.selectedContext);
  if (semanticPrimary) {
    renderSemanticFallback(semanticPrimary, nearMisses);
    return;
  }

  refs.resultRoot.innerHTML = `
    <div class="result-card">
      <div class="result-hero">
        <div class="panel-kicker">暂未稳命中</div>
        <h2 class="result-title">${escapeHtml(analysis?.primary?.name ?? fallbackRule.name)}</h2>
        <p class="result-copy">${escapeHtml(analysis?.primary?.surface_meaning_template ?? fallbackRule.surface_meaning_template)}</p>
      </div>

      <div class="result-grid">
        <div class="info-panel">
          <div class="info-title">这意味着什么</div>
          <div class="panel-copy">${escapeHtml(analysis?.primary?.hidden_structure_template ?? fallbackRule.hidden_structure_template)}</div>
        </div>

        <div class="info-panel">
          <div class="info-title">可以怎么继续判断</div>
          <div class="panel-copy">看看它是不是在要求你更顺从、缩小自己、放弃发展，或者把责任更多推回女性身上。</div>
        </div>
      </div>

      <div class="hint-block">
        <strong>最接近的方向</strong>
        <div class="mt-2">${nearMisses.map((item) => escapeHtml(item.name)).join("、") || "暂无"}</div>
      </div>

      ${useSemanticAssist ? renderSemanticAssist(state.input, state.selectedContext) : ""}
    </div>
  `;
}

function renderResult() {
  if (!state.input.trim()) {
    renderEmptyState();
    return;
  }

  const analysis = analyzeText(state.input, state.selectedContext);
  const result = analysis?.primary ?? fallbackRule;
  const useSemanticAssist = shouldUseSemanticAssist(analysis);

  if (result.rule_id === fallbackRuleId) {
    renderFallback(analysis);
    return;
  }

  if (useSemanticAssist) {
    requestSemanticAssist(state.input, state.selectedContext);
  } else if (state.semanticAssist.status !== "idle") {
    resetSemanticAssist();
  }

  refs.resultRoot.innerHTML = `
    <div class="result-card">
      <div class="result-hero">
        <div class="panel-kicker">Main Match</div>
        <h2 class="result-title">${escapeHtml(result.name)}</h2>
        <p class="result-copy">${escapeHtml(result.surface_meaning_template ?? "")}</p>
        <div class="badge-row">
          <span class="badge">${escapeHtml(result.confidence_default ?? "low")}</span>
          <span class="badge">${escapeHtml(result.severity_default ?? "low")}</span>
          <span class="badge low">${escapeHtml(state.selectedContext)}</span>
        </div>
      </div>

      <div class="result-grid">
        <div class="info-panel">
          <div class="info-title">隐含结构</div>
          <div class="panel-copy">${escapeHtml(result.hidden_structure_template ?? "")}</div>
        </div>

        <div class="info-panel">
          <div class="info-title">可能影响</div>
          <div class="panel-copy">${escapeHtml(result.impact_template ?? "")}</div>
        </div>
      </div>

      <div class="result-grid">
        <div class="info-panel">
          <div class="info-title">你可以这样回</div>
          <div class="panel-copy"><strong>温和版：</strong>${escapeHtml(result.gentle_response ?? "")}</div>
          <div class="panel-copy"><strong>边界版：</strong>${escapeHtml(result.boundary_response ?? "")}</div>
          <div class="panel-copy"><strong>反问版：</strong>${escapeHtml(result.question_response ?? "")}</div>
        </div>

        <div class="info-panel">
          <div class="info-title">命中词</div>
          <div class="panel-copy">${escapeHtml(result.hitWords?.slice(0, 6).join("、") || "无")}</div>
        </div>
      </div>

      ${useSemanticAssist ? renderSemanticAssist(state.input, state.selectedContext) : ""}
    </div>
  `;
}

function updateCharCount() {
  refs.charCount.textContent = `${state.input.length} 字`;
}

function setInput(value) {
  state.input = value;
  refs.userInput.value = value;
  updateCharCount();
}

function bindEvents() {
  refs.userInput.addEventListener("input", (event) => {
    state.input = event.target.value;
    updateCharCount();
  });

  refs.analyzeButton.addEventListener("click", () => {
    renderResult();
  });

  refs.clearButton.addEventListener("click", () => {
    setInput("");
    renderEmptyState();
    refs.userInput.focus();
  });
}

function init() {
  refs.contextStatus.textContent = `当前场景：${state.selectedContext}`;
  renderContextButtons();
  renderExamples();
  bindEvents();
  setInput(state.input);
  renderResult();
}

init();