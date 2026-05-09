window.__embeddingLoaded = true;
console.log("[embedding] loaded");

window.embeddingHelper = (() => {
  const MODEL_NAME = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  const TRANSFORMERS_CDN =
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
  const RUNTIME_TIMEOUT_MS = 10000;

  let runtimePromise = null;
  let extractorPromise = null;
  const vectorCache = new Map();

  function normalize(text) {
    return String(text ?? "")
      .replace(/[\s\u3000]+/g, "")
      .replace(/[！]/g, "!")
      .replace(/[？]/g, "?")
      .replace(/[，]/g, ",")
      .replace(/[。]/g, ".")
      .toLowerCase();
  }

  const semanticPrototypeMap = {
    R035: [
      "女生做高压商务谈判容易被情绪带着走，关键场合还是男生更稳。",
      "女人做决策时更容易情绪化，关键判断不如男性稳定。",
      "涉及拍板和临场判断，女生往往容易被情绪影响。",
      "女性在高压决策场景里不够稳，更容易感情用事。"
    ],
    R037: [
      "她不想生孩子，但女人总要面对现实。",
      "女人最后还是得生孩子，不然人生就不完整。",
      "不生育的女人终究不算完整，总得过生孩子这一关。",
      "女人再怎么想，也还是要回到生育这件事上。"
    ],
    R051: [
      "为了传宗接代，家族资源应该优先流向男性后代。",
      "男性后代才是家族延续的重点，资源当然先给他们。",
      "没有儿子就不算真正有后，家里资源要优先保儿子。",
      "女儿再优秀也不如儿子重要，家族延续还是得靠男性后代。"
    ],
    R058: [
      "女性就像被男性圈养的家禽，只要把你保护好，你就好好听话生育，照顾家庭，让男性泄欲就好。",
      "女人被保护好就行，负责生育、照顾家庭、满足男人。",
      "找女人就是为了照顾生活、伺候家庭、满足男人需要。",
      "女性最重要的是听话、生育、照顾家庭，而不是有自己的主体性。"
    ],
    R060: [
      "这浮舟看上去是何等温婉拥静，孰料亦是个水性杨花的女子。",
      "她表面温婉端庄，实际上却是个水性杨花的女人。",
      "看着贤淑安静，其实私下里很不安分，感情上也不专一。",
      "外表再温柔，也掩不住她花心滥情的一面。"
    ],
    R062: [
      "女生拿到好机会，很多人第一反应就是她是不是靠关系。",
      "一个女人再独立，背后也还是得有个男人撑着。",
      "她能拿到这些资源，多半不是靠能力，而是靠关系。",
      "女人得到机会和资源，别人总怀疑她是靠男人、靠关系、走捷径。"
    ]
  };

  function getPrototypeText(rule) {
    return [
      rule.name,
      ...(rule.labels ?? []),
      ...(rule.must_include_any ?? []),
      ...(rule.must_include_any_2 ?? []),
      ...(semanticPrototypeMap[rule.rule_id] ?? []),
      rule.notes ?? "",
      rule.hidden_structure_template ?? ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  function getBigrams(text) {
    const normalized = normalize(text);
    const grams = new Set();

    if (!normalized) {
      return grams;
    }

    if (normalized.length < 2) {
      grams.add(normalized);
      return grams;
    }

    for (let index = 0; index < normalized.length - 1; index += 1) {
      grams.add(normalized.slice(index, index + 2));
    }

    return grams;
  }

  function getCandidateRules(text, rules, limit = 12) {
    const inputBigrams = getBigrams(text);

    return rules
      .map((rule) => {
        const prototypeText = getPrototypeText(rule);
        const prototypeBigrams = getBigrams(prototypeText);
        let overlap = 0;

        inputBigrams.forEach((gram) => {
          if (prototypeBigrams.has(gram)) {
            overlap += 1;
          }
        });

        return {
          rule,
          prototypeText,
          overlap
        };
      })
      .sort((a, b) => {
        if (b.overlap !== a.overlap) {
          return b.overlap - a.overlap;
        }

        return (b.rule.priority ?? 0) - (a.rule.priority ?? 0);
      })
      .slice(0, limit);
  }

  function ensureRuntime() {
    if (window.transformers?.pipeline) {
      return Promise.resolve(window.transformers);
    }

    if (!runtimePromise) {
      runtimePromise = Promise.race([
        import(TRANSFORMERS_CDN).then((module) => {
          const runtime = module?.env ? module : module?.default;
          if (!runtime?.pipeline) {
            throw new Error("embedding runtime unavailable");
          }
          window.transformers = runtime;
          return runtime;
        }),
        new Promise((_, reject) => {
          window.setTimeout(() => reject(new Error("embedding load timeout")), RUNTIME_TIMEOUT_MS);
        })
      ]);
    }

    return runtimePromise;
  }

  async function getExtractor() {
    await ensureRuntime();

    if (!window.transformers?.pipeline) {
      throw new Error("embedding runtime unavailable");
    }

    if (!extractorPromise) {
      window.transformers.env.allowLocalModels = false;
      window.transformers.env.useBrowserCache = true;
      extractorPromise = window.transformers.pipeline("feature-extraction", MODEL_NAME, {
        quantized: true
      });
    }

    return extractorPromise;
  }

  async function embedText(text) {
    if (vectorCache.has(text)) {
      return vectorCache.get(text);
    }

    const extractor = await getExtractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const vector = Array.from(output.data);
    vectorCache.set(text, vector);
    return vector;
  }

  function cosineSimilarity(vectorA, vectorB) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let index = 0; index < vectorA.length; index += 1) {
      const a = vectorA[index];
      const b = vectorB[index];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }

    if (!normA || !normB) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async function rankTextAgainstRules(text, rules, options = {}) {
    const topK = options.topK ?? 3;
    const threshold = options.threshold ?? 0.42;
    const candidateLimit = options.candidateLimit ?? 12;
    const inputVector = await embedText(text);
    const scored = [];
    const candidateRules = getCandidateRules(text, rules, candidateLimit);

    for (const { rule, prototypeText } of candidateRules) {
      const prototypeVector = await embedText(prototypeText);
      const similarity = cosineSimilarity(inputVector, prototypeVector);

      if (similarity >= threshold) {
        scored.push({
          ...rule,
          semanticSimilarity: similarity
        });
      }
    }

    return scored
      .sort((a, b) => b.semanticSimilarity - a.semanticSimilarity)
      .slice(0, topK);
  }

  return {
    modelName: MODEL_NAME,
    rankTextAgainstRules
  };
})();
