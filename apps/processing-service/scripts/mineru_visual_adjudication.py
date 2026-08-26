"""Build and validate bounded AI-adjudication contracts for MinerU visuals.

This module is deliberately deterministic.  It never calls a model, reads a
paper, crops a PDF, or edits MinerU output.  It only derives a compact candidate
packet from ``viewer-index.json`` and ``visual-repair.json`` and validates a
strict model response against that packet.

The intended integration is fail-closed and non-blocking:

* a model may accept, reject, or abstain on an existing candidate ID;
* a model may not supply block IDs, coordinates, paths, or source prose;
* invalid or stale output produces validation errors and zero unsafe decisions;
* callers can always keep the deterministic repair/fallback unchanged.
"""

from __future__ import annotations

# Extracted from Research Agent Reader's companion workflow (MIT, Copyright 2026 Liao Li).

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Iterable


VISUAL_CANDIDATE_SCHEMA_VERSION = 1
VISUAL_ADJUDICATION_SCHEMA_VERSION = 1
VISUAL_CANDIDATE_CONTRACT = "mineru-visual-candidates"
VISUAL_ADJUDICATION_CONTRACT = "mineru-visual-adjudication"
DEFAULT_MINIMUM_ACCEPT_CONFIDENCE = 0.85

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,200}$")
SAFE_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,119}$")
FIGURE_KEY_RE = re.compile(
    r"^(?:figure|extended-data-figure|supplementary-figure|supporting-figure|图):"
    r"[a-z0-9]+(?:[_-][a-z0-9]+)*$"
)
SAFE_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/@+\-]{0,199}$")

ALLOWED_VERDICTS = ("accept", "reject", "abstain")
SOURCE_BINDING_KEYS = {
    "article",
    "mineru_result",
    "viewer_index_sha256",
    "visual_repair_sha256",
}
HASH_RECORD_KEYS = {"sha256"}
PACKAGE_KEYS = {
    "schema_version",
    "contract",
    "status",
    "inputs",
    "policy",
    "candidates",
    "issues",
    "candidate_package_sha256",
}
POLICY_KEYS = {"allowed_verdicts", "minimum_accept_confidence"}
RESPONSE_KEYS = {
    "schema_version",
    "contract",
    "candidate_package_sha256",
    "inputs",
    "model_id",
    "prompt_version",
    "decisions",
}
DECISION_KEYS = {"candidate_id", "verdict", "confidence"}

FRAGMENT_KEYS = {
    "candidate_id",
    "kind",
    "review_state",
    "repair_group_id",
    "page_idx",
    "member_block_ids",
    "replacement_mode",
    "base_confidence",
    "evidence",
}
CAPTION_KEYS = {
    "candidate_id",
    "kind",
    "review_state",
    "visual_block_id",
    "source_page_idx",
    "target_page_idx",
    "figure_key",
    "caption_block_ids",
    "evidence",
}
FRAGMENT_EVIDENCE_KEYS = {
    "member_geometry",
    "caption_anchor_block_ids",
    "signals",
    "reason_codes",
    "warning_codes",
}
CAPTION_EVIDENCE_KEYS = {
    "source_geometry",
    "caption_geometry",
    "source_caption_summary",
    "caption_text_summaries",
    "issue_code",
}

SIGNAL_KEYS = {
    "member_count",
    "representative_count",
    "adjacent_pair_count",
    "caption_char_count",
    "long_caption_anchor_count",
    "figure_caption_anchor_count",
    "panel_label_count",
    "markdown_references_contiguous",
    "markdown_reference_coverage",
    "max_markdown_gap_chars",
    "union_area_fraction",
    "caption_anchored_component_count",
}
SUMMARY_KEYS = {
    "char_count",
    "item_count",
    "figure_keys",
    "leading_figure_key",
    "formal_figure_caption_keys",
    "leading_formal_figure_caption_key",
    "next_page_marker",
    "next_page_figure_keys",
    "next_page_reference_count",
    "starts_with_lowercase",
    "starts_with_panel_label",
    "ends_with_terminal_punctuation",
}


def canonical_json_bytes(value: Any) -> bytes:
    """Return the canonical UTF-8 JSON representation used by this contract."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    """Hash a JSON-compatible value using the contract's canonical encoding."""

    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def candidate_package_sha256(payload: dict[str, Any]) -> str:
    """Recompute a package digest without its self-referential digest field."""

    material = dict(payload)
    material.pop("candidate_package_sha256", None)
    return canonical_sha256(material)


def _error(code: str, path: str, message: str) -> dict[str, str]:
    return {"code": code, "path": path, "message": message}


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and bool(SHA256_RE.fullmatch(value.lower()))


def _valid_number(value: Any, *, minimum: float, maximum: float) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
        and minimum <= float(value) <= maximum
    )


def _normalize_hash(value: Any) -> str:
    return value.lower() if _is_sha256(value) else ""


def _input_hash(payload: dict[str, Any], name: str) -> str:
    inputs = payload.get("inputs")
    if not isinstance(inputs, dict):
        return ""
    record = inputs.get(name)
    if not isinstance(record, dict):
        return ""
    return _normalize_hash(record.get("sha256"))


