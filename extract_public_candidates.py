from __future__ import annotations

import csv
import json
import random
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
RANDOM_SEED = 42
TARGET_BIASED = 100
TARGET_NEUTRAL_OR_BOUNDARY = 20
TARGET_TOTAL = TARGET_BIASED + TARGET_NEUTRAL_OR_BOUNDARY
SOURCE_CAPS = {
    "COLDataset-gender": 28,
    "SWSR": 32,
    "SWSR-keyword-weibo": 0,
}

RAW_OUT = BASE_DIR / "public_candidates_raw.csv"
FILTERED_OUT = BASE_DIR / "public_candidates_filtered.csv"
SAMPLED_OUT = BASE_DIR / "public_candidates_sampled.csv"
SAMPLED_COMPAT_OUT = BASE_DIR / "public_candidates_sampled_80.csv"
REPORT_OUT = BASE_DIR / "extraction_report.md"

OUTPUT_COLUMNS = [
    "id",
    "sentence",
    "source_dataset",
    "source_file",
    "original_label",
    "original_category",
    "gold_category_suggested",
    "gold_rule_id_suggested",
    "difficulty_suggested",
    "candidate_type",
    "reason_for_mapping",
    "needs_manual_review",
]

GENDER_CUES = [
    "女",
    "她",
    "女人",
    "女生",
    "女性",
    "女孩",
    "老婆",
    "妻子",
    "妈妈",
    "母亲",
    "女权",
    "婚女",
    "剩女",
    "女司机",
    "女朋友",
    "女儿",
    "儿子",
    "生男生女",
    "生儿子",
    "传宗接代",
    "续香火",
    "父姓",
    "男方姓",
    "彩礼",
]

CATEGORY_PATTERNS: dict[str, list[str]] = {
    "C1": [
        "不适合",
        "逻辑",
        "理性",
        "情绪化",
        "敏感",
        "矫情",
        "脑子",
        "数学",
        "理科",
        "技术",
        "领导",
        "能力",
        "司机",
        "抗压",
        "体力",
        "做不了",
        "当不了",
        "笨",
        "蠢",
        "愚蠢",
    ],
    "C2": [
        "顾家",
        "贤惠",
        "做饭",
        "家务",
        "照顾",
        "照顾家庭",
        "嫁得好",
        "好老公",
        "男主外",
        "女主内",
        "靠老公",
        "靠男人生活",
        "养老婆",
        "保姆",
        "带孩子",
        "照护",
    ],
    "C3": [
        "听话",
        "懂事",
        "温柔",
        "强势",
        "太凶",
        "女强人",
        "不好嫁",
        "没人要",
        "男人不敢要",
        "不像女生",
        "女孩家",
        "有主见",
        "抛头露面",
        "顺从",
    ],
    "C4": [
        "漂亮",
        "颜值",
        "身材",
        "胖",
        "瘦",
        "化妆",
        "打扮",
        "穿太少",
        "穿太露",
        "穿短裙",
        "穿女装",
        "穿太露",
        "露乳",
        "老了",
        "花瓶",
        "爱美",
        "p图",
        "靠脸",
        "姨味",
        "美貌",
        "丑",
    ],
    "C5": [
        "三十",
        "年纪大",
        "剩女",
        "嫁不出去",
        "生孩子",
        "不生",
        "当妈",
        "生育",
        "婚驴",
        "催婚",
        "催生",
        "彩礼",
        "子宫",
        "堕胎",
        "打胎",
    ],
    "C6": [
        "太随便",
        "随便约炮",
        "随便的女生",
        "不检点",
        "二手",
        "掉价",
        "矜持",
        "水性杨花",
        "花心",
        "出轨",
        "性侵",
        "骚扰",
        "强奸",
        "贞洁",
        "处女",
        "性骚扰",
        "性侵",
        "亲密",
    ],
    "C7": [
        "晚上别出去",
        "夜里别出去",
        "女生晚归",
        "女人晚归",
        "别出去",
        "女生喝酒",
        "女人喝酒",
        "一个人去",
        "女孩子不安全",
        "活该",
        "招惹",
        "被骚扰",
        "被侵犯",
        "穿成这样",
        "受害者有错",
    ],
    "C8": [
        "女人就是",
        "女生就是",
        "女的就是",
        "女权",
        "打拳",
        "拳师",
        "厌女",
        "雌竞",
        "事多",
        "女人麻烦",
        "女生麻烦",
        "拜金",
        "捞女",
        "彩礼",
        "靠男人",
        "靠关系",
        "靠暧昧",
        "靠睡",
        "收礼物",
        "白嫖",
        "上位",
        "靠资源",
    ],
    "C9": [
        "生儿子",
        "生女孩",
        "女儿不如儿子",
        "重男轻女",
        "传宗接代",
        "续香火",
        "房子留给儿子",
        "读书没用",
        "嫁出去",
        "跟男方姓",
        "女儿养老",
        "养老靠女儿",
        "照顾老人",
        "父姓",
        "冠姓",
    ],
}

RULE_BY_CATEGORY = {
    "C0": "R030",
    "C1": "R001",
    "C2": "R004",
    "C3": "R005",
    "C4": "R011",
    "C5": "R013",
    "C6": "R014",
    "C7": "R020",
    "C8": "R023",
    "C9": "R051",
    "unknown": "unknown",
}

