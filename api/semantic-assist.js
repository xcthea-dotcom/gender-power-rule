const fs = require("fs");
const path = require("path");
const vm = require("vm");

let cachedRuleData = null;

function loadRuleData() {
  if (cachedRuleData) {
    return cachedRuleData;
  }

  const source = fs.readFileSync(path.join(process.cwd(), "rules.js"), "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  cachedRuleData = context.window.ruleDemoData;
  return cachedRuleData;
}

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

function scoreRule(text, rule, selectedContext, ruleContextMap) {
  const inputBigrams = getBigrams(text);
  const prototypeText = getPrototypeText(rule);
  const prototypeBigrams = getBigrams(prototypeText);

  let overlap = 0;
  inputBigrams.forEach((gram) => {
    if (prototypeBigrams.has(gram)) {
      overlap += 1;
    }
  });

  const denominator = Math.sqrt(Math.max(inputBigrams.size, 1) * Math.max(prototypeBigrams.size, 1));
  const baseSimilarity = denominator ? overlap / denominator : 0;
  const supportedContexts = ruleContextMap?.[rule.rule_id] ?? [];
  const contextBoost =
    selectedContext && selectedContext !== "不限" && supportedContexts.includes(selectedContext)
      ? 0.06
      : 0;

  return {
    ...rule,
    semanticSimilarity: Math.min(baseSimilarity + contextBoost, 1)
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") {
      resolve(req.body);
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  try {
    const body = await parseBody(req);
    const text = body?.text ?? "";
    const selectedContext = body?.context ?? "不限";
    const topK = Math.max(1, Math.min(Number(body?.topK ?? 3), 5));

    if (!String(text).trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const { rulesBase, ruleContextMap } = loadRuleData();
    const results = rulesBase
      .filter((rule) => rule.rule_id !== "R030")
      .map((rule) => scoreRule(text, rule, selectedContext, ruleContextMap))
      .filter((rule) => rule.semanticSimilarity >= 0.08)
      .sort((a, b) => {
        if (b.semanticSimilarity !== a.semanticSimilarity) {
          return b.semanticSimilarity - a.semanticSimilarity;
        }

        return (b.priority ?? 0) - (a.priority ?? 0);
      })
      .slice(0, topK)
      .map((rule) => ({
        rule_id: rule.rule_id,
        name: rule.name,
        labels: rule.labels ?? [],
        semanticSimilarity: rule.semanticSimilarity
      }));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ results });
  } catch (error) {
    res.status(500).json({ error: error?.message || "semantic assist failed" });
  }
};
