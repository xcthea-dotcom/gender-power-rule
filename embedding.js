window.embeddingHelper = (() => {
  const MODEL_NAME = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  const TRANSFORMERS_CDN =
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js";
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

  function getPrototypeText(rule) {
    return [
      rule.name,
      ...(rule.labels ?? []),
      ...(rule.must_include_any ?? []),
      ...(rule.must_include_any_2 ?? []),
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
      runtimePromise = new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          reject(new Error("embedding load timeout"));
        }, RUNTIME_TIMEOUT_MS);

        const resolveWithCleanup = () => {
          window.clearTimeout(timeoutId);
          resolve(window.transformers);
        };

        const rejectWithCleanup = (message) => {
          window.clearTimeout(timeoutId);
          reject(new Error(message));
        };

        const existingScript = document.querySelector(
          'script[data-embedding-runtime="transformers"]'
        );

        if (existingScript) {
          existingScript.addEventListener("load", resolveWithCleanup, { once: true });
          existingScript.addEventListener(
            "error",
            () => rejectWithCleanup("embedding runtime unavailable"),
            { once: true }
          );
          return;
        }

        const script = document.createElement("script");
        script.src = TRANSFORMERS_CDN;
        script.async = true;
        script.dataset.embeddingRuntime = "transformers";
        script.onload = resolveWithCleanup;
        script.onerror = () => rejectWithCleanup("embedding runtime unavailable");
        document.head.appendChild(script);
      });
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