RULE_TO_CATEGORY = {
    "R030": "C0",
    "R001": "C1",
    "R002": "C1",
    "R008": "C1",
    "R009": "C1",
    "R010": "C1",
    "R025": "C1",
    "R034": "C1",
    "R035": "C1",
    "R056": "C1",
    "R057": "C1",
    "R003": "C2",
    "R004": "C2",
    "R018": "C2",
    "R022": "C2",
    "R028": "C2",
    "R036": "C2",
    "R045": "C2",
    "R058": "C2",
    "R062": "C2",
    "R005": "C3",
    "R006": "C3",
    "R007": "C3",
    "R017": "C3",
    "R021": "C3",
    "R026": "C3",
    "R027": "C3",
    "R029": "C3",
    "R039": "C3",
    "R046": "C3",
    "R048": "C3",
    "R011": "C4",
    "R012": "C4",
    "R019": "C4",
    "R038": "C4",
    "R041": "C4",
    "R049": "C4",
    "R061": "C4",
    "R013": "C5",
    "R016": "C5",
    "R024": "C5",
    "R031": "C5",
    "R037": "C5",
    "R044": "C5",
    "R014": "C6",
    "R015": "C6",
    "R032": "C6",
    "R040": "C6",
    "R060": "C6",
    "R020": "C7",
    "R033": "C7",
    "R043": "C7",
    "R023": "C8",
    "R042": "C8",
    "R047": "C8",
    "R050": "C8",
    "R059": "C8",
    "R051": "C9",
    "R052": "C9",
    "R053": "C9",
    "R054": "C9",
    "R055": "C9",
}

RULE_HINTS = [
    ("R059", ["女权", "打拳", "拳师", "女拳"]),
    ("R050", ["雌竞"]),
    ("R047", ["爱花钱", "拜金", "彩礼", "物质"]),
    ("R062", ["靠男人", "靠老公", "靠关系", "靠暧昧", "靠睡", "上位", "收礼物", "白嫖"]),
    ("R014", ["不检点", "随便", "二手", "掉价", "贞洁", "处女"]),
    ("R020", ["晚上别出去", "夜里别出去", "晚归", "女生喝酒", "女人喝酒", "活该", "穿成这样"]),
    ("R013", ["剩女", "嫁不出去", "年纪大"]),
    ("R004", ["嫁得好", "靠老公", "靠男人生活", "好老公"]),
    ("R011", ["漂亮", "颜值", "身材", "胖", "瘦", "花瓶", "靠脸"]),
    ("R002", ["不适合", "技术", "领导", "理科", "逻辑", "数学"]),
]

EXPLICIT_TERMS = [
    "鸡巴",
    "屄",
    "逼",
    "操你",
    "强奸",
    "轮奸",
    "性侵我",
    "阴道",
    "女蛆",
    "男蛆",
    "屌子",
    "蛆",
]

COUNTER_SPEECH_TERMS = [
    "不该这样",
    "不应该",
    "不能把",
    "不能说",
    "不是所有",
    "并不是",
    "反对",
    "歧视",
    "平等",
    "权利",
    "也应该",
    "应该有",
    "希望更多的女性",
    "争取",
    "女权运动",
    "误解",
    "贬义",
    "值得",
    "有没有错",
    "权利",
    "预防和制止",
]

DEROGATORY_OR_UNSTABLE_TERMS = [
    "田园女权",
    "女权婊",
    "女拳",
    "拳师",
    "婚驴",
    "母狗",
    "蛆",
    "屌癌",
    "拜金",
    "捞女",
    "白嫖",
    "二手货",
    "不检点",
    "水性杨花",
    "放荡",
    "鬼混",
    "一钱不值",
    "占有她",
    "管教一下你的女儿",
    "活该",
    "没人要",
    "嫁不出去",
]

WEAK_OR_AMBIGUOUS_TERMS = [
    "家庭",
    "漂亮",
    "温柔",
    "懂事",
    "随便",
    "香火",
    "能力",
    "敏感",
    "照顾",
    "保姆",
    "家务",
    "带孩子",
    "顾家",
    "强势",
    "老了",
    "瘦",
    "化妆",
    "颜值",
    "生育",
    "三十",
    "司机",
    "贤惠",
    "做饭",
    "爱美",
    "身材",
    "美貌",
    "打扮",
    "胖",
    "丑",
    "顺从",
    "听话",
    "喝酒",
    "晚归",
    "生女孩",
    "晚上",
    "夜里",
    "受害",
    "女儿",
    "儿子",
    "麻烦",
    "资源",
    "亲密",
    "矜持",
]