def _required_input_hash(
    payload: dict[str, Any], name: str
) -> tuple[str, str | None]:
    """Return a required input hash and distinguish missing from malformed data."""

    inputs = payload.get("inputs")
    if not isinstance(inputs, dict):
        return "", "missing"
    record = inputs.get(name)
    if not isinstance(record, dict) or "sha256" not in record:
        return "", "missing"
    raw_hash = record.get("sha256")
    if raw_hash is None or raw_hash == "":
        return "", "missing"
    if not _is_sha256(raw_hash):
        return "", "invalid"
    return str(raw_hash).lower(), None


def _source_bindings(
    viewer_index: dict[str, Any], visual_repair: dict[str, Any]
) -> dict[str, Any]:
    return {
        "article": {"sha256": _input_hash(viewer_index, "article")},
        "mineru_result": {"sha256": _input_hash(viewer_index, "mineru_result")},
        "viewer_index_sha256": canonical_sha256(viewer_index),
        "visual_repair_sha256": canonical_sha256(visual_repair),
    }


def _safe_id(value: Any) -> str | None:
    normalized = str(value or "").strip()
    return normalized if SAFE_ID_RE.fullmatch(normalized) else None


def _safe_figure_key(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    return normalized if FIGURE_KEY_RE.fullmatch(normalized) else None


def _safe_codes(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return sorted(
        {
            normalized
            for value in values
            if (normalized := str(value or "").strip().lower())
            and SAFE_CODE_RE.fullmatch(normalized)
        }
    )


def _safe_ids(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        normalized = _safe_id(value)
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def _safe_bbox(value: Any) -> list[int | float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    coordinates: list[float] = []
    for item in value:
        if not _valid_number(item, minimum=0, maximum=1000):
            return None
        coordinates.append(float(item))
    if coordinates[2] <= coordinates[0] or coordinates[3] <= coordinates[1]:
        return None
    return [int(item) if item.is_integer() else round(item, 6) for item in coordinates]


def _safe_signals(value: Any) -> dict[str, int | float | bool | None]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int | float | bool | None] = {}
    for key in sorted(SIGNAL_KEYS):
        item = value.get(key)
        if item is None or isinstance(item, bool):
            result[key] = item
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            if math.isfinite(float(item)):
                result[key] = item
    return result


def _safe_summary(value: Any) -> dict[str, Any]:
    """Whitelist structural caption metadata and intentionally omit source prose."""

    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for key in sorted(SUMMARY_KEYS):
        item = value.get(key)
        if key in {
            "figure_keys",
            "formal_figure_caption_keys",
            "next_page_figure_keys",
        }:
            keys = [key_value for raw in item if (key_value := _safe_figure_key(raw))] if isinstance(item, list) else []
            result[key] = list(dict.fromkeys(keys))
        elif key in {"leading_figure_key", "leading_formal_figure_caption_key"}:
            normalized = _safe_figure_key(item)
            if normalized:
                result[key] = normalized
        elif key in {
            "next_page_marker",
            "starts_with_lowercase",
            "starts_with_panel_label",
            "ends_with_terminal_punctuation",
        }:
            if isinstance(item, bool):
                result[key] = item
        elif key in {"char_count", "item_count", "next_page_reference_count"}:
            if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
                result[key] = item
    return result


def _page_and_block_maps(
    viewer_index: dict[str, Any],
) -> tuple[dict[int, list[dict[str, Any]]], dict[str, tuple[int, dict[str, Any]]]]:
    pages: dict[int, list[dict[str, Any]]] = {}
    blocks: dict[str, tuple[int, dict[str, Any]]] = {}
    raw_pages = viewer_index.get("pages")
    if not isinstance(raw_pages, list):
        return pages, blocks
    for page in raw_pages:
        if not isinstance(page, dict):
            continue
        page_idx = page.get("page_idx")
        raw_blocks = page.get("blocks")
        if (
            isinstance(page_idx, bool)
            or not isinstance(page_idx, int)
            or page_idx < 0
            or not isinstance(raw_blocks, list)
        ):
            continue
        valid_blocks = [block for block in raw_blocks if isinstance(block, dict)]
        pages[page_idx] = valid_blocks
        for block in valid_blocks:
            block_id = _safe_id(block.get("id"))
            if block_id:
                blocks[block_id] = (page_idx, block)
    return pages, blocks


def _geometry(
    block_id: str, blocks: dict[str, tuple[int, dict[str, Any]]]
) -> dict[str, Any] | None:
    located = blocks.get(block_id)
    if located is None:
        return None
    page_idx, block = located
    bbox = _safe_bbox(block.get("bbox_norm"))
    page_order = block.get("page_order")
    if bbox is None or isinstance(page_order, bool) or not isinstance(page_order, int):
        return None
    return {
        "block_id": block_id,
        "page_idx": page_idx,
        "page_order": page_order,
        "bbox_norm": bbox,
        "role": str(block.get("role") or "other")
        if str(block.get("role") or "other")
        in {"text", "title", "visual", "table", "equation", "discarded", "other"}
        else "other",
    }


def _candidate_id(
    candidate_without_id: dict[str, Any], inputs: dict[str, Any]
) -> str:
    kind = candidate_without_id.get("kind")
    prefix = "fragment" if kind == "fragment_group" else "caption"
    digest = canonical_sha256(
        {
            "schema_version": VISUAL_CANDIDATE_SCHEMA_VERSION,
            "inputs": inputs,
            "candidate": candidate_without_id,
        }
    )
    return f"{prefix}-{digest[:24]}"


def _with_candidate_id(
    candidate: dict[str, Any], inputs: dict[str, Any]
) -> dict[str, Any]:
    return {"candidate_id": _candidate_id(candidate, inputs), **candidate}


def _fragment_candidate(
    group: dict[str, Any],
    blocks: dict[str, tuple[int, dict[str, Any]]],
    inputs: dict[str, Any],
) -> dict[str, Any] | None:
    if group.get("decision") != "review":
        return None
    group_id = _safe_id(group.get("id"))
    page_idx = group.get("page_idx")
    member_ids = _safe_ids(group.get("member_block_ids"))
    if (
        group_id is None
        or isinstance(page_idx, bool)
        or not isinstance(page_idx, int)
        or page_idx < 0
        or len(member_ids) < 2
    ):
        return None
    member_geometry = [_geometry(block_id, blocks) for block_id in member_ids]
    if any(item is None or item["page_idx"] != page_idx for item in member_geometry):
        return None
    replacement = group.get("replacement")
    mode = replacement.get("mode") if isinstance(replacement, dict) else None
    if mode not in {"pdf_crop", "existing_asset", "none"}:
        mode = "none"
    base_confidence = group.get("confidence")
    if not _valid_number(base_confidence, minimum=0, maximum=1):
        base_confidence = 0.0
    candidate = {
        "kind": "fragment_group",
        "review_state": "review",
        "repair_group_id": group_id,
        "page_idx": page_idx,
        "member_block_ids": member_ids,
        "replacement_mode": mode,
        "base_confidence": round(float(base_confidence), 6),
        "evidence": {
            "member_geometry": sorted(
                (item for item in member_geometry if item is not None),
                key=lambda item: (item["page_order"], item["block_id"]),
            ),
            "caption_anchor_block_ids": _safe_ids(
                group.get("caption_anchor_block_ids")
            ),
            "signals": _safe_signals(group.get("signals")),
            "reason_codes": _safe_codes(group.get("reason_codes")),
            "warning_codes": _safe_codes(group.get("warning_codes")),
        },
    }
    return _with_candidate_id(candidate, inputs)


def _caption_candidate(
    *,
    review_state: str,
    visual_block_id: str,
    source_page_idx: int,
    target_page_idx: int,
    figure_key: str,
    caption_block_ids: list[str],
    issue_code: str,
    blocks: dict[str, tuple[int, dict[str, Any]]],
    inputs: dict[str, Any],
) -> dict[str, Any] | None:
    source_geometry = _geometry(visual_block_id, blocks)
    caption_geometry = [_geometry(block_id, blocks) for block_id in caption_block_ids]
    if (
        source_geometry is None
        or source_geometry["page_idx"] != source_page_idx
        or source_geometry["role"] != "visual"
        or target_page_idx != source_page_idx + 1
        or not caption_block_ids
        or any(item is None or item["page_idx"] != target_page_idx for item in caption_geometry)
    ):
        return None
    source_block = blocks[visual_block_id][1]
    caption_summaries = [
        _safe_summary(blocks[block_id][1].get("text"))
        for block_id in caption_block_ids
    ]
    candidate = {
        "kind": "cross_page_caption",
        "review_state": review_state,
        "visual_block_id": visual_block_id,
        "source_page_idx": source_page_idx,
        "target_page_idx": target_page_idx,
        "figure_key": figure_key,
        "caption_block_ids": caption_block_ids,
        "evidence": {
            "source_geometry": source_geometry,
            "caption_geometry": sorted(
                (item for item in caption_geometry if item is not None),
                key=lambda item: (item["page_order"], item["block_id"]),
            ),
            "source_caption_summary": _safe_summary(source_block.get("caption")),
            "caption_text_summaries": caption_summaries,
            "issue_code": issue_code,
        },
    }
    return _with_candidate_id(candidate, inputs)


def _partial_caption_candidates(
    visual_repair: dict[str, Any],
    blocks: dict[str, tuple[int, dict[str, Any]]],
    inputs: dict[str, Any],
) -> Iterable[dict[str, Any]]:
    links = visual_repair.get("caption_links")
    if not isinstance(links, list):
        return []
    result: list[dict[str, Any]] = []
    for link in links:
        if not isinstance(link, dict) or link.get("status") != "partial":
            continue
        visual_id = _safe_id(link.get("visual_block_id"))
        source_page = link.get("source_page_idx")
        target_page = link.get("target_page_idx")
        figure_key = _safe_figure_key(link.get("figure_key"))
        caption_ids = _safe_ids(link.get("caption_block_ids"))
        if (
            visual_id is None
            or figure_key is None
            or isinstance(source_page, bool)
            or not isinstance(source_page, int)
            or isinstance(target_page, bool)
            or not isinstance(target_page, int)
        ):
            continue
        candidate = _caption_candidate(
            review_state="partial",
            visual_block_id=visual_id,
            source_page_idx=source_page,
            target_page_idx=target_page,
            figure_key=figure_key,
            caption_block_ids=caption_ids,
            issue_code="partial_next_page_figure_caption",
            blocks=blocks,
            inputs=inputs,
        )
        if candidate:
            result.append(candidate)
    return result


def _formal_keys(block: dict[str, Any]) -> set[str]:
    summary = block.get("text")
    if not isinstance(summary, dict):
        return set()
    keys: set[str] = set()
    leading = _safe_figure_key(summary.get("leading_formal_figure_caption_key"))
    if leading:
        keys.add(leading)
    values = summary.get("formal_figure_caption_keys")
    if isinstance(values, list):
        keys.update(key for raw in values if (key := _safe_figure_key(raw)))
    return keys


def _ambiguous_caption_candidates(
    viewer_index: dict[str, Any],
    visual_repair: dict[str, Any],
    pages: dict[int, list[dict[str, Any]]],
    blocks: dict[str, tuple[int, dict[str, Any]]],
    inputs: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    del viewer_index  # all required data is already represented by pages/blocks
    raw_issues = visual_repair.get("issues")
    if not isinstance(raw_issues, list):
        return [], []
    candidates: list[dict[str, Any]] = []
    build_issues: list[str] = []
    for issue in raw_issues:
        if not isinstance(issue, dict):
            continue
        issue_code = str(issue.get("code") or "").strip().lower()
        if not issue_code.startswith("ambiguous_") or not (
            "caption" in issue_code or "next_page" in issue_code
        ):
            continue
        visual_id = _safe_id(issue.get("visual_block_id"))
        located = blocks.get(visual_id or "")
        if visual_id is None or located is None:
            build_issues.append("ambiguous_caption_source_not_locatable")
            continue
        source_page = issue.get("source_page_idx")
        if isinstance(source_page, bool) or not isinstance(source_page, int):
            source_page = located[0]
        target_page = issue.get("target_page_idx")
        if isinstance(target_page, bool) or not isinstance(target_page, int):
            target_page = source_page + 1
        source_caption = located[1].get("caption")
        candidate_keys: set[str] = set()
        issue_key = _safe_figure_key(issue.get("figure_key"))
        if issue_key:
            candidate_keys.add(issue_key)
        if isinstance(source_caption, dict):
            figure_keys = {
                key
                for raw in source_caption.get("figure_keys", [])
                if (key := _safe_figure_key(raw))
            }
            marker_keys = {
                key
                for raw in source_caption.get("next_page_figure_keys", [])
                if (key := _safe_figure_key(raw))
            }
            candidate_keys.update(figure_keys & marker_keys)

        found = False
        for target_block in pages.get(target_page, []):
            anchor_id = _safe_id(target_block.get("id"))
            if not anchor_id:
                continue
            for figure_key in sorted(candidate_keys & _formal_keys(target_block)):
                candidate = _caption_candidate(
                    review_state="ambiguous",
                    visual_block_id=visual_id,
                    source_page_idx=source_page,
                    target_page_idx=target_page,
                    figure_key=figure_key,
                    caption_block_ids=[anchor_id],
                    issue_code=issue_code,
                    blocks=blocks,
                    inputs=inputs,
                )
                if candidate:
                    candidates.append(candidate)
                    found = True
        if not found:
            build_issues.append("ambiguous_caption_without_bounded_candidate")
    return candidates, sorted(set(build_issues))


def build_visual_candidates(
    viewer_index: dict[str, Any],
    visual_repair: dict[str, Any],
    *,
    minimum_accept_confidence: float = DEFAULT_MINIMUM_ACCEPT_CONFIDENCE,
) -> dict[str, Any]:
    """Build a bounded packet for review/partial/ambiguous visual decisions.

    The function consumes only the two already-derived contracts.  Structural
    metadata such as IDs, counts, and normalized boxes is whitelisted; asset
    paths and source prose are deliberately omitted.
    """

    issues: list[str] = []
    if not isinstance(viewer_index, dict) or not isinstance(visual_repair, dict):
        viewer_index = viewer_index if isinstance(viewer_index, dict) else {}
        visual_repair = visual_repair if isinstance(visual_repair, dict) else {}
        issues.append("inputs_must_be_objects")
    if not _valid_number(minimum_accept_confidence, minimum=0, maximum=1):
        minimum_accept_confidence = DEFAULT_MINIMUM_ACCEPT_CONFIDENCE
        issues.append("invalid_minimum_accept_confidence")

    inputs = _source_bindings(viewer_index, visual_repair)
    article_hash = inputs["article"]["sha256"]
    mineru_hash = inputs["mineru_result"]["sha256"]
    repair_article, repair_article_error = _required_input_hash(
        visual_repair, "article"
    )
    repair_mineru, repair_mineru_error = _required_input_hash(
        visual_repair, "mineru_result"
    )
    if not article_hash or not mineru_hash:
        issues.append("missing_viewer_input_hash")
    if repair_article_error:
        issues.append(f"visual_repair_article_hash_{repair_article_error}")
    elif repair_article != article_hash:
        issues.append("article_hash_mismatch")
    if repair_mineru_error:
        issues.append(f"visual_repair_mineru_result_hash_{repair_mineru_error}")
    elif repair_mineru != mineru_hash:
        issues.append("mineru_result_hash_mismatch")

    pages, blocks = _page_and_block_maps(viewer_index)
    candidate_by_id: dict[str, dict[str, Any]] = {}
    if not issues:
        raw_groups = visual_repair.get("groups")
        if isinstance(raw_groups, list):
            for group in raw_groups:
                if not isinstance(group, dict):
                    continue
                candidate = _fragment_candidate(group, blocks, inputs)
                if candidate:
                    candidate_by_id[candidate["candidate_id"]] = candidate
        for candidate in _partial_caption_candidates(visual_repair, blocks, inputs):
            candidate_by_id[candidate["candidate_id"]] = candidate
        ambiguous, ambiguous_issues = _ambiguous_caption_candidates(
            viewer_index, visual_repair, pages, blocks, inputs
        )
        issues.extend(ambiguous_issues)
        for candidate in ambiguous:
            candidate_by_id[candidate["candidate_id"]] = candidate

    candidates = sorted(
        candidate_by_id.values(), key=lambda item: (item["kind"], item["candidate_id"])
    )
    status = "invalid" if any(
        code
        in {
            "inputs_must_be_objects",
            "missing_viewer_input_hash",
            "visual_repair_article_hash_missing",
            "visual_repair_article_hash_invalid",
            "visual_repair_mineru_result_hash_missing",
            "visual_repair_mineru_result_hash_invalid",
            "article_hash_mismatch",
            "mineru_result_hash_mismatch",
        }
        for code in issues
    ) else "ready" if candidates else "empty"
    package: dict[str, Any] = {
        "schema_version": VISUAL_CANDIDATE_SCHEMA_VERSION,
        "contract": VISUAL_CANDIDATE_CONTRACT,
        "status": status,
        "inputs": inputs,
        "policy": {
            "allowed_verdicts": list(ALLOWED_VERDICTS),
            "minimum_accept_confidence": round(
                float(minimum_accept_confidence), 6
            ),
        },
        "candidates": candidates,
        "issues": sorted(set(issues)),
    }
    package["candidate_package_sha256"] = candidate_package_sha256(package)
    return package


def _validate_bindings_shape(value: Any, path: str) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    if not isinstance(value, dict):
        return [_error("invalid_inputs", path, "输入哈希绑定必须是对象")]
    extra = set(value) - SOURCE_BINDING_KEYS
    missing = SOURCE_BINDING_KEYS - set(value)
    if extra:
        errors.append(_error("extra_input_fields", path, "输入哈希绑定含未允许字段"))
    if missing:
        errors.append(_error("missing_input_fields", path, "输入哈希绑定缺少字段"))
    for name in ("article", "mineru_result"):
        record = value.get(name)
        if not isinstance(record, dict) or set(record) != HASH_RECORD_KEYS:
            errors.append(
                _error("invalid_input_hash_record", f"{path}.{name}", "哈希记录结构无效")
            )
            continue
        if not _is_sha256(record.get("sha256")):
            errors.append(_error("invalid_input_hash", f"{path}.{name}.sha256", "SHA-256 无效"))
    for name in ("viewer_index_sha256", "visual_repair_sha256"):
        if not _is_sha256(value.get(name)):
            errors.append(_error("invalid_input_hash", f"{path}.{name}", "SHA-256 无效"))
    return errors


def _validate_geometry(value: Any, path: str) -> list[dict[str, str]]:
    if not isinstance(value, dict):
        return [_error("invalid_geometry", path, "几何记录必须是对象")]
    allowed = {"block_id", "page_idx", "page_order", "bbox_norm", "role"}
    errors: list[dict[str, str]] = []
    if set(value) != allowed:
        errors.append(_error("invalid_geometry_fields", path, "几何记录字段不完整或含额外字段"))
    if _safe_id(value.get("block_id")) is None:
        errors.append(_error("invalid_block_id", f"{path}.block_id", "块 ID 无效"))
    if _safe_bbox(value.get("bbox_norm")) is None:
        errors.append(_error("invalid_bbox", f"{path}.bbox_norm", "标准化坐标无效"))
    for key in ("page_idx", "page_order"):
        item = value.get(key)
        if isinstance(item, bool) or not isinstance(item, int) or item < 0:
            errors.append(_error("invalid_geometry_index", f"{path}.{key}", "索引无效"))
    return errors


def _validate_candidate_shape(
    candidate: Any, index: int, inputs: dict[str, Any]
) -> list[dict[str, str]]:
    path = f"candidates[{index}]"
    if not isinstance(candidate, dict):
        return [_error("invalid_candidate", path, "候选必须是对象")]
    errors: list[dict[str, str]] = []
    kind = candidate.get("kind")
    allowed = FRAGMENT_KEYS if kind == "fragment_group" else CAPTION_KEYS if kind == "cross_page_caption" else set()
    if not allowed:
        return [_error("invalid_candidate_kind", f"{path}.kind", "候选类型无效")]
    if set(candidate) != allowed:
        errors.append(_error("invalid_candidate_fields", path, "候选字段不完整或含额外字段"))
    candidate_id = _safe_id(candidate.get("candidate_id"))
    material = dict(candidate)
    material.pop("candidate_id", None)
    expected_id = _candidate_id(material, inputs)
    if candidate_id != expected_id:
        errors.append(_error("candidate_id_mismatch", f"{path}.candidate_id", "候选 ID 与绑定内容不一致"))
    evidence = candidate.get("evidence")
    expected_evidence_keys = FRAGMENT_EVIDENCE_KEYS if kind == "fragment_group" else CAPTION_EVIDENCE_KEYS
    if not isinstance(evidence, dict) or set(evidence) != expected_evidence_keys:
        errors.append(_error("invalid_evidence_fields", f"{path}.evidence", "证据字段不完整或含额外字段"))
        return errors
    geometry_fields = ["member_geometry"] if kind == "fragment_group" else ["source_geometry", "caption_geometry"]
    for field in geometry_fields:
        raw = evidence.get(field)
        records = raw if isinstance(raw, list) else [raw]
        if not records or any(item is None for item in records):
            errors.append(_error("invalid_geometry", f"{path}.evidence.{field}", "缺少几何记录"))
            continue
        for position, record in enumerate(records):
            errors.extend(_validate_geometry(record, f"{path}.evidence.{field}[{position}]"))
    return errors


def _validate_visual_candidates_intrinsic(
    payload: Any,
) -> list[dict[str, str]]:
    """Validate only the candidate package's self-contained schema and hashes."""

    if not isinstance(payload, dict):
        return [_error("invalid_candidate_package", "$", "候选包必须是对象")]
    errors: list[dict[str, str]] = []
    if set(payload) != PACKAGE_KEYS:
        errors.append(_error("invalid_candidate_package_fields", "$", "候选包字段不完整或含额外字段"))
    if payload.get("schema_version") != VISUAL_CANDIDATE_SCHEMA_VERSION:
        errors.append(_error("unsupported_candidate_schema", "schema_version", "候选包版本不受支持"))
    if payload.get("contract") != VISUAL_CANDIDATE_CONTRACT:
        errors.append(_error("invalid_candidate_contract", "contract", "候选包类型无效"))
    if payload.get("status") not in {"ready", "empty", "invalid"}:
        errors.append(_error("invalid_candidate_status", "status", "候选包状态无效"))

    inputs = payload.get("inputs")
    errors.extend(_validate_bindings_shape(inputs, "inputs"))

    digest = payload.get("candidate_package_sha256")
    if not _is_sha256(digest) or digest.lower() != candidate_package_sha256(payload):
        errors.append(_error("candidate_package_hash_mismatch", "candidate_package_sha256", "候选包规范哈希不一致"))

    policy = payload.get("policy")
    if not isinstance(policy, dict) or set(policy) != POLICY_KEYS:
        errors.append(_error("invalid_candidate_policy", "policy", "候选策略结构无效"))
    else:
        if policy.get("allowed_verdicts") != list(ALLOWED_VERDICTS):
            errors.append(_error("invalid_allowed_verdicts", "policy.allowed_verdicts", "允许裁决集合无效"))
        if not _valid_number(policy.get("minimum_accept_confidence"), minimum=0, maximum=1):
            errors.append(_error("invalid_accept_threshold", "policy.minimum_accept_confidence", "接受阈值无效"))

    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        errors.append(_error("invalid_candidates", "candidates", "候选必须是数组"))
    else:
        seen: set[str] = set()
        for index, candidate in enumerate(candidates):
            errors.extend(_validate_candidate_shape(candidate, index, inputs if isinstance(inputs, dict) else {}))
            if isinstance(candidate, dict) and isinstance(candidate.get("candidate_id"), str):
                candidate_id = candidate["candidate_id"]
                if candidate_id in seen:
                    errors.append(_error("duplicate_candidate_id", f"candidates[{index}].candidate_id", "候选 ID 重复"))
                seen.add(candidate_id)
    if not isinstance(payload.get("issues"), list) or any(
        not isinstance(item, str) or not SAFE_CODE_RE.fullmatch(item)
        for item in payload.get("issues", [])
    ):
        errors.append(_error("invalid_candidate_issues", "issues", "候选问题代码无效"))
    return errors


def validate_visual_candidates(
    payload: Any,
    viewer_index: dict[str, Any],
    visual_repair: dict[str, Any],
) -> list[dict[str, str]]:
    """Validate a package and prove it was derived from the current contracts.

    Candidate IDs and the package digest are public deterministic hashes, so
    checking only their self-consistency would let a modified candidate pass
    after an attacker recomputed both hashes.  Rebuilding the complete expected
    package from the current viewer/repair inputs closes that gap.
    """

    errors = _validate_visual_candidates_intrinsic(payload)
    if not isinstance(payload, dict):
        return errors

    expected_inputs = _source_bindings(viewer_index, visual_repair)
    if payload.get("inputs") != expected_inputs:
        errors.append(
            _error(
                "candidate_input_hash_mismatch",
                "inputs",
                "候选包与当前输入哈希不一致",
            )
        )

    policy = payload.get("policy")
    threshold = (
        policy.get("minimum_accept_confidence")
        if isinstance(policy, dict)
        else None
    )
    if _valid_number(threshold, minimum=0, maximum=1):
        expected = build_visual_candidates(
            viewer_index,
            visual_repair,
            minimum_accept_confidence=float(threshold),
        )
        try:
            matches_expected = canonical_json_bytes(payload) == canonical_json_bytes(
                expected
            )
        except (TypeError, ValueError):
            matches_expected = False
        if not matches_expected:
            errors.append(
                _error(
                    "candidate_derivation_mismatch",
                    "$",
                    "候选包不是由当前 viewer-index 与 visual-repair 规范重建所得",
                )
            )
    return errors


def _invalid_adjudication_result(
    candidates: Any, errors: list[dict[str, str]]
) -> dict[str, Any]:
    package_hash = (
        candidates.get("candidate_package_sha256")
        if isinstance(candidates, dict)
        else ""
    )
    return {
        "schema_version": VISUAL_ADJUDICATION_SCHEMA_VERSION,
        "status": "invalid",
        "candidate_package_sha256": package_hash,
        "model_id": "",
        "prompt_version": "",
        "decisions": [],
        "errors": errors,
    }


def validate_visual_adjudication(
    payload: Any,
    candidates: Any,
    *,
    expected_model_id: str | None = None,
    expected_prompt_version: str | None = None,
) -> dict[str, Any]:
    """Validate a strict model response without raising on untrusted output.

    ``expected_model_id`` and ``expected_prompt_version`` are optional for API
    compatibility.  When supplied, the response must match them exactly.
    Candidate-package integrity against viewer/repair should first be checked
    with :func:`validate_visual_candidates`.
    """

    if not isinstance(candidates, dict):
        return _invalid_adjudication_result(
            candidates,
            [_error("invalid_candidate_package", "$candidates", "候选包必须是对象")],
        )
    # Recheck the package's intrinsic schema even when a caller omitted the
    # recommended validate_visual_candidates(...) preflight.  Derivation from
    # the current viewer/repair contracts still belongs to that preflight,
    # because this response validator intentionally receives neither source.
    candidate_structure_errors = _validate_visual_candidates_intrinsic(candidates)
    if candidate_structure_errors:
        return _invalid_adjudication_result(candidates, candidate_structure_errors)
    if candidates.get("status") != "ready":
        return _invalid_adjudication_result(
            candidates,
            [
                _error(
                    "candidate_package_not_ready",
                    "$candidates.status",
                    "候选包没有可裁决的安全候选",
                )
            ],
        )
    if not isinstance(payload, dict):
        return _invalid_adjudication_result(
            candidates,
            [_error("invalid_adjudication", "$", "裁决输出必须是对象")],
        )

    fatal_errors: list[dict[str, str]] = []
    decision_errors: list[dict[str, str]] = []
    if set(payload) != RESPONSE_KEYS:
        fatal_errors.append(_error("invalid_adjudication_fields", "$", "裁决输出字段不完整或含额外字段"))
    if payload.get("schema_version") != VISUAL_ADJUDICATION_SCHEMA_VERSION:
        fatal_errors.append(_error("unsupported_adjudication_schema", "schema_version", "裁决版本不受支持"))
    if payload.get("contract") != VISUAL_ADJUDICATION_CONTRACT:
        fatal_errors.append(_error("invalid_adjudication_contract", "contract", "裁决类型无效"))

    expected_package_hash = candidates.get("candidate_package_sha256")
    response_package_hash = payload.get("candidate_package_sha256")
    if (
        not _is_sha256(expected_package_hash)
        or not _is_sha256(response_package_hash)
        or response_package_hash.lower() != expected_package_hash.lower()
        or expected_package_hash.lower() != candidate_package_sha256(candidates)
    ):
        fatal_errors.append(_error("candidate_package_hash_mismatch", "candidate_package_sha256", "裁决未绑定当前候选包"))

    response_inputs = payload.get("inputs")
    fatal_errors.extend(_validate_bindings_shape(response_inputs, "inputs"))
    if response_inputs != candidates.get("inputs"):
        fatal_errors.append(_error("adjudication_input_hash_mismatch", "inputs", "裁决输入哈希与候选包不一致"))

    model_id = payload.get("model_id")
    prompt_version = payload.get("prompt_version")
    if not isinstance(model_id, str) or not SAFE_VERSION_RE.fullmatch(model_id):
        fatal_errors.append(_error("invalid_model_id", "model_id", "模型 ID 缺失或无效"))
    elif expected_model_id is not None and model_id != expected_model_id:
        fatal_errors.append(_error("model_id_mismatch", "model_id", "模型 ID 与预期不一致"))
    if not isinstance(prompt_version, str) or not SAFE_VERSION_RE.fullmatch(prompt_version):
        fatal_errors.append(_error("invalid_prompt_version", "prompt_version", "提示词版本缺失或无效"))
    elif expected_prompt_version is not None and prompt_version != expected_prompt_version:
        fatal_errors.append(_error("prompt_version_mismatch", "prompt_version", "提示词版本与预期不一致"))

    raw_decisions = payload.get("decisions")
    if not isinstance(raw_decisions, list):
        fatal_errors.append(_error("invalid_decisions", "decisions", "裁决必须是数组"))
        raw_decisions = []
    if fatal_errors:
        result = _invalid_adjudication_result(candidates, fatal_errors)
        result["model_id"] = model_id if isinstance(model_id, str) else ""
        result["prompt_version"] = prompt_version if isinstance(prompt_version, str) else ""
        return result

    known_ids = {
        candidate.get("candidate_id")
        for candidate in candidates.get("candidates", [])
        if isinstance(candidate, dict) and isinstance(candidate.get("candidate_id"), str)
    }
    threshold = candidates.get("policy", {}).get(
        "minimum_accept_confidence", DEFAULT_MINIMUM_ACCEPT_CONFIDENCE
    )
    if not _valid_number(threshold, minimum=0, maximum=1):
        threshold = DEFAULT_MINIMUM_ACCEPT_CONFIDENCE
    seen: set[str] = set()
    verified: list[dict[str, Any]] = []
    for index, decision in enumerate(raw_decisions):
        path = f"decisions[{index}]"
        if not isinstance(decision, dict):
            decision_errors.append(_error("invalid_decision", path, "单项裁决必须是对象"))
            continue
        if set(decision) != DECISION_KEYS:
            decision_errors.append(
                _error(
                    "invalid_decision_fields",
                    path,
                    "单项裁决字段不完整或含坐标、路径、正文等额外字段",
                )
            )
            continue
        candidate_id = decision.get("candidate_id")
        verdict = decision.get("verdict")
        confidence = decision.get("confidence")
        if not isinstance(candidate_id, str) or candidate_id not in known_ids:
            decision_errors.append(_error("unknown_candidate_id", f"{path}.candidate_id", "候选 ID 不存在"))
            continue
        if candidate_id in seen:
            decision_errors.append(_error("duplicate_decision", f"{path}.candidate_id", "同一候选被重复裁决"))
            continue
        seen.add(candidate_id)
        if verdict not in ALLOWED_VERDICTS:
            decision_errors.append(_error("invalid_verdict", f"{path}.verdict", "裁决值只允许 accept/reject/abstain"))
            continue
        if not _valid_number(confidence, minimum=0, maximum=1):
            decision_errors.append(_error("invalid_confidence", f"{path}.confidence", "置信度必须位于 0 到 1"))
            continue
        if verdict == "accept" and float(confidence) < float(threshold):
            decision_errors.append(_error("accept_confidence_below_threshold", f"{path}.confidence", "接受裁决低于候选包阈值"))
            continue
        verified.append(
            {
                "candidate_id": candidate_id,
                "verdict": verdict,
                "confidence": round(float(confidence), 6),
                "actionable": verdict in {"accept", "reject"},
            }
        )

    status = "partial" if decision_errors and verified else "invalid" if decision_errors else "valid"
    return {
        "schema_version": VISUAL_ADJUDICATION_SCHEMA_VERSION,
        "status": status,
        "candidate_package_sha256": expected_package_hash,
        "model_id": model_id,
        "prompt_version": prompt_version,
        "decisions": verified,
        "errors": decision_errors,
    }


def _read_json(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _emit_json(value: Any, output: str | None) -> None:
    rendered = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if output:
        Path(output).write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build or validate bounded MinerU visual adjudication contracts."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build", help="Build candidate packet")
    build_parser.add_argument("--viewer-index", required=True)
    build_parser.add_argument("--visual-repair", required=True)
    build_parser.add_argument("--output")
    build_parser.add_argument(
        "--minimum-accept-confidence",
        type=float,
        default=DEFAULT_MINIMUM_ACCEPT_CONFIDENCE,
    )

    validate_parser = subparsers.add_parser("validate", help="Validate model response")
    validate_parser.add_argument("--viewer-index", required=True)
    validate_parser.add_argument("--visual-repair", required=True)
    validate_parser.add_argument("--candidates", required=True)
    validate_parser.add_argument("--adjudication", required=True)
    validate_parser.add_argument("--model-id")
    validate_parser.add_argument("--prompt-version")
    validate_parser.add_argument("--output")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        viewer_index = _read_json(args.viewer_index)
        visual_repair = _read_json(args.visual_repair)
        if args.command == "build":
            result = build_visual_candidates(
                viewer_index,
                visual_repair,
                minimum_accept_confidence=args.minimum_accept_confidence,
            )
        else:
            candidates = _read_json(args.candidates)
            candidate_errors = validate_visual_candidates(
                candidates, viewer_index, visual_repair
            )
            if candidate_errors:
                result = _invalid_adjudication_result(candidates, candidate_errors)
            else:
                result = validate_visual_adjudication(
                    _read_json(args.adjudication),
                    candidates,
                    expected_model_id=args.model_id,
                    expected_prompt_version=args.prompt_version,
                )
        _emit_json(result, args.output)
    except Exception as exc:  # CLI boundary: report, never mutate or block caller
        _emit_json(
            {
                "schema_version": VISUAL_ADJUDICATION_SCHEMA_VERSION,
                "status": "invalid",
                "decisions": [],
                "errors": [
                    _error("adjudication_io_error", "$", f"{type(exc).__name__}: {exc}")
                ],
            },
            getattr(args, "output", None),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
