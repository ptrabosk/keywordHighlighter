#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from tqdm import tqdm
except ImportError:  # pragma: no cover - depends on local environment
    tqdm = None  # type: ignore[assignment]


DEFAULT_BATCH_FILENAME = "opt_out_batch.csv"
DEFAULT_INVENTORY_FILENAME = "opt_out_deterministic_rules.json"
DEFAULT_OUTPUT_DIRNAME = "output"
DEFAULT_OUTPUT_FILENAME = "opt_out_batch_classified.csv"
DEFAULT_MATCHED_OUTPUT_FILENAME = "opt_out_batch_matched.csv"
DEFAULT_SUMMARY_FILENAME = "opt_out_batch_rule_matches.summary.json"
DEFAULT_ANALYSIS_FILENAME = "opt_out_batch_rule_analysis.json"
ZERO_WIDTH_RE = re.compile("[\u200b\u200c\u200d\ufeff]")
NON_WORD_RE = re.compile(r"[^0-9a-z]+")
COMBINING_MARK_RE = re.compile(r"[\u0300-\u036f]+")
STYLIZED_CHAR_MAP = str.maketrans(
    {
        "ᴛ": "t",
        "ᴏ": "o",
        "ᴘ": "p",
        "ꜱ": "s",
        "\U0001f162": "s",
        "\U0001f163": "t",
        "\U0001f15e": "o",
        "\U0001f15f": "p",
        "\U0001f182": "s",
        "\U0001f183": "t",
        "\U0001f17e": "o",
        "\U0001f17f": "p",
    }
)
HOT_TOPIC_REPLY_OPT_OUT_RE = re.compile(r"\b(?:4|four|never)\b")
DRIVING_AUTO_REPLY_RE = re.compile(
    r"\b(?:driving|conduciendo)\b|au volant|"
    r"^i m not receiving notifications if this is urgent reply urgent to send a notification through with your original message"
)
UNAVAILABLE_AUTO_REPLY_RE = re.compile(
    r"^hey i m currently unavailable i ll get back to you as soon as i can$|"
    r"^i m not receiving notifications if this is urgent reply urgent to send a notification through with your original message$|"
    r"^sorry can t talk now$|"
    r"^thank you for contacting me i m unable to chat right now but i ll reply to your text as soon as i can thanks$|"
    r"^thanks for reaching out i can t chat(?: at the moment| now) but i ll text you back as soon as i can(?: thanks(?: child of christ| sent from text free)?)?$|"
    r"^thanks for reaching out text me and if you have ig please message me let mee feed you set all notifications$"
)
DEVICE_NOT_WORKING_RE = re.compile(
    r"^this is an automatic message this is a kosher talk only device and does not accept text messages please call instead$|"
    r"^this number doesn t support text please call instead$|"
    r"^this phone cannot receive text messages please call instead$|"
    r"^this phone does not accept text messages please call instead(?: this is an automatic reply)?$"
)
TXT_ORIGIN_QUESTION_RE = re.compile(
    r"\bhow did (?:you|u) get my (?:number|phone number|contact)\b|"
    r"\bwhere did (?:you|u) get my (?:number|phone number|contact)\b|"
    r"\bwho gave (?:you|u) my (?:number|phone number|contact)\b|"
    r"\bwhy (?:am i|do i) (?:getting|get|receive|receiving) (?:these )?(?:texts?|text messages?|messages?|msgs?)\b|"
    r"\bwhy (?:are|r) (?:you|u) (?:texting|messaging|msging|contacting) me\b|"
    r"\bwhy (?:are|r) (?:you|u) sending (?:me )?(?:texts?|text messages?|messages?|msgs?)\b|"
    r"\bwhy did (?:you|u) (?:text|message|msg|contact) me\b|"
    r"\bwhy did i get (?:this|these) (?:text|texts|message|messages|msg|msgs)\b|"
    r"\bwhy do (?:you|u) (?:text|message|msg) me\b|"
    r"\bwhy do (?:you|u) keep (?:texting|messaging|contacting)(?: me)?\b|"
    r"\bi (?:dont|do not) know (?:you|u)\b|"
    r"\bwho (?:is|are) (?:this|you|u)\b"
)
LETTER_RE = re.compile(r"[A-Za-z]")
EMOJI_RANGES = (
    (0x1F000, 0x1FAFF),
    (0x2600, 0x27BF),
)
STOP_SIGNAL_EMOJIS = {
    "🖕",
    "🛑",
    "✋",
    "🖐",
    "🔇",
    "🔕",
    "🚫",
    "⛔",
    "🙅",
}
WORKER_RULES: list["RunnableRule"] = []
STOP_SIGNAL_EMOJIS = {
    "\U0001f595",
    "\U0001f6d1",
    "\u270b",
    "\U0001f590",
    "\U0001f507",
    "\U0001f515",
    "\U0001f6ab",
    "\u26d4",
    "\U0001f645",
}


def iter_rules(path: Path) -> Any:
    inventory = json.loads(path.read_text(encoding="utf-8-sig"))
    rules = inventory.get("rules")
    if not isinstance(rules, list):
        raise ValueError(f"{path} must contain a top-level rules array")
    return iter(rules)