UNSUITABLE_SAMPLE_PHRASES = [
    "富有才华的数学家",
    "多任务处理性能",
    "女司机可是“稀有物种”",
    "女司机坐在车上不停抽搐",
    "民警发现，马某一只手扶着方向盘",
    "疑似酒驾",
    "女装汉服的青年又登台表演",
    "女运动员化妆参与体育赛事",
    "女权主义作家",
    "我不希望人们在谈论女权",
    "预防和制止对女职工的性骚扰",
    "本科和硕士毕业生中",
    "中国空军八一飞行表演队女飞行员",
    "用人单位应当预防",
    "侵犯了女职工的生育权利",
    "香火之情",
    "脑瘫患儿的妈妈",
    "妈妈要去接个电活",
    "每天陪妈妈做一件家务",
    "女友和保姆不停地进进出出",
    "她做饭的时候,我就会躲在厨房外面",
    "女学生比例不足10%",
    "你做的事情很酷，但我做不了",
    "不去上周三的数学课吧",
    "女强人指责男性拜貌",
    "动辄以带枪的靓女形象出现",
    "长女费利西蒂",
    "有些女性这么物质，属实跟很多男性没人要",
    "逼癌女犬",
    "男明星本身油腻打扮女性化",
    "反而用姨味形容女的比较少见",
    "一个男人大庭广众穿女装",
    "电竞直播喜欢拿穿女装当做“福利”",
    "老婆不是花瓶",
    "男的没钱只能靠骗",
    "结婚前，男方给了我们家",
    "彩礼又是否应当退还",
    "双方达成调解协议",
    "近些年来，在我国北方一些农村地区",
    "高额婚姻成本",
    "我后来辞职回家生孩子",
    "有些 男人到了年纪大以后",
    "在他面前，是很骄傲很矜持的",
    "矜持而又不失礼貌地拒绝",
    "很难建立起亲密的关系",
    "亲密关系中获得成长",
    "贞静的处女状态",
    "电视处女作",
    "技术要点,分析技术动作",
    "通过这项技术",
    "技术管理程序",
    "关键技术研究",
    "技术大咖",
    "养殖技术",
    "就像是一个农妇",
    "风流俊俏的后生",
    "女生装扮中性，言行粗犷泼辣",
    "没人要的小屌子",
    "给女孩买了漂亮衣服",
    "女生拍帅哥大部分都是单纯欣赏颜值",
    "湾区女性也不都是漂亮的吧",
    "黑色游泳衣",
    "祭祖、拔楔，大肆骚扰",
    "初当妈妈，什么事都手忙脚乱",
    "一个人去维护清洁工作",
    "中国女篮的2019年",
    "女权鉴定师",
    "烟盒做成的花瓶",
    "丑陋的女人多",
    "血管蛛网一样柔细",
    "美国软屌",
    "非婚女拳诉求",
    "她一只手支在枕头上",
    "有个低年级的小女孩便灌了一肚子",
    "她不再适合担任交通员",
    "卖床垫的女娃",
    "更早之前就曾对母亲有过暴力行为",
    "但是讲话的时候她就控制着",
    "一听怒了，谁要和男蛆锁死",
    "饱经女色的小伙子",
    "裸体，千真万确是处女的躯体",
    "把性骚扰当成职场潜规则",
    "讲黄色笑话和女生穿短裙是一个意思",
    "男人不应该刻意往女人模样打扮",
    "漂亮又专一的女人多了去了",
    "大部分女孩没办法微胖的性感",
    "女同志去做技术活",
    "门外汉",
    "家中的“女领导”",
    "家中的女领导",
    "矫情是竭力想纠正",
    "如此乖巧，如此配合",
    "姑娘们将来可以做饭、缝衣服",
    "又漂亮又温柔体贴又贤淑又善于持家",
    "布兰奇漂亮",
    "她们温柔",
    "一心想找个漂亮的",
    "胖胖的小崽子",
    "奶奶并不生她的气",
    "她是他的头生孩子",
    "这是一个相当高超的理想",
    "妈妈来杭州照顾我",
    "妈妈无微不至地照顾着我",
    "男人自相残杀死了活该",
    "女二就该被虐",
    "重男轻女的既得利益者",
    "对女性被剥削被侵犯的事情发声",
    "厨房做饭的多少男的",
    "生孩子所以活该是弱者",
    "当代女性的平均寿命",
    "养老院",
    "她始终不能与亲生儿子见面",
    "怪重男轻女的人",
    "重男轻女实在太令人讨厌",
    "老家东北，的确重男轻女",
    "女博士公开骂人",
    "数学课常常听不懂",
    "年龄大、体力恢复慢",
    "愚笨，不曾早日料到",
    "逻辑：不仅就美丽与聪颖而言",
    "面对女人满脑子邪念",
    "原来是婴儿的尿布",
    "靠xx 出了名的德州表子",
    "政治正确害死人",
    "女演员想要上位导演",
    "玩个梗就是伸手要了",
    "女孩子钱都没收就是白嫖",
    "女星也不想魔鬼被惩治",
    "女利会踩女上位",
    "她的学徒心志再戾点就是捞女",
    "白嫖不算嫖",
    "不恶意的认为女人会为了上位",
    "这件事我也是挺想不明白",
    "一群男的追着说风凉话",
    "总是能找到怀疑她觉得她活该的理由",
    "女生们这样做不对，那个男生也是活该",
    "男生就活该被女的打",
    "重男轻女的人活该遭报应",
    "权利被侵犯了",
    "多数人将这种不平衡归咎于职场中的",
    "她这是自作自受",
    "如果自己选，是选择跟妈姓",
    "papi孩子随了父姓",
    "冠姓权只是符号化了矛盾",
    "亲生儿子",
    "二手房",
    "年轻、，漂亮",
    "漂亮、，温柔",
    "女朋友日常就是长发",
    "极端丑化中国男性",
    "身体瘦弱一些的男性",
    "漂亮有资本的女人从来不用自己要",
    "焦虑施压于其他人",
    "腐女",
    "丑挫",
    "奥利给",
    "韩剧受众",
    "原始社会雌性",
    "李春鸭",
    "尹白当然不笨",
    "只能通过理性逐个地辨认",
    "就好比你在单位领导面前一样收敛",
    "守贞操，除大把向会长要钱外",
    "谁叫你说俏皮话",
    "二手水果筛选设备",
    "骚男",
    "丑八怪",
    "女利是通过整容化妆",
    "哗众取宠的小丑",
    "没钱养家的男人不配拥有后代",
    "女人变胖变丑",
    "瘦弱娇滴滴爱打扮",
    "就是个戏子",
    "随父姓女的就是没有人权",
    "女的家暴男的就是“女侠”",
    "彩礼的事儿拖了3年",
    "亲骨肉而高兴",
]

HIGH_SIGNAL_TERMS = [
    "女司机",
    "女人就是",
    "女生就是",
    "女的就是",
    "蠢女人",
    "田园女权",
    "女权婊",
    "女拳",
    "拳师",
    "婚驴",
    "剩女",
    "嫁不出去",
    "不好嫁",
    "没人要",
    "女强人",
    "不检点",
    "水性杨花",
    "随便",
    "二手",
    "掉价",
    "活该",
    "穿成这样",
    "女孩子家",
    "女孩儿家",
    "女人就该",
    "女生就该",
    "女人应该",
    "女生应该",
    "靠男人",
    "靠关系",
    "靠暧昧",
    "靠睡",
    "上位",
    "捞女",
    "拜金",
    "白嫖",
    "收礼物",
    "彩礼",
    "传宗接代",
    "香火",
    "生儿子",
    "嫁出去",
]


