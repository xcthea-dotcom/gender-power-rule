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
const semanticEndpoint = "/api/semantic-assist";
const semanticTimeoutMs = 12000;
const weakNearMissWords = new Set([
  "太", "很", "了", "吧", "吗", "呢",
  "要", "该", "得", "应该", "还是要",
  "别", "不要", "不能",
  "就", "就是", "本来", "本来就", "都", "又", "更",
  "这么", "那么", "这样", "那样",
  "一个", "一下", "一点"
]);

const state = {
  input: examples?.[0] ?? "",
  selectedContext: contextOptions?.[0] ?? "不限",
  resultPageIndex: 0,
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
    .replace(/[！!]/g, "!")
    .replace(/[？?]/g, "?")
    .replace(/[，,]/g, ",")
    .replace(/[。．.]/g, ".")
    .replace(/[；;]/g, ";")
    .replace(/[：:]/g, ":")
    .replace(/[“”"'`]/g, "")
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
      normalizedText.includes(normalizedWord) ||
      getAliases(word).some((alias) => normalizedText.includes(normalize(alias)))
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
    slotHits,
    hitWords: Array.from(new Set(hitWords)),
    matchedSlotCount,
    weightedSlotScore,
    missingRequiredCount,
    score: hitWords.length + matchedSlotCount + weightedSlotScore
  };
}

function getNearMissSignals(partial) {
  const slotHits = partial?.slotHits ?? [];
  let matchedRequiredSlotCount = 0;
  let meaningfulSlotCount = 0;
  let meaningfulWeightScore = 0;

  slotHits.forEach((slot) => {
    if (!slot.matches?.length) {
      return;
    }

    if (slot.required) {
      matchedRequiredSlotCount += 1;
    }

    const hasMeaningfulMatch = slot.matches.some((match) => {
      const word = String(match.keyword ?? "").trim();
      return word.length >= 2 && !weakNearMissWords.has(word);
    });

    if (hasMeaningfulMatch) {
      meaningfulSlotCount += 1;
      meaningfulWeightScore += slot.weight ?? 1;
    }
  });

  return {
    matchedRequiredSlotCount,
    meaningfulSlotCount,
    meaningfulWeightScore
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
      error: "当前是本地 file 页面，服务端语义辅助只有部署后才可用。"
    };
    return;
  }

  window.clearTimeout(state.semanticAssistTimer);
  state.semanticAssistTimer = window.setTimeout(() => {
    Promise.race([
      fetch(semanticEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
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
              ? "语义辅助超时，已自动跳过。"
              : error?.message || "语义辅助暂时不可用。"
        };
        renderResult();
      });
  }, 400);
}

