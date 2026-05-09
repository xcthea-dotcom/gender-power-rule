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
