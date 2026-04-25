import csv
import json
from collections import Counter
from pathlib import Path


ROOT = Path(r"C:\Users\Administrator\Documents\Codex\2026-04-20-hi")
RAW_DIR = ROOT / "vendor" / "SWSR"
OUT_DIR = ROOT / "data" / "swsr"

WEIBO_FILE = RAW_DIR / "SexWeibo.csv"
COMMENT_FILE = RAW_DIR / "SexComment.csv"
LEXICON_FILE = RAW_DIR / "SexHateLex.txt"


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


def parse_int(value: str):
    value = (value or "").strip()
    if not value:
        return None

    try:
        return int(value)
    except ValueError:
        return None


def read_csv_rows(path: Path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    cleaned_rows = []
    for row in rows:
        cleaned_rows.append({(key or "").strip(): value for key, value in row.items()})

    return cleaned_rows


def read_lexicon_terms(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        terms = [normalize_text(line) for line in handle.readlines()]

    unique_terms = []
    seen = set()
    for term in terms:
        if not term:
            continue
        if term in seen:
            continue
        seen.add(term)
        unique_terms.append(term)

    return unique_terms


def convert_weibos(rows):
    records = []

    for row in rows:
        keyword_field = normalize_text(row.get("keyword", ""))
        keywords = [item.strip() for item in keyword_field.split() if item.strip()]

        records.append(
            {
                "id": row["weibo_id"],
                "text": normalize_text(row.get("weibo_text", "")),
                "keywords": keywords,
                "keyword_text": keyword_field,
                "source": "SWSR/SexWeibo",
                "user": {
                    "gender": normalize_text(row.get("user_gender", "")) or None,
                    "location": normalize_text(row.get("user_location", "")) or None,
                    "follower_count": parse_int(row.get("user_follower", "")),
                    "following_count": parse_int(row.get("user_following", "")),
                },
                "engagement": {
                    "like_count": parse_int(row.get("weibo_like", "")),
                    "comment_count": parse_int(row.get("weibo_comment", "")),
                    "repost_count": parse_int(row.get("weibo_repost", "")),
                },
                "created_at": normalize_text(row.get("weibo_date", "")) or None,
            }
        )

    return records


def convert_comments(rows):
    records = []

    for row in rows:
        label_value = normalize_text(row.get("label", "0")) or "0"
        category = normalize_text(row.get("category", "")) or None
        target = normalize_text(row.get("target", "")) or None

        records.append(
            {
                "id": normalize_text(row.get("index", "")) or None,
                "weibo_id": row["weibo_id"],
                "text": normalize_text(row.get("comment_text", "")),
                "label": label_value,
                "is_sexist": label_value == "1",
                "category": category,
                "target": target,
                "source": "SWSR/SexComment",
                "user": {
                    "gender": normalize_text(row.get("gender", "")) or None,
                    "location": normalize_text(row.get("location", "")) or None,
                },
                "engagement": {
                    "like_count": parse_int(row.get("like", "")),
                },
                "created_at": normalize_text(row.get("date", "")) or None,
            }
        )

    return records


def build_stats(weibos, comments, lexicon_terms):
    category_counts = Counter(comment["category"] or "UNKNOWN" for comment in comments)
    target_counts = Counter(comment["target"] or "UNKNOWN" for comment in comments)
    label_counts = Counter(comment["label"] for comment in comments)
    keyword_weibo_count = sum(1 for weibo in weibos if weibo["keywords"])

    return {
        "weibo_count": len(weibos),
        "comment_count": len(comments),
        "sexist_comment_count": sum(1 for comment in comments if comment["is_sexist"]),
        "non_sexist_comment_count": sum(1 for comment in comments if not comment["is_sexist"]),
        "keyword_weibo_count": keyword_weibo_count,
        "lexicon_term_count": len(lexicon_terms),
        "comment_label_counts": dict(label_counts),
        "comment_category_counts": dict(category_counts),
        "comment_target_counts": dict(target_counts),
    }


def write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_js_assignment(path: Path, variable_name: str, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False)
    path.write_text(f"window.{variable_name} = {serialized};\n", encoding="utf-8")


def main():
    weibos = convert_weibos(read_csv_rows(WEIBO_FILE))
    comments = convert_comments(read_csv_rows(COMMENT_FILE))
    lexicon_terms = read_lexicon_terms(LEXICON_FILE)
    stats = build_stats(weibos, comments, lexicon_terms)

    meta = {
        "name": "SWSR + SexHateLex",
        "source_repo": "https://github.com/aggiejiang/SWSR",
        "citation": "Jiang et al. (2022) SWSR: A Chinese dataset and lexicon for online sexism detection.",
        "license": "MIT",
        "local_raw_dir": str(RAW_DIR),
    }

    lexicon_payload = {
        "meta": meta,
        "stats": {
            "term_count": len(lexicon_terms),
        },
        "terms": lexicon_terms,
    }

    weibos_payload = {
        "meta": meta,
        "stats": {
            "record_count": len(weibos),
            "keyword_weibo_count": stats["keyword_weibo_count"],
        },
        "records": weibos,
    }

    comments_payload = {
        "meta": meta,
        "stats": {
            "record_count": len(comments),
            "sexist_comment_count": stats["sexist_comment_count"],
            "non_sexist_comment_count": stats["non_sexist_comment_count"],
            "category_counts": stats["comment_category_counts"],
            "target_counts": stats["comment_target_counts"],
        },
        "records": comments,
    }

    project_pack = {
        "meta": meta,
        "stats": stats,
        "lexicon_terms": lexicon_terms,
        "sexist_comment_samples": [comment for comment in comments if comment["is_sexist"]],
        "non_sexist_comment_samples": [comment for comment in comments if not comment["is_sexist"]],
        "keyword_weibos": [weibo for weibo in weibos if weibo["keywords"]],
    }

    write_json(OUT_DIR / "sexhatelext.json", lexicon_payload)
    write_json(OUT_DIR / "weibos.json", weibos_payload)
    write_json(OUT_DIR / "comments.json", comments_payload)
    write_json(OUT_DIR / "project-pack.json", project_pack)
    write_js_assignment(OUT_DIR / "project-pack.js", "swsrProjectPack", project_pack)

    print(
        json.dumps(
            {
                "output_dir": str(OUT_DIR),
                "stats": stats,
                "files": [
                    "sexhatelext.json",
                    "weibos.json",
                    "comments.json",
                    "project-pack.json",
                    "project-pack.js",
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