def count_csv_data_rows(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as f:
        total_lines = sum(1 for _ in f)
    return max(total_lines - 1, 0)


def remap_cp1252_mojibake_bytes(text: str) -> bytes | None:
    data = bytearray()
    for char in text:
        codepoint = ord(char)
        if codepoint < 256:
            data.append(codepoint)
            continue
        try:
            data.extend(char.encode("cp1252"))
        except UnicodeEncodeError:
            return None
    return bytes(data)


def repair_common_mojibake(value: str) -> str:
    text = value or ""
    for _ in range(3):
        data = remap_cp1252_mojibake_bytes(text)
        if data is None:
            break
        try:
            repaired = data.decode("utf-8")
        except UnicodeDecodeError:
            break
        if repaired == text:
            break
        text = repaired
    return text


def fold_text_variants(value: str) -> str:
    text = repair_common_mojibake(value)
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(STYLIZED_CHAR_MAP)
    text = unicodedata.normalize("NFKD", text)
    text = COMBINING_MARK_RE.sub("", text)
    return unicodedata.normalize("NFKC", text)


@dataclass(frozen=True)
class RunnableRule:
    raw: dict[str, Any]
    pattern: str
    original_pattern_or_condition: str
    inventory_index: int
    regex: re.Pattern[str] | None = None
    normalized_pattern: str = ""
    new_category: str = ""
    subcategory: str = ""
    opt_out: str = ""
    action: str = ""
    classification_status: str = "unclassified"


def normalize_text(value: str) -> str:
    text = fold_text_variants(value or "")
    text = ZERO_WIDTH_RE.sub("", text)
    text = text.casefold()
    text = text.replace("'", "").replace("`", "")
    text = NON_WORD_RE.sub(" ", text)
    return " ".join(text.split())


def normalize_pattern_for_text_regex(pattern: str) -> str:
    pattern = fold_text_variants(pattern or "")
    parts: list[str] = []
    escaped = False
    for char in pattern or "":
        if escaped:
            parts.append(char)
            escaped = False
            continue
        if char == "\\":
            parts.append(char)
            escaped = True
            continue
        text = unicodedata.normalize("NFKC", char)
        text = ZERO_WIDTH_RE.sub("", text)
        parts.append(text.casefold())
    return "".join(parts)


def compile_flags(flag_text: str) -> int:
    flags = 0
    for flag in flag_text or "":
        if flag == "i":
            flags |= re.IGNORECASE
        elif flag == "m":
            flags |= re.MULTILINE
        elif flag == "s":
            flags |= re.DOTALL
        elif flag == "x":
            flags |= re.VERBOSE
        elif flag == "a":
            flags |= re.ASCII
    return flags


HOT_TOPIC_RULE_NAMES = {"opt_outs_ml.hot_topic_not_opt_out", "opt_outs_ml.hot_topic_opt_out"}
EMOJI_ONLY_RULE_NAMES = {"opt_outs_ml.emoji_only_non_stop"}
SINGLE_CHARACTER_RULE_NAMES = {"combined.single_letter_only", "combined.number_only"}
EXACT_MATCH_SUBCATEGORIES = {"auto_reply", "customer_support"}
EXACT_MATCH_RULE_IDS = {
    "rule_00b101067274a973",
    "rule_02b6ffd9d71d2546",
    "rule_1ccc323db57027ee",
    "rule_317fdbf0a6758d04",
    "rule_35a64c97cf6b24d5",
    "rule_3ee24b76d721a34f",
    "rule_51b43e294d38540e",
    "rule_ade7bf36e8de2073",
    "rule_bfd7b75bc7be144c",
    "rule_c3dc65183282baaf",
    "rule_d68cf12285850e44",
    "rule_dcf5c0ee0cd11d07",
    "rule_e4c95bd4390d3fd0",
    "rule_ed3db71ec5a14a9c",
    "rule_329faf92ed23d82b",
    "rule_72a6fbe032daefab",
    "rule_82cea9c744fe8ca9",
    "rule_8c8228aae049f69f",
    "rule_949dbd040d7b98f7",
    "rule_9501f80f59e3b9fd",
    "rule_9dad33db918fe279",
}


def rule_field(rule: dict[str, Any], field: str) -> str:
    return str(rule.get(field) or "")


def rule_category_value(rule: dict[str, Any]) -> str:
    return rule_field(rule, "opt_out") or rule_field(rule, "new_category") or rule_field(rule, "category")


def rule_action_value(rule: dict[str, Any]) -> str:
    action = rule_field(rule, "action")
    if action:
        return action
    category = rule_category_value(rule)
    if category in {"opt_out", "fuzzy_opt_out", "tmt", "txt", "non_opt_out"}:
        return category
    return rule_field(rule, "category")


def rule_sort_key(rule: RunnableRule) -> tuple[int, str, int, str, str]:
    raw = rule.raw
    name = rule_field(raw, "name")
    rule_type = rule_field(raw, "type")
    category = rule_category_value(raw)
    action = rule_action_value(raw)
    subcategory = rule_field(raw, "subcategory").casefold()

    if name in EMOJI_ONLY_RULE_NAMES or rule_type == "symbol_set":
        group = 1
    elif name in HOT_TOPIC_RULE_NAMES:
        group = 2
    elif name in SINGLE_CHARACTER_RULE_NAMES or rule_field(raw, "subcategory") == "single_character":
        group = 3
    elif action == "opt_out":
        group = 4
    elif action == "fuzzy_opt_out":
        group = 5
    elif action == "tmt":
        group = 6
    elif action == "txt":
        group = 7
    elif category == "non_opt_out":
        group = 8
    else:
        group = 9

    if 4 <= group <= 8:
        return (group, subcategory, rule.inventory_index, rule_field(raw, "id"), name)
    return (group, "", rule.inventory_index, rule_field(raw, "id"), name)


def load_runnable_rules(inventory_path: Path) -> tuple[list[RunnableRule], list[dict[str, str]], list[dict[str, Any]]]:
    runnable: list[RunnableRule] = []
    skipped: list[dict[str, str]] = []
    all_rules: list[dict[str, Any]] = []

    for inventory_index, rule in enumerate(iter_rules(inventory_path), start=1):
        rule_type = rule.get("type", "")
        pattern = str(rule.get("pattern") or "")
        original_pattern_or_condition = str(rule.get("condition_summary") or pattern)
        inventory_category = rule_category_value(rule)
        inventory_subcategory = rule_field(rule, "subcategory")
        inventory_action = rule_action_value(rule)
        inventory_opt_out = rule_field(rule, "opt_out")
        classification_status = str(rule.get("classification_status") or "inventory")
        rule["new_category"] = inventory_category
        rule["subcategory"] = inventory_subcategory
        rule["action"] = inventory_action
        rule["classification_status"] = classification_status
        rule["inventory_index"] = inventory_index
        rule["original_pattern_or_condition"] = original_pattern_or_condition
        all_rules.append(rule)

        if not pattern:
            skipped.append(skip(rule, "empty pattern"))
            continue

        if rule_type == "regex":
            compile_pattern = pattern
            scope = str(rule.get("match_scope") or "").casefold()
            target = str(rule.get("match_target") or "").casefold()
            if "raw" not in scope and "raw" not in target and "inbound dom message text" not in target:
                compile_pattern = normalize_pattern_for_text_regex(pattern)
            try:
                runnable.append(
                    RunnableRule(
                        raw=rule,
                        pattern=pattern,
                        original_pattern_or_condition=original_pattern_or_condition,
                        inventory_index=inventory_index,
                        regex=re.compile(compile_pattern, compile_flags(str(rule.get("flags") or ""))),
                        new_category=inventory_category,
                        subcategory=inventory_subcategory,
                        opt_out=inventory_opt_out,
                        action=inventory_action,
                        classification_status=classification_status,
                    )
                )
            except re.error as exc:
                skipped.append(skip(rule, f"regex unsupported by Python re: {exc}"))
            continue

        if rule_type in {"literal_phrase", "symbol_set", "vocabulary"} or str(rule.get("name") or "") in {
            "combined.driving_auto_reply",
            "combined.device_not_working",
            "combined.number_only",
            "combined.reaction_reply",
            "combined.single_letter_only",
            "combined.stop_signal_emoji_anywhere",
            "combined.txt_origin_question",
            "combined.unavailable_auto_reply",
            "opt_outs_ml.hot_topic_not_opt_out",
            "opt_outs_ml.hot_topic_opt_out",
            "opt_outs_ml.emoji_only_non_stop",
        }:
            runnable.append(
                RunnableRule(
                    raw=rule,
                    pattern=pattern,
                    original_pattern_or_condition=original_pattern_or_condition,
                    inventory_index=inventory_index,
                    normalized_pattern=normalize_text(pattern),
                    new_category=inventory_category,
                    subcategory=inventory_subcategory,
                    opt_out=inventory_opt_out,
                    action=inventory_action,
                    classification_status=classification_status,
                )
            )
            continue

        skipped.append(skip(rule, f"{rule_type or 'unknown'} is inventory-only"))

    runnable.sort(key=rule_sort_key)
    return runnable, skipped, all_rules


def skip(rule: dict[str, Any], reason: str) -> dict[str, str]:
    return {
        "id": str(rule.get("id", "")),
        "name": str(rule.get("name", "")),
        "type": str(rule.get("type", "")),
        "reason": reason,
        "new_category": str(rule.get("new_category", "")),
        "subcategory": str(rule.get("subcategory", "")),
        "opt_out": str(rule.get("opt_out", "")),
        "action": str(rule.get("action", "")),
        "classification_status": str(rule.get("classification_status", "")),
    }


def select_raw_text(row: dict[str, str], rule: dict[str, Any]) -> str:
    target = str(rule.get("match_target") or "").casefold()
    customer = row.get("CUSTOMER_MESSAGE", "") or ""
    brand = row.get("BRAND_MESSAGE", "") or ""
    if "brand_message + customer_message" in target:
        return f"{brand}\n{customer}"
    if "brand" in target and "customer" not in target:
        return brand
    return customer


def select_texts(row: dict[str, str], rule: dict[str, Any]) -> tuple[str, str]:
    raw = select_raw_text(row, rule)
    return raw, normalize_text(raw)


def is_hot_topic_prompt(brand_message: str) -> bool:
    normalized = normalize_text(brand_message)
    return "hot topic" in normalized and (
        "never" in normalized
        or re.search(r"\b4\b", normalized) is not None
        or "four" in normalized
    )


def is_hot_topic_opt_out_reply(customer_message: str) -> bool:
    return HOT_TOPIC_REPLY_OPT_OUT_RE.search(normalize_text(customer_message)) is not None


def is_hot_topic_detector_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    name = str(rule.raw.get("name") or "")
    if name not in {"opt_outs_ml.hot_topic_not_opt_out", "opt_outs_ml.hot_topic_opt_out"}:
        return None

    customer = row.get("CUSTOMER_MESSAGE", "") or ""
    if not customer.strip() or not is_hot_topic_prompt(row.get("BRAND_MESSAGE", "") or ""):
        return False

    has_opt_out_token = is_hot_topic_opt_out_reply(customer)
    if name == "opt_outs_ml.hot_topic_opt_out":
        return has_opt_out_token
    return not has_opt_out_token


def is_emoji_char(char: str) -> bool:
    codepoint = ord(char)
    return any(start <= codepoint <= end for start, end in EMOJI_RANGES)


def contains_stop_signal_emoji(text: str) -> bool:
    return any(char in STOP_SIGNAL_EMOJIS for char in text)


def contains_any_emoji(text: str) -> bool:
    return any(is_emoji_char(char) for char in text)


def is_emoji_only_without_stop_signal(text: str) -> bool:
    stripped = text.strip()
    if not stripped or LETTER_RE.search(stripped):
        return False
    return contains_any_emoji(stripped) and not contains_stop_signal_emoji(stripped)


def is_emoji_detector_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    name = str(rule.raw.get("name") or "")
    if name not in {"combined.stop_signal_emoji_anywhere", "opt_outs_ml.emoji_only_non_stop"}:
        return None

    customer = row.get("CUSTOMER_MESSAGE", "") or ""
    if name == "combined.stop_signal_emoji_anywhere":
        return contains_stop_signal_emoji(customer)
    return is_emoji_only_without_stop_signal(customer)


def is_driving_auto_reply_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    if str(rule.raw.get("name") or "") != "combined.driving_auto_reply":
        return None
    return DRIVING_AUTO_REPLY_RE.search(normalize_text(row.get("CUSTOMER_MESSAGE", "") or "")) is not None


def is_unavailable_auto_reply_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    if str(rule.raw.get("name") or "") != "combined.unavailable_auto_reply":
        return None
    return UNAVAILABLE_AUTO_REPLY_RE.search(normalize_text(row.get("CUSTOMER_MESSAGE", "") or "")) is not None


def is_device_not_working_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    if str(rule.raw.get("name") or "") != "combined.device_not_working":
        return None
    return DEVICE_NOT_WORKING_RE.search(normalize_text(row.get("CUSTOMER_MESSAGE", "") or "")) is not None


def is_txt_origin_question_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    if str(rule.raw.get("name") or "") != "combined.txt_origin_question":
        return None
    return TXT_ORIGIN_QUESTION_RE.search(normalize_text(row.get("CUSTOMER_MESSAGE", "") or "")) is not None


def is_single_character_detector_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    name = str(rule.raw.get("name") or "")
    if name not in {"combined.single_letter_only", "combined.number_only"}:
        return None
    normalized = normalize_text(row.get("CUSTOMER_MESSAGE", "") or "")
    if name == "combined.single_letter_only":
        return len(normalized) == 1 and normalized.isalpha() and normalized.isascii()
    return normalized.isdigit()


def is_reaction_reply_match(rule: RunnableRule, row: dict[str, str]) -> bool | None:
    if str(rule.raw.get("name") or "") != "combined.reaction_reply":
        return None
    normalized = normalize_text(row.get("CUSTOMER_MESSAGE", "") or "")
    if not normalized:
        return False
    return (
        "reacted to" in normalized
        or normalized in {"emphasized an image", "laughed at an image", "liked a contact", "liked an image", "loved a contact", "loved an image"}
        or normalized.startswith("liked ")
        or normalized.startswith("loved ")
        or normalized.startswith("emphasized ")
        or normalized.startswith("laughed at ")
        or normalized.startswith("disliked ")
        or normalized.startswith("questioned ")
        or normalized.startswith("removed a ")
        or normalized.startswith("removed from ")
    )


def is_match(rule: RunnableRule, row: dict[str, str]) -> bool:
    deterministic_match = is_hot_topic_detector_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match
    deterministic_match = is_emoji_detector_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match
    deterministic_match = is_driving_auto_reply_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match
    deterministic_match = is_unavailable_auto_reply_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match
    deterministic_match = is_device_not_working_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match
    deterministic_match = is_txt_origin_question_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match
    deterministic_match = is_single_character_detector_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match
    deterministic_match = is_reaction_reply_match(rule, row)
    if deterministic_match is not None:
        return deterministic_match

    scope = str(rule.raw.get("match_scope") or "").casefold()
    rule_type = str(rule.raw.get("type") or "")
    exact_subcategory_match = (
        rule.subcategory in EXACT_MATCH_SUBCATEGORIES
        or str(rule.raw.get("id") or "") in EXACT_MATCH_RULE_IDS
    )

    if rule_type == "symbol_set":
        return rule.pattern in select_raw_text(row, rule.raw)

    raw_text, normalized_text = select_texts(row, rule.raw)

    if rule.regex is not None:
        text = raw_text if "raw" in scope else normalized_text
        if exact_subcategory_match or "full" in scope or "whole" in scope:
            return rule.regex.fullmatch(text) is not None
        return rule.regex.search(text) is not None

    needle = rule.normalized_pattern
    if not needle:
        return False
    if exact_subcategory_match or "exact" in scope or "full" in scope or "whole" in scope:
        return normalized_text == needle
    return needle in normalized_text


def summarize_match(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": rule.get("id"),
        "name": rule.get("name"),
        "type": rule.get("type"),
        "category": rule.get("category"),
        "new_category": rule.get("new_category"),
        "opt_out": rule.get("opt_out"),
        "subcategory": rule.get("subcategory"),
        "action": rule.get("action"),
        "prediction": rule.get("prediction"),
        "match_target": rule.get("match_target"),
        "normalization": rule.get("normalization"),
        "match_scope": rule.get("match_scope"),
    }


def top_prediction(matches: list[dict[str, Any]]) -> Any:
    predictions = [match.get("prediction") for match in matches]
    if 1 in predictions:
        return 1
    if 2 in predictions:
        return 2
    if 0 in predictions:
        return 0
    return ""


def rule_label(rule: dict[str, Any]) -> str:
    return f"{rule.get('id', '')}:{rule.get('name', '')}"


def combo_key(rule: dict[str, Any]) -> tuple[str, str]:
    return (str(rule.get("new_category") or ""), str(rule.get("subcategory") or ""))


def display_category(value: str) -> str:
    return value if value else "<unclassified>"


def init_worker(rules: list[RunnableRule]) -> None:
    global WORKER_RULES
    WORKER_RULES = rules


def annotate_row(row: dict[str, str], rules: list[RunnableRule], max_matches_per_row: int) -> tuple[dict[str, str], list[dict[str, Any]]]:
    matched_rules: list[RunnableRule] = []
    for rule in rules:
        if is_match(rule, row):
            matched_rules.append(rule)
            break
    matches = [rule.raw for rule in matched_rules]
    limited = matches if max_matches_per_row <= 0 else matches[:max_matches_per_row]
    top_match = matches[0] if matches else {}
    row.update(
        {
            "RULE_MATCHED": "1" if matches else "0",
            "RULE_MATCH_COUNT": str(len(matches)),
            "TOP_PREDICTION": str(top_prediction(matches)),
            "TOP_CATEGORY": str(top_match.get("category") or ""),
            "TOP_NEW_CATEGORY": str(top_match.get("new_category") or ""),
            "TOP_OPT_OUT": str(top_match.get("opt_out") or ""),
            "TOP_SUBCATEGORY": str(top_match.get("subcategory") or ""),
            "TOP_ACTION": str(top_match.get("action") or ""),
            "FIRST_RULE_ID": str(top_match.get("id") or ""),
            "FIRST_RULE_NAME": str(top_match.get("name") or ""),
            "FIRST_RULE_TYPE": str(top_match.get("type") or ""),
            "FIRST_RULE_MATCH_TARGET": str(top_match.get("match_target") or ""),
            "FIRST_RULE_NORMALIZATION": str(top_match.get("normalization") or ""),
            "MATCHED_RULES": ",".join(rule_label(match) for match in limited),
            "MATCHED_RULE_IDS": ",".join(str(match.get("id", "")) for match in limited),
            "MATCHED_RULE_NAMES": ",".join(str(match.get("name", "")) for match in limited),
            "MATCHED_RULE_CATEGORIES": ",".join(str(match.get("category", "")) for match in limited),
            "MATCHED_RULE_NEW_CATEGORIES": ",".join(str(match.get("new_category", "")) for match in limited),
            "MATCHED_RULE_SUBCATEGORIES": ",".join(str(match.get("subcategory", "")) for match in limited),
            "MATCHED_RULE_DETAILS": json.dumps(
                [summarize_match(match) for match in limited],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        }
    )
    return row, matches


def process_row_chunk(args: tuple[int, list[dict[str, str]], int]) -> tuple[int, list[tuple[int, dict[str, str], list[dict[str, Any]]]], dict[str, int], dict[str, int], dict[str, int], dict[str, int]]:
    start_index, rows, max_matches_per_row = args
    results: list[tuple[int, dict[str, str], list[dict[str, Any]]]] = []
    rule_match_counts: Counter[str] = Counter()
    rule_match_rows: dict[str, int] = {}
    match_counts_by_category: dict[str, int] = {}
    match_counts_by_new_category: Counter[str] = Counter()
    match_counts_by_combo: Counter[str] = Counter()

    for offset, row in enumerate(rows):
        row_number = start_index + offset
        annotated, matches = annotate_row(row, WORKER_RULES, max_matches_per_row)
        results.append((row_number, annotated, matches))
        if not matches:
            continue
        row_bit = 1 << (row_number - 1)
        for match in matches:
            rule_id = str(match.get("id") or "")
            rule_match_counts[rule_id] += 1
            rule_match_rows[rule_id] = rule_match_rows.get(rule_id, 0) | row_bit
            category = str(match.get("category") or "")
            match_counts_by_category[category] = match_counts_by_category.get(category, 0) + 1
            new_category = str(match.get("new_category") or "")
            subcategory = str(match.get("subcategory") or "")
            match_counts_by_new_category[new_category] += 1
            match_counts_by_combo[f"{display_category(new_category)} / {display_category(subcategory)}"] += 1

    return (
        start_index,
        results,
        dict(rule_match_counts),
        rule_match_rows,
        dict(match_counts_by_category),
        dict(match_counts_by_new_category),
        dict(match_counts_by_combo),
    )


def process_batch(
    batch_path: Path,
    output_path: Path,
    matched_output_path: Path,
    rules: list[RunnableRule],
    *,
    matched_only: bool,
    limit: int | None,
    max_matches_per_row: int,
    show_progress: bool,
    workers: int,
    chunk_size: int,
) -> dict[str, Any]:
    rows_read = 0
    rows_written = 0
    matched_rows_written = 0
    rows_matched = 0
    match_counts_by_category: dict[str, int] = {}
    match_counts_by_new_category: Counter[str] = Counter()
    match_counts_by_combo: Counter[str] = Counter()
    rule_match_counts: Counter[str] = Counter()
    rule_match_rows: dict[str, int] = {str(rule.raw.get("id") or ""): 0 for rule in rules}
    rule_metadata: dict[str, dict[str, Any]] = {
        str(rule.raw.get("id") or ""): {
            "id": rule.raw.get("id"),
            "name": rule.raw.get("name"),
            "type": rule.raw.get("type"),
            "category": rule.raw.get("category"),
            "new_category": rule.raw.get("new_category"),
            "opt_out": rule.raw.get("opt_out"),
            "subcategory": rule.raw.get("subcategory"),
            "action": rule.raw.get("action"),
            "classification_status": rule.raw.get("classification_status"),
            "original_pattern_or_condition": rule.raw.get("original_pattern_or_condition"),
            "inventory_index": rule.raw.get("inventory_index"),
        }
        for rule in rules
    }

    with batch_path.open("r", encoding="utf-8-sig", errors="replace", newline="") as in_file:
        reader = csv.DictReader(in_file)
        if reader.fieldnames is None:
            raise ValueError(f"{batch_path} has no CSV header")

        extra_fields = [
            "RULE_MATCHED",
            "RULE_MATCH_COUNT",
            "TOP_PREDICTION",
            "TOP_CATEGORY",
            "TOP_NEW_CATEGORY",
            "TOP_OPT_OUT",
            "TOP_SUBCATEGORY",
            "TOP_ACTION",
            "FIRST_RULE_ID",
            "FIRST_RULE_NAME",
            "FIRST_RULE_TYPE",
            "FIRST_RULE_MATCH_TARGET",
            "FIRST_RULE_NORMALIZATION",
            "MATCHED_RULES",
            "MATCHED_RULE_IDS",
            "MATCHED_RULE_NAMES",
            "MATCHED_RULE_CATEGORIES",
            "MATCHED_RULE_NEW_CATEGORIES",
            "MATCHED_RULE_SUBCATEGORIES",
            "MATCHED_RULE_DETAILS",
        ]
        output_fields = list(reader.fieldnames) + extra_fields

        with output_path.open("w", encoding="utf-8", newline="") as out_file, matched_output_path.open(
            "w", encoding="utf-8", newline=""
        ) as matched_file:
            writer = csv.DictWriter(out_file, fieldnames=output_fields, extrasaction="ignore")
            matched_writer = csv.DictWriter(matched_file, fieldnames=output_fields, extrasaction="ignore")
            writer.writeheader()
            matched_writer.writeheader()

            total_rows = min(count_csv_data_rows(batch_path), limit) if limit is not None else count_csv_data_rows(batch_path)
            progress = None
            if show_progress and tqdm is not None:
                progress = tqdm(total=total_rows, unit="row", desc="Applying rules", dynamic_ncols=True)
            elif show_progress:
                print("Applying rules...", file=sys.stderr)

            if workers <= 1:
                for row in reader:
                    rows_read += 1
                    if progress is not None:
                        progress.update(1)
                    row, matches = annotate_row(row, rules, max_matches_per_row)
                    if matches:
                        rows_matched += 1
                        row_bit = 1 << (rows_read - 1)
                        for match in matches:
                            rule_id = str(match.get("id") or "")
                            rule_match_counts[rule_id] += 1
                            rule_match_rows[rule_id] |= row_bit
                            category = str(match.get("category") or "")
                            match_counts_by_category[category] = match_counts_by_category.get(category, 0) + 1
                            new_category = str(match.get("new_category") or "")
                            subcategory = str(match.get("subcategory") or "")
                            match_counts_by_new_category[new_category] += 1
                            match_counts_by_combo[f"{display_category(new_category)} / {display_category(subcategory)}"] += 1

                    if matches or not matched_only:
                        writer.writerow(row)
                        rows_written += 1
                        if matches:
                            matched_writer.writerow(row)
                            matched_rows_written += 1

                    if limit is not None and rows_read >= limit:
                        break
            else:
                def chunked_rows():
                    next_index = 1
                    chunk: list[dict[str, str]] = []
                    for row in reader:
                        chunk.append(row)
                        if len(chunk) >= chunk_size:
                            yield next_index, chunk, max_matches_per_row
                            next_index += len(chunk)
                            chunk = []
                        if limit is not None and next_index + len(chunk) > limit:
                            break
                    if chunk:
                        yield next_index, chunk, max_matches_per_row

                with ProcessPoolExecutor(max_workers=workers, initializer=init_worker, initargs=(rules,)) as executor:
                    for (
                        _start_index,
                        chunk_results,
                        chunk_rule_match_counts,
                        chunk_rule_match_rows,
                        chunk_match_counts_by_category,
                        chunk_match_counts_by_new_category,
                        chunk_match_counts_by_combo,
                    ) in executor.map(process_row_chunk, chunked_rows()):
                        for row_number, row, matches in chunk_results:
                            rows_read = row_number
                            if matches:
                                rows_matched += 1
                            if matches or not matched_only:
                                writer.writerow(row)
                                rows_written += 1
                                if matches:
                                    matched_writer.writerow(row)
                                    matched_rows_written += 1

                        rule_match_counts.update(chunk_rule_match_counts)
                        for rule_id, row_bits in chunk_rule_match_rows.items():
                            rule_match_rows[rule_id] = rule_match_rows.get(rule_id, 0) | row_bits
                        for category, count in chunk_match_counts_by_category.items():
                            match_counts_by_category[category] = match_counts_by_category.get(category, 0) + count
                        match_counts_by_new_category.update(chunk_match_counts_by_new_category)
                        match_counts_by_combo.update(chunk_match_counts_by_combo)
                        if progress is not None:
                            progress.update(len(chunk_results))
            if progress is not None:
                progress.close()

    return {
        "rows_read": rows_read,
        "rows_written": rows_written,
        "matched_rows_written": matched_rows_written,
        "rows_matched": rows_matched,
        "match_counts_by_category": dict(sorted(match_counts_by_category.items())),
        "match_counts_by_new_category": dict(sorted(match_counts_by_new_category.items())),
        "match_counts_by_new_category_subcategory": dict(sorted(match_counts_by_combo.items())),
        "rule_match_counts": dict(sorted(rule_match_counts.items())),
        "rule_match_rows": rule_match_rows,
        "rule_metadata": rule_metadata,
    }


def build_analysis(
    *,
    all_rules: list[dict[str, Any]],
    runnable_rules: list[RunnableRule],
    skipped_rules: list[dict[str, str]],
    batch_summary: dict[str, Any],
) -> dict[str, Any]:
    rule_match_counts: dict[str, int] = batch_summary["rule_match_counts"]
    rule_match_rows: dict[str, int] = batch_summary["rule_match_rows"]
    rule_metadata: dict[str, dict[str, Any]] = batch_summary["rule_metadata"]

    all_categories = sorted({str(rule.get("new_category") or "") for rule in all_rules if rule.get("new_category")})
    all_combos = sorted(
        {
            (str(rule.get("new_category") or ""), str(rule.get("subcategory") or ""))
            for rule in all_rules
            if rule.get("new_category") or rule.get("subcategory")
        }
    )

    applied_rule_ids = sorted(rule_id for rule_id, count in rule_match_counts.items() if count > 0)
    unapplied_rule_ids = sorted(rule_id for rule_id, count in rule_match_counts.items() if count == 0)

    category_applied_counts: Counter[str] = Counter()
    combo_applied_counts: Counter[tuple[str, str]] = Counter()
    for rule_id in applied_rule_ids:
        meta = rule_metadata.get(rule_id, {})
        new_category = str(meta.get("new_category") or "")
        subcategory = str(meta.get("subcategory") or "")
        category_applied_counts[new_category] += 1
        combo_applied_counts[(new_category, subcategory)] += 1

    missing_categories = [
        category
        for category in all_categories
        if category_applied_counts.get(category, 0) == 0
    ]
    missing_category_subcategories = [
        {
            "new_category": category,
            "subcategory": subcategory,
        }
        for category, subcategory in all_combos
        if combo_applied_counts.get((category, subcategory), 0) == 0
    ]

    grouped: dict[tuple[str, str], list[str]] = defaultdict(list)
    for rule in runnable_rules:
        rule_id = str(rule.raw.get("id") or "")
        count = rule_match_counts.get(rule_id, 0)
        if count <= 0:
            continue
        new_category = str(rule.raw.get("new_category") or "")
        subcategory = str(rule.raw.get("subcategory") or "")
        if not new_category and not subcategory:
            continue
        grouped[(new_category, subcategory)].append(rule_id)

    removable: list[dict[str, Any]] = []
    for (new_category, subcategory), rule_ids in sorted(grouped.items()):
        ordered = sorted(
            rule_ids,
            key=lambda rule_id: (
                rule_match_counts.get(rule_id, 0),
                int(rule_metadata.get(rule_id, {}).get("inventory_index") or 0),
                rule_id,
            ),
        )
        for candidate_id in ordered:
            candidate_rows = rule_match_rows.get(candidate_id, 0)
            candidate_count = rule_match_counts.get(candidate_id, 0)
            candidate_index = int(rule_metadata.get(candidate_id, {}).get("inventory_index") or 0)
            covering_id = ""
            for other_id in sorted(
                rule_ids,
                key=lambda rule_id: (
                    -rule_match_counts.get(rule_id, 0),
                    int(rule_metadata.get(rule_id, {}).get("inventory_index") or 0),
                    rule_id,
                ),
            ):
                if other_id == candidate_id:
                    continue
                other_count = rule_match_counts.get(other_id, 0)
                other_index = int(rule_metadata.get(other_id, {}).get("inventory_index") or 0)
                if other_count < candidate_count:
                    continue
                if other_count == candidate_count and other_index > candidate_index:
                    continue
                if candidate_rows & ~rule_match_rows.get(other_id, 0) == 0:
                    covering_id = other_id
                    break
            if not covering_id:
                continue
            candidate_meta = rule_metadata.get(candidate_id, {})
            covering_meta = rule_metadata.get(covering_id, {})
            removable.append(
                {
                    "remove_rule_id": candidate_id,
                    "remove_rule_name": candidate_meta.get("name", ""),
                    "covered_by_rule_id": covering_id,
                    "covered_by_rule_name": covering_meta.get("name", ""),
                    "new_category": new_category,
                    "subcategory": subcategory,
                    "remove_rule_match_count": candidate_count,
                    "covering_rule_match_count": rule_match_counts.get(covering_id, 0),
                    "reason": "all rows matched by remove_rule were also matched by covered_by_rule in this batch",
                }
            )

    per_rule = []
    for rule_id, meta in sorted(
        rule_metadata.items(),
        key=lambda item: int(item[1].get("inventory_index") or 0),
    ):
        per_rule.append(
            {
                **meta,
                "match_count": rule_match_counts.get(rule_id, 0),
                "applied_to_batch": rule_match_counts.get(rule_id, 0) > 0,
            }
        )

    unclassified_rules = [
        {
            "id": rule.get("id"),
            "name": rule.get("name"),
            "type": rule.get("type"),
            "category": rule.get("category"),
            "original_pattern_or_condition": rule.get("original_pattern_or_condition"),
        }
        for rule in all_rules
        if not rule.get("new_category") and not rule.get("subcategory")
    ]

    return {
        "rows_read": batch_summary["rows_read"],
        "rows_matched": batch_summary["rows_matched"],
        "runnable_rule_count": len(runnable_rules),
        "skipped_rule_count": len(skipped_rules),
        "rules_applied_to_batch_count": len(applied_rule_ids),
        "rules_not_applied_to_batch_count": len(unapplied_rule_ids),
        "removable_rule_count": len(removable),
        "removable_rules": removable,
        "missing_new_categories_count": len(missing_categories),
        "missing_new_categories": missing_categories,
        "missing_new_category_subcategories_count": len(missing_category_subcategories),
        "missing_new_category_subcategories": missing_category_subcategories,
        "match_counts_by_new_category": batch_summary["match_counts_by_new_category"],
        "match_counts_by_new_category_subcategory": batch_summary["match_counts_by_new_category_subcategory"],
        "rules_applied_by_new_category": dict(sorted(category_applied_counts.items())),
        "rules_applied_by_new_category_subcategory": {
            f"{display_category(category)} / {display_category(subcategory)}": count
            for (category, subcategory), count in sorted(combo_applied_counts.items())
        },
        "classification": {
            "source": "json_inventory",
            "unclassified_rule_count": len(unclassified_rules),
            "unclassified_rules": unclassified_rules,
        },
        "per_rule": per_rule,
    }


def write_summary(path: Path, summary: dict[str, Any]) -> None:
    path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_rows_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_analysis_csvs(analysis_path: Path, analysis: dict[str, Any]) -> dict[str, str]:
    stem = analysis_path.with_suffix("")
    removable_path = stem.with_name(stem.name + ".removable_rules.csv")
    per_rule_path = stem.with_name(stem.name + ".per_rule.csv")
    missing_combo_path = stem.with_name(stem.name + ".missing_category_subcategories.csv")

    write_rows_csv(
        removable_path,
        analysis["removable_rules"],
        [
            "remove_rule_id",
            "remove_rule_name",
            "covered_by_rule_id",
            "covered_by_rule_name",
            "new_category",
            "subcategory",
            "remove_rule_match_count",
            "covering_rule_match_count",
            "reason",
        ],
    )
    write_rows_csv(
        per_rule_path,
        analysis["per_rule"],
        [
            "id",
            "name",
            "type",
            "category",
            "new_category",
            "opt_out",
            "subcategory",
            "action",
            "classification_status",
            "original_pattern_or_condition",
            "inventory_index",
            "match_count",
            "applied_to_batch",
        ],
    )
    write_rows_csv(
        missing_combo_path,
        analysis["missing_new_category_subcategories"],
        ["new_category", "subcategory"],
    )
    return {
        "removable_rules_csv": str(removable_path),
        "per_rule_csv": str(per_rule_path),
        "missing_category_subcategories_csv": str(missing_combo_path),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    output_dir = root / DEFAULT_OUTPUT_DIRNAME
    parser = argparse.ArgumentParser(
        description="Apply combined opt-out rules to opt_out_batch.csv and write an annotated CSV."
    )
    parser.add_argument("--inventory", type=Path, default=root / DEFAULT_INVENTORY_FILENAME)
    parser.add_argument("--batch", type=Path, default=root / DEFAULT_BATCH_FILENAME)
    parser.add_argument("--output", type=Path, default=output_dir / DEFAULT_OUTPUT_FILENAME)
    parser.add_argument("--matched-output", type=Path, default=output_dir / DEFAULT_MATCHED_OUTPUT_FILENAME)
    parser.add_argument("--summary", type=Path, default=output_dir / DEFAULT_SUMMARY_FILENAME)
    parser.add_argument("--analysis", type=Path, default=output_dir / DEFAULT_ANALYSIS_FILENAME)
    parser.add_argument(
        "--write-analysis",
        action="store_true",
        help="Write the legacy summary and analysis artifacts in addition to the classified and matched CSVs.",
    )
    parser.add_argument(
        "--matched-only",
        action="store_true",
        help="Also make --output contain only matched rows; --matched-output is always matched-only.",
    )
    parser.add_argument("--limit", type=int, default=None, help="Process only the first N rows for a smoke run.")
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Number of worker processes for row matching; 1 keeps the serial path.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=500,
        help="Rows per worker task when --workers is greater than 1.",
    )
    parser.add_argument(
        "--max-matches-per-row",
        type=int,
        default=0,
        help="Limit serialized match lists per row; 0 means include every matched rule.",
    )
    parser.add_argument("--no-progress", action="store_true", help="Disable the tqdm progress bar.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.workers < 1:
        raise ValueError("--workers must be at least 1")
    if args.chunk_size < 1:
        raise ValueError("--chunk-size must be at least 1")

    rules, skipped, all_rules = load_runnable_rules(args.inventory)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.matched_output.parent.mkdir(parents=True, exist_ok=True)

    batch_summary = process_batch(
        args.batch,
        args.output,
        args.matched_output,
        rules,
        matched_only=args.matched_only,
        limit=args.limit,
        max_matches_per_row=args.max_matches_per_row,
        show_progress=not args.no_progress,
        workers=args.workers,
        chunk_size=args.chunk_size,
    )
    analysis: dict[str, Any] | None = None
    if args.write_analysis:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.analysis.parent.mkdir(parents=True, exist_ok=True)
        analysis = build_analysis(
            all_rules=all_rules,
            runnable_rules=rules,
            skipped_rules=skipped,
            batch_summary=batch_summary,
        )
        analysis_csvs = write_analysis_csvs(args.analysis, analysis)
        analysis["csv_outputs"] = analysis_csvs
        write_summary(args.analysis, analysis)

        summary_batch_fields = {
            key: value
            for key, value in batch_summary.items()
            if key not in {"rule_match_rows", "rule_metadata"}
        }
        summary = {
            "inventory": str(args.inventory),
            "batch": str(args.batch),
            "output": str(args.output),
            "matched_output": str(args.matched_output),
            "analysis": str(args.analysis),
            **analysis_csvs,
            "runnable_rule_count": len(rules),
            "skipped_rule_count": len(skipped),
            "skipped_rules": skipped,
            **summary_batch_fields,
        }
        write_summary(args.summary, summary)

    print(f"Runnable rules: {len(rules)}")
    print(f"Skipped rules: {len(skipped)}")
    print(f"Rows read: {batch_summary['rows_read']}")
    print(f"Rows matched: {batch_summary['rows_matched']}")
    print(
        "Rules applied to batch: "
        f"{sum(1 for count in batch_summary['rule_match_counts'].values() if count > 0)}"
    )
    print(f"Output: {args.output}")
    print(f"Matched rows output: {args.matched_output}")
    if analysis is not None:
        print(f"Summary: {args.summary}")
        print(f"Analysis: {args.analysis}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