@dataclass
class Record:
    sentence: str
    source_dataset: str
    source_file: str
    original_label: str
    original_category: str
    source_kind: str
    source_id: str


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(BASE_DIR).as_posix()
    except ValueError:
        return path.as_posix()


def read_csv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def clean_text(text: object) -> str:
    text = "" if text is None or (isinstance(text, float) and pd.isna(text)) else str(text)
    text = re.sub(r"https?://\S+|www\.\S+|t\.cn/\S+", " ", text)
    text = re.sub(r"@\S+", " ", text)
    text = re.sub(r"\s+", " ", text)
    text = text.replace("\u200b", "").replace("\ufeff", "").strip()
    return text


def chinese_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def has_gender_cue(text: str) -> bool:
    return any(cue in text for cue in GENDER_CUES)


def normalize_for_dedupe(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text)
    return text


def split_sentence_like(text: str) -> list[str]:
    text = clean_text(text)
    if not text:
        return []
    pieces = re.split(r"(?<=[。！？!?；;])\s*", text)
    out: list[str] = []
    for piece in pieces:
        piece = piece.strip(" ，,。！？!?；;")
        if not piece:
            continue
        if chinese_count(piece) <= 95:
            out.append(piece)
            continue
        subpieces = re.split(r"(?<=[，,、])\s*", piece)
        buf = ""
        for sub in subpieces:
            sub = sub.strip(" ，,")
            if not sub:
                continue
            if chinese_count(buf + sub) <= 95:
                buf = (buf + "，" + sub).strip("，") if buf else sub
            else:
                if buf:
                    out.append(buf)
                buf = sub
        if buf:
            out.append(buf)
    return out


def is_low_quality(text: str) -> tuple[bool, str]:
    if not text:
        return True, "empty"
    zh = chinese_count(text)
    if zh < 8:
        return True, "too_short"
    if zh > 95:
        return True, "too_long"
    if not has_gender_cue(text):
        return True, "no_gender_cue"
    if re.fullmatch(r"[\W_]+", text):
        return True, "punctuation_only"
    if len(re.findall(r"[A-Za-z0-9]", text)) > zh * 2 and zh < 20:
        return True, "mostly_non_chinese"
    if sum(text.count(term) for term in EXPLICIT_TERMS) >= 2:
        return True, "too_explicit"
    if "�" in text:
        return True, "decode_noise"
    return False, ""


def infer_category(text: str, source_dataset: str, original_category: str) -> tuple[str, str]:
    scores: Counter[str] = Counter()
    matched: dict[str, list[str]] = defaultdict(list)
    for category, terms in CATEGORY_PATTERNS.items():
        for term in terms:
            if term in text:
                scores[category] += 1
                matched[category].append(term)

    if scores:
        category, _ = scores.most_common(1)[0]
        terms = "、".join(matched[category][:4])
        return category, f"matched {terms}"

    if source_dataset == "SWSR":
        if original_category in {"SO", "SA"}:
            return "C6", f"SWSR category {original_category}"
        if original_category == "SCB":
            return "C8", "SWSR stereotype/bias category"
        if original_category == "MA":
            return "C8", "SWSR misogynistic-attack category"

    if source_dataset == "NLPCC-2025/CORGI-style":
        labels = [part.strip() for part in original_category.split("|") if part.strip()]
        if "AC" in labels:
            return "C1", "NLPCC AC label"
        if "ANB" in labels:
            return "C3", "NLPCC ANB label"
        if "DI" in labels:
            return "C8", "NLPCC DI label"

    return "C0", "no strong taxonomy cue"


def infer_rule(text: str, category: str) -> str:
    if category == "C0":
        return "R030"
    for rule, terms in RULE_HINTS:
        if any(term in text for term in terms):
            return rule
    return RULE_BY_CATEGORY.get(category, "unknown")


def align_category_to_taxonomy(rule: str, category: str) -> str:
    return RULE_TO_CATEGORY.get(rule, category)


def infer_difficulty(text: str, source_kind: str, category: str) -> str:
    if source_kind == "neutral":
        return "neutral"
    direct_terms = ["女人就是", "女生就是", "女的就是", "不适合", "不检点", "活该", "嫁不出去", "靠男人"]
    if any(term in text for term in direct_terms):
        return "direct"
    if category == "C0":
        return "boundary"
    if len(text) >= 65 or any(term in text for term in ["为什么", "不是", "并不", "反对", "歧视"]):
        return "contextual"
    return "semi_implicit"


def looks_like_counter_speech(text: str) -> bool:
    return any(term in text for term in COUNTER_SPEECH_TERMS)


