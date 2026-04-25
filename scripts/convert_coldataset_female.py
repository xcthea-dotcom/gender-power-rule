import csv
import json
from collections import Counter
from pathlib import Path


ROOT = Path(r"C:\Users\Administrator\Documents\Codex\2026-04-20-hi")
RAW_DIR = ROOT / "vendor" / "COLDataset"
OUT_DIR = ROOT / "data" / "coldataset-female"

FILES = ["train.csv", "dev.csv", "test.csv"]

FEMALE_MARKERS = [
    "女",
    "女性",
    "女人",
    "女生",
    "女孩",
    "女的",
    "女权",
    "女拳",
    "婚驴",
    "仙女",
    "母狗",
    "母人",
    "田园女权",
    "老婆",
    "妻子",
    "妇女",
    "阿姨",
    "小姐姐",
    "姐姐",
    "妹妹",
    "女星",
    "女儿",
    "俄妹",
    "包租婆",
]


def normalize_text(text: str) -> str:
    if text is None:
        return ""

    return (
        text.replace("\u3000", " ")
        .replace("\xa0", " ")
        .replace("\r", " ")
        .replace("\n", " ")
        .strip()
    )


def marker_hits(text: str):
    clean = normalize_text(text)
    return [marker for marker in FEMALE_MARKERS if marker and marker in clean]


def read_rows(path: Path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    return [{(key or "").strip(): value for key, value in row.items()} for row in rows]


def write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_js_assignment(path: Path, variable_name: str, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"window.{variable_name} = {json.dumps(payload, ensure_ascii=False)};\n", encoding="utf-8")


def main():
    records = []
    stats = Counter()

    for file_name in FILES:
        for row in read_rows(RAW_DIR / file_name):
            if row.get("topic") != "gender":
                continue

            text = normalize_text(row.get("TEXT", ""))
            hits = marker_hits(text)

            if not hits:
                continue

            label = normalize_text(row.get("label", ""))
            record = {
                "id": normalize_text(row.get("", "")) or None,
                "split": normalize_text(row.get("split", "")) or file_name.replace(".csv", ""),
                "topic": normalize_text(row.get("topic", "")),
                "label": label,
                "is_offensive": label == "1",
                "fine_grained_label": normalize_text(row.get("fine-grained-label", "")) or None,
                "text": text,
                "female_marker_hits": hits,
                "source": "COLDataset",
            }
            records.append(record)
            stats["all"] += 1
            stats[f"label_{label}"] += 1
            stats[f"split_{record['split']}"] += 1
            if record["fine_grained_label"]:
                stats[f"fine_{record['fine_grained_label']}"] += 1

    positive_samples = [record for record in records if record["is_offensive"]]
    negative_samples = [record for record in records if not record["is_offensive"]]

    payload = {
        "meta": {
            "name": "COLDataset female-related subset",
            "source_repo": "https://github.com/thu-coai/COLDataset",
            "subset_rule": "topic=gender and text contains at least one female-related marker",
            "note": "This is a heuristic women-related subset, not an official female-only split from the original dataset.",
            "female_markers": FEMALE_MARKERS,
        },
        "stats": {
            "record_count": stats["all"],
            "offensive_count": stats["label_1"],
            "non_offensive_count": stats["label_0"],
            "split_counts": {
                "train": stats["split_train"],
                "dev": stats["split_dev"],
                "test": stats["split_test"],
            },
        },
        "positive_samples": positive_samples,
        "negative_samples": negative_samples,
        "records": records,
    }

    write_json(OUT_DIR / "project-pack.json", payload)
    write_js_assignment(OUT_DIR / "project-pack.js", "corpusProjectPack", payload)

    print(json.dumps({"output_dir": str(OUT_DIR), "stats": payload["stats"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