function resolveSemanticRule(result) {
  if (!result) {
    return null;
  }

  const matchedRule =
    (result.rule_id ? rules.find((rule) => rule.rule_id === result.rule_id) : null) ||
    (result.name ? rules.find((rule) => rule.name === result.name) : null);

  if (!matchedRule) {
    return null;
  }

  return {
    ...matchedRule,
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
      const resolved = resolveSemanticRule(item);
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
      const partial = matchRule(text, rule, true);
      if (!partial || partial.matchedSlotCount === 0) {
        return null;
      }

      const supportedContexts = ruleContextMap?.[rule.rule_id] ?? [];
      const contextBoost =
        selectedContext && selectedContext !== "不限" && supportedContexts.includes(selectedContext)
          ? 2
          : 0;
      const signals = getNearMissSignals(partial);

      return {
        ...partial,
        ...signals,
        partialScore:
          signals.matchedRequiredSlotCount * 3 +
          signals.meaningfulSlotCount * 2 +
          signals.meaningfulWeightScore -
          partial.missingRequiredCount +
          contextBoost
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.partialScore - a.partialScore)
    .slice(0, 2);
}

function getBadges(items = []) {
  return items
    .filter(Boolean)
    .map((item) => {
      const toneClass =
        item.tone === "medium" ? " medium" :
        item.tone === "low" ? " low" :
        item.tone === "high" ? " high" :
        "";
      return `<span class="badge${toneClass}">${escapeHtml(item.label)}</span>`;
    })
    .join("");
}

function renderSemanticHint() {
  if (state.semanticAssist.status === "idle") {
    return "";
  }

  if (state.semanticAssist.status === "loading") {
    return `
      <div class="hint-block">
        <strong>语义辅助</strong>
        正在补充另一种可能的分析方向。
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
        { label: result.confidence_default ?? "low" },
        { label: result.severity_default ?? "low" },
        { label: state.selectedContext, tone: "low" }
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
        { label: candidate.confidence_default ?? "low" },
        { label: state.selectedContext, tone: "low" }
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
        { label: secondMatched.confidence_default ?? "low" },
        { label: state.selectedContext, tone: "low" }
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
        { label: candidate.confidence_default ?? "low" },
        { label: state.selectedContext, tone: "low" }
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
      badges: [{ label: state.selectedContext, tone: "low" }],
      supportTitle: "继续判断",
      supportCopy: "看看它是不是在要求你更顺从、缩小自己、放弃发展，或者把责任更多推回女性身上。"
    });
  }

  return pages.slice(0, 2);
}

function renderNearMissSupport(text, selectedContext, currentRuleId) {
  const nearMisses = getNearMisses(text, selectedContext)
    .filter((item) => item.rule_id !== currentRuleId)
    .slice(0, 1);

  if (!nearMisses.length) {
    return "";
  }

  const item = nearMisses[0];
  const supportCopy =
    item.missingRequiredCount > 0
      ? `接近方向：${item.name}。还差 ${item.missingRequiredCount} 个关键槽位。`
      : `接近方向：${item.name}。`;

  return `
    <div class="hint-block">
      <strong>接近方向</strong>
      ${escapeHtml(supportCopy)}
    </div>
  `;
}

function renderResultCard(page, pages) {
  const currentIndex = Math.min(state.resultPageIndex, Math.max(pages.length - 1, 0));
  state.resultPageIndex = currentIndex;
  const rule = page.rule ?? fallbackRule;

  refs.resultRoot.innerHTML = `
    <div class="result-card">
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

      <div class="result-hero">
        <div class="panel-kicker">${escapeHtml(page.sourceLabel)}</div>
        <h2 class="result-title">${escapeHtml(rule.name ?? fallbackRule.name)}</h2>
        <p class="result-copy">${escapeHtml(rule.surface_meaning_template ?? fallbackRule.surface_meaning_template)}</p>
        <div class="badge-row">${getBadges(page.badges)}</div>
      </div>

      <div class="hint-block">
        <strong>${escapeHtml(page.introTitle)}</strong>
        ${escapeHtml(page.introCopy)}
      </div>

      <div class="result-grid">
        <div class="info-panel">
          <div class="info-title">隐含结构</div>
          <div class="panel-copy">${escapeHtml(rule.hidden_structure_template ?? fallbackRule.hidden_structure_template)}</div>
        </div>

        <div class="info-panel">
          <div class="info-title">可能影响</div>
          <div class="panel-copy">${escapeHtml(rule.impact_template ?? fallbackRule.impact_template)}</div>
        </div>
      </div>

      <div class="result-grid">
        <div class="info-panel">
          <div class="info-title">你可以这样回</div>
          <div class="panel-copy"><strong>温和版：</strong>${escapeHtml(rule.gentle_response ?? fallbackRule.gentle_response ?? "")}</div>
          <div class="panel-copy"><strong>边界版：</strong>${escapeHtml(rule.boundary_response ?? fallbackRule.boundary_response ?? "")}</div>
          <div class="panel-copy"><strong>反问版：</strong>${escapeHtml(rule.question_response ?? fallbackRule.question_response ?? "")}</div>
        </div>

        <div class="info-panel">
          <div class="info-title">${escapeHtml(page.supportTitle)}</div>
          <div class="panel-copy">${escapeHtml(page.supportCopy)}</div>
        </div>
      </div>

      ${page.sourceLabel === "语义接近" ? renderNearMissSupport(state.input, state.selectedContext, rule.rule_id) : ""}
      ${renderSemanticHint()}
    </div>
  `;

  refs.resultRoot.querySelectorAll("[data-result-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.resultPageIndex = Number(button.dataset.resultPage);
      renderResult();
    });
  });
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
      state.resultPageIndex = 0;
      refs.contextStatus.textContent = `当前场景：${state.selectedContext}`;
      renderContextButtons();
      renderResult();
    });
  });
}

function renderExamples() {
  refs.exampleList.innerHTML = (examples ?? [])
    .map((example) => `<button type="button" class="example-pill" data-example="${escapeHtml(example)}">${escapeHtml(example)}</button>`)
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
        <p class="result-copy">这里会先给你最优先的分析，如果还有第二种接近的解释，也会用翻页给你展开。</p>
      </div>
    </div>
  `;
}

function renderResult() {
  if (!state.input.trim()) {
    renderEmptyState();
    return;
  }

  const analysis = analyzeText(state.input, state.selectedContext);

  if (shouldUseSemanticAssist(analysis)) {
    requestSemanticAssist(state.input, state.selectedContext);
  } else if (state.semanticAssist.status !== "idle") {
    resetSemanticAssist();
  }

  const pages = buildAnalysisPages(analysis);
  renderResultCard(pages[state.resultPageIndex] ?? pages[0], pages);
}

function updateCharCount() {
  refs.charCount.textContent = `${state.input.length} 字`;
}

function setInput(value) {
  state.input = value;
  state.resultPageIndex = 0;
  refs.userInput.value = value;
  updateCharCount();
}

function bindEvents() {
  refs.userInput.addEventListener("input", (event) => {
    state.input = event.target.value;
    state.resultPageIndex = 0;
    updateCharCount();
  });

  refs.analyzeButton.addEventListener("click", () => {
    renderResult();
  });

  refs.clearButton.addEventListener("click", () => {
    setInput("");
    resetSemanticAssist();
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