def row_quality_flags(row: dict[str, object]) -> list[str]:
    text = str(row["sentence"])
    category = str(row.get("gold_category_suggested", ""))
    flags: list[str] = []
    if "..." in text or "…" in text:
        flags.append("truncated_or_ellipsis")
    if "、，" in text or text.startswith(("的", "顺，", "门外汉")):
        flags.append("malformed_fragment")
    if row.get("candidate_type") == "neutral" and any(term in text for term in DEROGATORY_OR_UNSTABLE_TERMS):
        flags.append("neutral_contains_derogatory_term")
    if row.get("candidate_type") == "biased" and looks_like_counter_speech(text):
        flags.append("counter_speech")
    if any(phrase in text for phrase in UNSUITABLE_SAMPLE_PHRASES):
        flags.append("unsuitable_phrase")
    if any(term in text for term in EXPLICIT_TERMS):
        flags.append("explicit_or_abusive_term")
    reason = str(row.get("reason_for_mapping", ""))
    if reason.startswith("matched "):
        matched_text = reason.replace("matched ", "")
        matched_terms = [part.strip() for part in matched_text.split("、") if part.strip()]
        if matched_terms and all(term in WEAK_OR_AMBIGUOUS_TERMS for term in matched_terms):
            c4_visual_terms = {"漂亮", "化妆", "颜值", "身材", "打扮", "胖", "丑", "瘦", "花瓶", "靠脸", "穿短裙", "穿太少"}
            if not (category == "C4" and any(term in c4_visual_terms for term in matched_terms)):
                flags.append("weak_only_match")
    if row.get("source_dataset") == "NLPCC-2025/CORGI-style" and reason.startswith("NLPCC "):
        flags.append("source_label_only_nlpcc")
    if row.get("source_dataset") == "NLPCC-2025/CORGI-style":
        if category in {"C1", "C2", "C3", "C4", "C7", "C9"} and reason.startswith("matched "):
            matched_text = reason.replace("matched ", "")
            matched_terms = [part.strip() for part in matched_text.split("、") if part.strip()]
            if matched_terms and all(term in WEAK_OR_AMBIGUOUS_TERMS for term in matched_terms):
                flags.append("nlpcc_weak_standalone_match")
    return flags


def build_row(record: Record, serial: int) -> dict[str, object]:
    category, reason = infer_category(record.sentence, record.source_dataset, record.original_category)
    rule = infer_rule(record.sentence, category)
    aligned_category = align_category_to_taxonomy(rule, category)
    if aligned_category != category:
        reason = f"{reason}; taxonomy v3 aligns {rule} to {aligned_category}"
        category = aligned_category
    if record.source_kind == "neutral" and category != "C0":
        candidate_type = "boundary"
        needs_review = True
    elif record.source_kind == "neutral":
        candidate_type = "neutral"
        needs_review = False
    elif record.source_kind == "unlabeled":
        candidate_type = "boundary"
        needs_review = True
    elif looks_like_counter_speech(record.sentence):
        candidate_type = "boundary"
        needs_review = True
    else:
        candidate_type = "biased"
        source_label_only = reason.startswith("NLPCC ") or reason.startswith("SWSR ")
        needs_review = (
            category == "C0"
            or source_label_only
            or infer_difficulty(record.sentence, record.source_kind, category) == "contextual"
        )

    return {
        "id": f"pub-{serial:05d}",
        "sentence": record.sentence,
        "source_dataset": record.source_dataset,
        "source_file": record.source_file,
        "original_label": record.original_label,
        "original_category": record.original_category,
        "gold_category_suggested": category,
        "gold_rule_id_suggested": rule,
        "difficulty_suggested": infer_difficulty(record.sentence, record.source_kind, category),
        "candidate_type": candidate_type,
        "reason_for_mapping": reason,
        "needs_manual_review": bool(needs_review),
    }


def records_from_swsr() -> tuple[list[Record], list[str]]:
    records: list[Record] = []
    notes: list[str] = []

    comment_path = BASE_DIR / "vendor" / "SWSR" / "SexComment.csv"
    if comment_path.exists():
        df = read_csv(comment_path)
        notes.append(f"{rel(comment_path)} columns: {list(df.columns)}")
        for idx, row in df.iterrows():
            source_kind = "biased" if int(row.get("label", 0)) == 1 else "neutral"
            for sent in split_sentence_like(row.get("comment_text")):
                records.append(
                    Record(
                        sentence=sent,
                        source_dataset="SWSR",
                        source_file=rel(comment_path),
                        original_label=str(row.get("label", "")),
                        original_category="" if pd.isna(row.get("category")) else str(row.get("category")),
                        source_kind=source_kind,
                        source_id=f"swsr-comment-{idx}",
                    )
                )
    else:
        notes.append("missing vendor/SWSR/SexComment.csv")

    weibo_path = BASE_DIR / "vendor" / "SWSR" / "SexWeibo.csv"
    if weibo_path.exists():
        df = read_csv(weibo_path)
        notes.append(f"{rel(weibo_path)} columns: {list(df.columns)}")
        for idx, row in df.iterrows():
            # SWSR weibos are keyword-topic posts, not sentence-level labels.
            # Keep only short sentence chunks as boundary candidates.
            for sent in split_sentence_like(row.get("weibo_text")):
                records.append(
                    Record(
                        sentence=sent,
                        source_dataset="SWSR-keyword-weibo",
                        source_file=rel(weibo_path),
                        original_label="keyword",
                        original_category="" if pd.isna(row.get("keyword")) else str(row.get("keyword")),
                        source_kind="unlabeled",
                        source_id=f"swsr-weibo-{idx}",
                    )
                )
    else:
        notes.append("missing vendor/SWSR/SexWeibo.csv")

    lexicon_path = BASE_DIR / "vendor" / "SWSR" / "SexHateLex.txt"
    if lexicon_path.exists():
        notes.append(f"{rel(lexicon_path)} found but skipped because it is lexicon-only, not sentence corpus")
    return records, notes


def records_from_coldataset() -> tuple[list[Record], list[str]]:
    records: list[Record] = []
    notes: list[str] = []
    for path in sorted((BASE_DIR / "vendor" / "COLDataset").glob("*.csv")):
        df = read_csv(path)
        notes.append(f"{rel(path)} columns: {list(df.columns)}")
        if "topic" in df:
            df = df[df["topic"] == "gender"].copy()
        for idx, row in df.iterrows():
            source_kind = "biased" if int(row.get("label", 0)) == 1 else "neutral"
            fine = row.get("fine-grained-label", "")
            original_category = "" if pd.isna(fine) else str(fine)
            for sent in split_sentence_like(row.get("TEXT")):
                records.append(
                    Record(
                        sentence=sent,
                        source_dataset="COLDataset-gender",
                        source_file=rel(path),
                        original_label=str(row.get("label", "")),
                        original_category=original_category,
                        source_kind=source_kind,
                        source_id=f"cold-{path.stem}-{idx}",
                    )
                )
    if not records:
        notes.append("missing or empty vendor/COLDataset gender CSV files")
    return records, notes


