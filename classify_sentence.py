#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import unicodedata
import sys
from pathlib import Path

import run_deterministic_rules as deterministic


def default_inventory_path() -> Path:
    root = Path(__file__).resolve().parent
    extension_inventory = root / "highlighter" / "data" / "rules" / "opt_out_deterministic_rules.json"
    if extension_inventory.exists():
        return extension_inventory
    return root / deterministic.DEFAULT_INVENTORY_FILENAME


def read_message(args: argparse.Namespace) -> str:
    if args.message:
        return " ".join(args.message).strip()
    if not sys.stdin.isatty():
        return sys.stdin.read().strip()
    return input("Message: ").strip()


ASCII_WORD_CHAR_RE = re.compile(r"[0-9a-z]")


def classify_message(message: str, brand_message: str, inventory_path: Path) -> tuple[dict[str, str], str]:
    rules, _skipped, _all_rules = deterministic.load_runnable_rules(inventory_path)
    row = {
        "CUSTOMER_MESSAGE": message,
        "BRAND_MESSAGE": brand_message,
    }
    annotated, _matches = deterministic.annotate_row(row, rules, max_matches_per_row=1)
    matched_rule = next((rule for rule in rules if deterministic.is_match(rule, row)), None)
    matched_text = matched_text_for_rule(matched_rule, row) if matched_rule else ""
    return annotated, matched_text


def matched_text_for_rule(rule: deterministic.RunnableRule | None, row: dict[str, str]) -> str:
    if rule is None:
        return ""

    raw_text = deterministic.select_raw_text(row, rule.raw)
    scope = str(rule.raw.get("match_scope") or "").casefold()
    rule_type = str(rule.raw.get("type") or "")

    if rule_type == "symbol_set":
      return str(rule.pattern) if str(rule.pattern) in raw_text else raw_text.strip()

    if is_procedural_rule(rule):
        return raw_text.strip()

    normalized_text, normalized_to_raw = normalize_with_mapping(raw_text)
    exact_match = (
        rule.subcategory in deterministic.EXACT_MATCH_SUBCATEGORIES
        or str(rule.raw.get("id") or "") in deterministic.EXACT_MATCH_RULE_IDS
        or "full" in scope
        or "whole" in scope
        or "exact" in scope
    )

    if rule.regex is not None:
        if "raw" in scope:
            match = rule.regex.fullmatch(raw_text) if exact_match else rule.regex.search(raw_text)
            return trim_match(raw_text, match.start(), match.end()) if match else raw_text.strip()

        match = rule.regex.fullmatch(normalized_text) if exact_match else rule.regex.search(normalized_text)
        if not match:
            return raw_text.strip()
        return raw_span_from_normalized_span(raw_text, normalized_to_raw, match.start(), match.end())

    needle = rule.normalized_pattern
    if not needle:
        return raw_text.strip()
    start = 0 if exact_match and normalized_text == needle else normalized_text.find(needle)
    if start < 0:
        return raw_text.strip()
    return raw_span_from_normalized_span(raw_text, normalized_to_raw, start, start + len(needle))


def is_procedural_rule(rule: deterministic.RunnableRule) -> bool:
    name = str(rule.raw.get("name") or "")
    return name in {
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
    }


def normalize_with_mapping(value: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    raw_indexes: list[int] = []
    pending_space_index: int | None = None

    for raw_index, raw_char in enumerate(value or ""):
        if deterministic.ZERO_WIDTH_RE.match(raw_char):
            continue
        for char in fold_char(raw_char):
            if char in {"'", "`"}:
                continue
            if ASCII_WORD_CHAR_RE.fullmatch(char):
                if pending_space_index is not None and chars:
                    chars.append(" ")
                    raw_indexes.append(pending_space_index)
                pending_space_index = None
                chars.append(char)
                raw_indexes.append(raw_index)
            elif chars:
                pending_space_index = raw_index

    return "".join(chars).strip(), raw_indexes[: len(chars)]


def fold_char(char: str) -> str:
    text = unicodedata.normalize("NFKC", char)
    text = text.translate(deterministic.STYLIZED_CHAR_MAP)
    text = unicodedata.normalize("NFKD", text)
    text = deterministic.COMBINING_MARK_RE.sub("", text)
    text = unicodedata.normalize("NFKC", text)
    return text.casefold()


def raw_span_from_normalized_span(raw_text: str, normalized_to_raw: list[int], start: int, end: int) -> str:
    if not normalized_to_raw or start >= len(normalized_to_raw):
        return raw_text.strip()
    start = max(0, start)
    end = min(len(normalized_to_raw), max(start + 1, end))
    raw_start = normalized_to_raw[start]
    raw_end = normalized_to_raw[end - 1] + 1
    return trim_match(raw_text, raw_start, raw_end)


def trim_match(raw_text: str, start: int, end: int) -> str:
    value = raw_text[start:end].strip()
    return value.strip(" \t\r\n.,!?;:\"'`()[]{}<>")


def print_result(result: dict[str, str], matched_text: str) -> None:
    if result.get("RULE_MATCHED") != "1":
        print("Matched: no")
        print("Matched text:")
        print("Category:")
        print("Subcategory:")
        print("Action:")
        return

    category = result.get("TOP_NEW_CATEGORY") or result.get("TOP_CATEGORY") or ""
    print("Matched: yes")
    print(f"Matched text: {matched_text}")
    print(f"Category: {category}")
    print(f"Subcategory: {result.get('TOP_SUBCATEGORY', '')}")
    print(f"Action: {result.get('TOP_ACTION', '')}")
    print(f"Rule ID: {result.get('FIRST_RULE_ID', '')}")
    print(f"Rule name: {result.get('FIRST_RULE_NAME', '')}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Classify one sentence with the deterministic opt-out rule inventory."
    )
    parser.add_argument("message", nargs="*", help="Message text to classify. If omitted, reads stdin or prompts.")
    parser.add_argument(
        "--brand-message",
        default="",
        help="Optional brand/outbound message context for rules that require BRAND_MESSAGE + CUSTOMER_MESSAGE.",
    )
    parser.add_argument(
        "--inventory",
        type=Path,
        default=default_inventory_path(),
        help="Path to opt_out_deterministic_rules.json.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    message = read_message(args)
    if not message:
        print("No message provided.", file=sys.stderr)
        return 2
    if not args.inventory.exists():
        print(f"Inventory not found: {args.inventory}", file=sys.stderr)
        return 2

    result, matched_text = classify_message(message, args.brand_message, args.inventory)
    print_result(result, matched_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