def nlpcc_category_from_bias_labels(labels: object) -> str:
    names = ["AC", "DI", "ANB"]
    if not isinstance(labels, list):
        return ""
    return "|".join(name for name, flag in zip(names, labels) if int(flag) == 1)


def records_from_nlpcc() -> tuple[list[Record], list[str]]:
    records: list[Record] = []
    notes: list[str] = []
    root = BASE_DIR / "vendor" / "NLPCC-2025-Shared-Task-7" / "data"
    if not root.exists():
        return records, ["missing vendor/NLPCC-2025-Shared-Task-7/data"]

    for path in sorted(root.rglob("*.json")):
        data = load_json(path)
        notes.append(f"{rel(path)} records: {len(data) if hasattr(data, '__len__') else 'unknown'}")
        path_text = rel(path)
        is_gt = "test_gt" in path.parts or "train" in path.parts or "valid" in path.parts
        is_unlabeled_test = "test" in path.parts and "test_gt" not in path.parts
        for idx, item in enumerate(data if isinstance(data, list) else []):
            if not isinstance(item, dict):
                continue
            if "bias_labels" in item:
                text = item.get("ori_sentence")
                source_kind = "biased"
                original_label = "biased"
                original_category = nlpcc_category_from_bias_labels(item.get("bias_labels"))
            elif "non-biased" in path.name:
                text = item.get("text")
                source_kind = "neutral"
                original_label = "non-biased"
                original_category = ""
            elif "biased" in path.name and is_gt:
                text = item.get("text") or item.get("ori_sentence")
                source_kind = "biased"
                original_label = "biased"
                original_category = ""
            elif is_unlabeled_test:
                text = item.get("text") or item.get("ori_sentence")
                source_kind = "unlabeled"
                original_label = "unlabeled-test"
                original_category = ""
            else:
                continue

            for sent in split_sentence_like(text):
                records.append(
                    Record(
                        sentence=sent,
                        source_dataset="NLPCC-2025/CORGI-style",
                        source_file=path_text,
                        original_label=original_label,
                        original_category=original_category,
                        source_kind=source_kind,
                        source_id=f"nlpcc-{idx}",
                    )
                )
    return records, notes


def extract_all() -> tuple[pd.DataFrame, list[str]]:
    records: list[Record] = []
    notes: list[str] = []
    for loader in [records_from_swsr, records_from_coldataset, records_from_nlpcc]:
        loaded, loader_notes = loader()
        records.extend(loaded)
        notes.extend(loader_notes)

    rows = [build_row(record, i + 1) for i, record in enumerate(records)]
    return pd.DataFrame(rows, columns=OUTPUT_COLUMNS), notes


def filter_candidates(raw: pd.DataFrame) -> tuple[pd.DataFrame, Counter[str]]:
    seen: set[str] = set()
    kept: list[dict[str, object]] = []
    dropped: Counter[str] = Counter()

    for row in raw.to_dict("records"):
        text = clean_text(row["sentence"])
        bad, reason = is_low_quality(text)
        if bad:
            dropped[reason] += 1
            continue
        key = normalize_for_dedupe(text)
        if key in seen:
            dropped["duplicate"] += 1
            continue
        seen.add(key)
        row["sentence"] = text
        kept.append(row)

    return pd.DataFrame(kept, columns=OUTPUT_COLUMNS), dropped


def score_row(row: dict[str, object]) -> tuple[int, int, int, str]:
    text = str(row["sentence"])
    score = 0
    if row["candidate_type"] == "biased":
        score += 30
    if row["gold_category_suggested"] != "C0":
        score += 15
    if not bool(row["needs_manual_review"]):
        score += 8
    if str(row["reason_for_mapping"]).startswith("matched "):
        score += 18
    elif str(row["reason_for_mapping"]).startswith(("NLPCC ", "SWSR ")):
        score -= 4
    high_signal_hits = sum(1 for term in HIGH_SIGNAL_TERMS if term in text)
    score += min(high_signal_hits * 4, 12)
    if 15 <= chinese_count(text) <= 55:
        score += 8
    if row["difficulty_suggested"] in {"direct", "semi_implicit"}:
        score += 5
    if any(term in text for term in EXPLICIT_TERMS):
        score -= 12
    flags = row_quality_flags(row)
    score -= len(flags) * 18
    rule = str(row.get("gold_rule_id_suggested", ""))
    category = str(row.get("gold_category_suggested", ""))
    if category == "C8" and rule == "R059":
        score -= 16
    elif rule == "R023":
        score += 12
    if row["source_dataset"] == "NLPCC-2025/CORGI-style":
        score += 24
    elif row["source_dataset"] == "COLDataset-gender":
        score -= 12
    elif row["source_dataset"] == "SWSR-keyword-weibo":
        score -= 8
    elif row["source_dataset"] == "SWSR":
        score -= 2
    return (-score, chinese_count(text), random.random(), str(row["id"]))


def take_best(rows: pd.DataFrame, n: int, used: set[str]) -> list[dict[str, object]]:
    if n <= 0 or rows.empty:
        return []
    items = [r for r in rows.to_dict("records") if r["id"] not in used]
    items.sort(key=score_row)
    chosen = items[:n]
    used.update(str(r["id"]) for r in chosen)
    return chosen


def take_best_clean(
    rows: pd.DataFrame,
    n: int,
    used: set[str],
    *,
    allow_review: bool = False,
    source_caps: dict[str, int] | None = None,
    selected: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    if n <= 0 or rows.empty:
        return []
    items = [r for r in rows.to_dict("records") if r["id"] not in used]
    if source_caps is not None and selected is not None:
        source_counts = Counter(str(r["source_dataset"]) for r in selected)
        items = [
            r
            for r in items
            if source_counts[str(r["source_dataset"])] < source_caps.get(str(r["source_dataset"]), 10_000)
        ]
    clean = [r for r in items if not row_quality_flags(r)]
    if len(clean) < n and allow_review:
        clean.extend(r for r in items if r not in clean)
    clean.sort(key=score_row)
    if source_caps is not None and selected is not None:
        source_counts = Counter(str(r["source_dataset"]) for r in selected)
        chosen = []
        for row in clean:
            source = str(row["source_dataset"])
            if source_counts[source] >= source_caps.get(source, 10_000):
                continue
            chosen.append(row)
            source_counts[source] += 1
            if len(chosen) >= n:
                break
    else:
        chosen = clean[:n]
    used.update(str(r["id"]) for r in chosen)
    return chosen


def cue_terms_for_row(row: dict[str, object]) -> list[str]:
    terms: list[str] = []
    category = str(row.get("gold_category_suggested", ""))
    terms.extend(CATEGORY_PATTERNS.get(category, []))
    terms.extend(HIGH_SIGNAL_TERMS)
    reason = str(row.get("reason_for_mapping", ""))
    if reason.startswith("matched "):
        terms.extend(part.strip() for part in reason.replace("matched ", "").split("、") if part.strip())
    return sorted(set(terms), key=len, reverse=True)


def compact_sentence_for_sample(row: dict[str, object]) -> str:
    text = clean_text(row["sentence"])
    if chinese_count(text) <= 60:
        return text

    terms = cue_terms_for_row(row)
    pieces = [p.strip(" ，,。！？!?；;") for p in re.split(r"[。！？!?；;，,]", text)]
    pieces = [p for p in pieces if p]
    matching = [p for p in pieces if any(term and term in p for term in terms)]
    if matching:
        matching.sort(key=lambda p: (-sum(1 for term in terms if term in p), abs(chinese_count(p) - 32)))
        best = matching[0]
        if 8 <= chinese_count(best) <= 80:
            return best

    for term in terms:
        pos = text.find(term)
        if pos >= 0:
            start = max(0, pos - 24)
            end = min(len(text), pos + len(term) + 36)
            snippet = text[start:end].strip(" ，,。！？!?；;")
            if 8 <= chinese_count(snippet) <= 80:
                return snippet
    return text


def polish_sampled_rows(rows: pd.DataFrame) -> pd.DataFrame:
    out = rows.copy()
    for idx, row in out.iterrows():
        polished = compact_sentence_for_sample(row.to_dict())
        if polished != row["sentence"]:
            out.at[idx, "sentence"] = polished
            reason = str(row["reason_for_mapping"])
            if "trimmed for standalone sample" not in reason:
                out.at[idx, "reason_for_mapping"] = f"{reason}; trimmed for standalone sample"
            out.at[idx, "needs_manual_review"] = True
        flags = row_quality_flags(out.loc[idx].to_dict())
        if flags:
            out.at[idx, "needs_manual_review"] = True
            reason = str(out.at[idx, "reason_for_mapping"])
            flag_text = ",".join(flags)
            if "quality_flags=" not in reason:
                out.at[idx, "reason_for_mapping"] = f"{reason}; quality_flags={flag_text}"
    return out


def sample_candidates(filtered: pd.DataFrame) -> pd.DataFrame:
    random.seed(RANDOM_SEED)
    used: set[str] = set()
    selected: list[dict[str, object]] = []

    biased = filtered[filtered["candidate_type"] == "biased"].copy()
    biased = biased[biased["gold_category_suggested"] != "C0"].copy()

    category_targets = {f"C{i}": 11 for i in range(1, 10)}
    category_targets["C1"] = 12
    for category, target in category_targets.items():
        subset = biased[biased["gold_category_suggested"] == category]
        selected.extend(
            take_best_clean(subset, min(target, len(subset)), used, source_caps=SOURCE_CAPS, selected=selected)
        )

    if len(selected) < TARGET_BIASED:
        category_caps = {f"C{i}": 13 for i in range(1, 10)}
        while len(selected) < TARGET_BIASED:
            counts = Counter(str(r["gold_category_suggested"]) for r in selected)
            under_cap = [c for c in category_targets if counts[c] < category_caps[c]]
            if not under_cap:
                selected.extend(take_best_clean(biased, TARGET_BIASED - len(selected), used, allow_review=True))
                break
            grew = False
            for category in sorted(under_cap, key=lambda c: (counts[c], c)):
                subset = biased[biased["gold_category_suggested"] == category]
                picked = take_best_clean(subset, 1, used, source_caps=SOURCE_CAPS, selected=selected)
                if picked:
                    selected.extend(picked)
                    grew = True
                    if len(selected) >= TARGET_BIASED:
                        break
            if not grew:
                picked = take_best_clean(
                    biased, TARGET_BIASED - len(selected), used, source_caps=SOURCE_CAPS, selected=selected
                )
                selected.extend(picked)
                if len(selected) < TARGET_BIASED:
                    selected.extend(take_best_clean(biased, TARGET_BIASED - len(selected), used, allow_review=True))
                break
    elif len(selected) > TARGET_BIASED:
        selected = selected[:TARGET_BIASED]

    neutral = filtered[filtered["candidate_type"] == "neutral"].copy()
    boundary = filtered[filtered["candidate_type"].isin(["boundary", "uncertain"])].copy()
    selected.extend(
        take_best_clean(neutral, min(12, TARGET_NEUTRAL_OR_BOUNDARY), used, source_caps=SOURCE_CAPS, selected=selected)
    )
    if len(selected) < TARGET_BIASED + TARGET_NEUTRAL_OR_BOUNDARY:
        while len(selected) < TARGET_BIASED + TARGET_NEUTRAL_OR_BOUNDARY:
            counts = Counter(str(r["gold_category_suggested"]) for r in selected)
            categories = [f"C{i}" for i in range(1, 10)]
            grew = False
            for category in sorted(categories, key=lambda c: (counts[c], c)):
                if counts[category] >= 13:
                    continue
                subset = boundary[boundary["gold_category_suggested"] == category]
                picked = take_best_clean(
                    subset, 1, used, source_caps=SOURCE_CAPS, selected=selected
                )
                if picked:
                    selected.extend(picked)
                    grew = True
                    if len(selected) >= TARGET_BIASED + TARGET_NEUTRAL_OR_BOUNDARY:
                        break
            if not grew:
                selected.extend(take_best_clean(boundary, TARGET_BIASED + TARGET_NEUTRAL_OR_BOUNDARY - len(selected), used, allow_review=True))
                break
    if len(selected) < TARGET_BIASED + TARGET_NEUTRAL_OR_BOUNDARY:
        selected.extend(take_best_clean(filtered, TARGET_BIASED + TARGET_NEUTRAL_OR_BOUNDARY - len(selected), used, allow_review=True))

    out = pd.DataFrame(selected, columns=OUTPUT_COLUMNS)
    out = polish_sampled_rows(out)
    return out.reset_index(drop=True)


def write_csv(df: pd.DataFrame, path: Path) -> None:
    df.to_csv(path, index=False, encoding="utf-8-sig", quoting=csv.QUOTE_MINIMAL)


def try_write_csv(df: pd.DataFrame, path: Path) -> str:
    try:
        write_csv(df, path)
        return f"wrote {path.name}"
    except PermissionError:
        return f"skipped {path.name}: permission denied, probably open in another app"


def report(raw: pd.DataFrame, filtered: pd.DataFrame, sampled: pd.DataFrame, notes: list[str], dropped: Counter[str]) -> str:
    lines: list[str] = []
    lines.append("# Public Corpus Re-extraction Report")
    lines.append("")
    lines.append("This run uses corpus-provided labels first, then applies conservative taxonomy suggestions.")
    lines.append("")
    lines.append("## Files / Schema Notes")
    lines.extend(f"- {note}" for note in notes)
    lines.append("")

    for title, df in [("Raw Extracted", raw), ("After Filtering", filtered), ("Sampled", sampled)]:
        lines.append(f"## {title}")
        lines.append(f"- total: {len(df)}")
        if not df.empty:
            lines.append("- by source_dataset:")
            for key, val in df["source_dataset"].value_counts().items():
                lines.append(f"  - {key}: {val}")
            lines.append("- by candidate_type:")
            for key, val in df["candidate_type"].value_counts().items():
                lines.append(f"  - {key}: {val}")
            lines.append("- by suggested category:")
            for key, val in df["gold_category_suggested"].value_counts().sort_index().items():
                lines.append(f"  - {key}: {val}")
        lines.append("")

    lines.append("## Filtering Drops")
    for key, val in dropped.most_common():
        lines.append(f"- {key}: {val}")
    lines.append("")

    lines.append("## Sample Verification")
    biased_count = int((sampled["candidate_type"] == "biased").sum()) if not sampled.empty else 0
    non_c0_count = int((sampled["gold_category_suggested"] != "C0").sum()) if not sampled.empty else 0
    review_count = int(sampled["needs_manual_review"].astype(bool).sum()) if not sampled.empty else 0
    lines.append(f"- strict source-labeled biased samples: {biased_count}")
    lines.append(f"- non-C0 taxonomy suggestions: {non_c0_count}")
    lines.append(f"- needs_manual_review: {review_count}")
    lines.append("")
    lines.append("## Notes")
    lines.append("- SWSR SexHateLex is lexicon-only, so it is not converted into sentence samples.")
    lines.append("- SWSR SexWeibo has keyword-topic posts but no sentence-level sexism labels; short chunks are kept only as boundary candidates.")
    lines.append("- NLPCC/CORGI-style test files without ground-truth labels are kept as boundary candidates, not strict biased examples.")
    lines.append("- Suggested categories and rule ids are for manual review; they are not final gold labels.")
    lines.append("")

    if not sampled.empty:
        lines.append("## Sample Rows")
        for row in sampled.head(12).to_dict("records"):
            lines.append(
                f"- {row['id']} | {row['source_dataset']} | {row['candidate_type']} | "
                f"{row['gold_category_suggested']} | {row['sentence']}"
            )
    return "\n".join(lines)


def main() -> None:
    raw, notes = extract_all()
    filtered, dropped = filter_candidates(raw)
    sampled = sample_candidates(filtered)

    write_csv(raw, RAW_OUT)
    write_csv(filtered, FILTERED_OUT)
    write_csv(sampled, SAMPLED_OUT)
    compat_status = try_write_csv(sampled, SAMPLED_COMPAT_OUT)
    REPORT_OUT.write_text(report(raw, filtered, sampled, notes, dropped), encoding="utf-8-sig")

    print("PUBLIC CORPUS RE-EXTRACTION")
    print(f"raw: {len(raw)} -> {RAW_OUT.name}")
    print(f"filtered: {len(filtered)} -> {FILTERED_OUT.name}")
    print(f"sampled: {len(sampled)} -> {SAMPLED_OUT.name}; {compat_status}")
    print()
    print("sampled candidate_type")
    print(sampled["candidate_type"].value_counts().to_string())
    print()
    print("sampled category")
    print(sampled["gold_category_suggested"].value_counts().sort_index().to_string())
    print()
    print("sampled source")
    print(sampled["source_dataset"].value_counts().to_string())


if __name__ == "__main__":
    main()
