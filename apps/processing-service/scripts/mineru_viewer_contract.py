"""Build deterministic, optional viewer contracts from MinerU content-list output.

The core MinerU package remains ``article.md`` + ``mineru-result.json`` + assets.
The contracts produced here are derived indexes: consumers must ignore them when
their input hashes do not match and always fall back to the original artifacts.
"""

from __future__ import annotations

# Extracted from Research Agent Reader's companion workflow (MIT, Copyright 2026 Liao Li).

from collections import Counter, defaultdict
import hashlib
import math
import re
from typing import Any, Iterable
from urllib.parse import unquote


VIEWER_INDEX_SCHEMA_VERSION = 1
VISUAL_REPAIR_SCHEMA_VERSION = 1
VISUAL_REPAIR_ALGORITHM_VERSION = "visual-repair-v1.6"
COORDINATE_EXTENT = 1000

MARKDOWN_IMAGE_RE = re.compile(
    r"!\[[^\]]*\]\(\s*(?:<(?P<angle>[^>]+)>|(?P<plain>[^\s)]+))"
    r"(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)"
)
HTML_IMAGE_RE = re.compile(
    r"<img\b[^>]*\bsrc=[\"'](?P<src>[^\"']+)[\"']",
    re.IGNORECASE,
)
FIGURE_KEY_RE = re.compile(
    r"^\s*(?P<kind>extended\s+data\s+fig(?:ure)?|"
    r"supplementary\s+fig(?:ure)?|"
    r"supporting(?:\s+information)?\s+fig(?:ure)?|fig(?:ure)?|图)\."
    r"?\s*(?P<identifier>[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)",
    re.IGNORECASE,
)
FIGURE_REFERENCE_VERBS_RE = re.compile(
    r"^(?:shows?|illustrates?|depicts?|demonstrates?|presents?|reports?|"
    r"displays?|compares?|lists?|summari[sz]es?|gives?|provides?|plots?|"
    r"is|are|was|were)\b",
    re.IGNORECASE,
)
NEXT_PAGE_CAPTION_RE = re.compile(
    r"(?:"
    r"see\s+(?:the\s+)?next\s+page\s+for\s+(?:the\s+)?caption"
    r"|caption\s+(?:is\s+)?continued\s+on\s+(?:the\s+)?next\s+page"
    r"|continued\s+on\s+(?:the\s+)?next\s+page"
    r"|caption\s+(?:is\s+)?(?:on|over)\s+(?:the\s+)?next\s+page"
    r"|continued\s+overleaf"
    r"|图注(?:见|续见|续|在)?(?:下一|下)页"
    r"|(?:下一|下)页(?:续见|续|见)图注"
    r")",
    re.IGNORECASE,
)
NEXT_PAGE_PLACEHOLDER_SPAN_RE = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(?P<placeholder>"
    r"(?:extended\s+data\s+fig(?:ure)?|"
    r"supplementary\s+fig(?:ure)?|"
    r"supporting(?:\s+information)?\s+fig(?:ure)?|fig(?:ure)?|图)\."
    r"?\s*[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*"
    r"\s*[|｜:：.]\s*"
    + NEXT_PAGE_CAPTION_RE.pattern
    + r"(?:[.!?。！？](?=\s|$)|(?=$))"
    r")",
    re.IGNORECASE,
)
NEXT_PAGE_PLACEHOLDER_CANDIDATE_RE = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(?:extended\s+data\s+fig(?:ure)?|"
    r"supplementary\s+fig(?:ure)?|"
    r"supporting(?:\s+information)?\s+fig(?:ure)?|fig(?:ure)?|图)\."
    r"?\s*[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*"
    r"\s*[|｜:：.]\s*"
    + NEXT_PAGE_CAPTION_RE.pattern,
    re.IGNORECASE,
)
PANEL_LABEL_RE = re.compile(r"^\s*[\[(]?[A-Za-z][\])\].:]?\s*$")
PANEL_CONTINUATION_RE = re.compile(
    r"^\s*[\[(]?[A-Za-z][\])\].:]?(?=\s|[,;:])"
)
CAPTION_ITEM_KINDS = {
    "formal-caption",
    "next-page-placeholder",
    "panel-label",
    "caption-continuation",
    "other",
}
URL_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
NORMALIZED_FIGURE_KEY_RE = re.compile(
    r"^(?:figure|extended-data-figure|supplementary-figure|supporting-figure|图):"
    r"[a-z0-9]+(?:[_-][a-z0-9]+)*$"
)

VISUAL_SOURCE_TYPES = {"image", "chart"}
TABLE_SOURCE_TYPES = {"table", "table_body"}
EQUATION_SOURCE_TYPES = {"equation", "interline_equation"}
MARGINAL_SOURCE_TYPES = {
    "aside_text",
    "footer",
    "header",
    "page_footer",
    "page_footnote",
    "page_header",
    "page_number",
}
CAPTION_FIELDS = ("image_caption", "chart_caption", "table_caption")
FOOTNOTE_FIELDS = ("image_footnote", "chart_footnote", "table_footnote")


def _stable_number(value: float) -> int | float:
    if value.is_integer():
        return int(value)
    return round(value, 6)


def normalize_bbox(
    raw: Any, *, scale_unit_interval: bool = False
) -> list[int | float] | None:
    """Return a valid 0..1000 MinerU bbox, otherwise ``None``."""

    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    coordinates: list[float] = []
    for value in raw:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        numeric = float(value)
        if not math.isfinite(numeric) or not 0 <= numeric <= COORDINATE_EXTENT:
            return None
        coordinates.append(numeric)
    if scale_unit_interval and max(abs(value) for value in coordinates) <= 1.5:
        coordinates = [value * COORDINATE_EXTENT for value in coordinates]
    x0, y0, x1, y1 = coordinates
    if x1 <= x0 or y1 <= y0:
        return None
    return [_stable_number(value) for value in coordinates]


def _flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        normalized = value.strip()
        return [normalized] if normalized else []
    if isinstance(value, (list, tuple)):
        strings: list[str] = []
        for item in value:
            strings.extend(_flatten_strings(item))
        return strings
    if isinstance(value, dict):
        strings = []
        for item in value.values():
            strings.extend(_flatten_strings(item))
        return strings
    return []


def _string_summary(strings: Iterable[str]) -> dict[str, Any]:
    values = [value for value in strings if value]
    joined = "\n".join(values)
    return {
        "item_count": len(values),
        "char_count": sum(len(value) for value in values),
        "sha256": hashlib.sha256(joined.encode("utf-8")).hexdigest() if values else None,
    }


def _normalize_figure_key(value: str) -> str | None:
    match = FIGURE_KEY_RE.match(value)
    if not match:
        return None
    raw_kind = re.sub(r"\s+", " ", match.group("kind").strip().lower())
    if raw_kind.startswith("extended data"):
        kind = "extended-data-figure"
    elif raw_kind.startswith("supplementary"):
        kind = "supplementary-figure"
    elif raw_kind.startswith("supporting"):
        kind = "supporting-figure"
    elif raw_kind == "图":
        kind = "图"
    else:
        kind = "figure"
    identifier = match.group("identifier").strip().lower().replace(".", "_")
    return f"{kind}:{identifier}"


def _formal_figure_caption_key(value: str) -> str | None:
    """Require a figure heading and reject prose-style figure references."""

    match = FIGURE_KEY_RE.match(value)
    if not match:
        return None
    remainder = value[match.end() :]
    delimited = re.fullmatch(
        r"\s*[|｜:：.]\s*([^|｜:：.\s][\s\S]*)", remainder
    )
    undelimited = re.fullmatch(r"\s+([^|｜:：.\s][\s\S]*)", remainder)
    title = (delimited or undelimited).group(1).strip() if (delimited or undelimited) else ""
    if len(title) < 5 or FIGURE_REFERENCE_VERBS_RE.match(title):
        return None
    return _normalize_figure_key(value)


def _next_page_caption_placeholder_key(value: str) -> str | None:
    """Return a key only when the complete atom is an explicit placeholder.

    The broad next-page marker remains useful in the aggregate caption summary
    and cross-page linking logic.  Atomic classification is deliberately
    stricter so ordinary prose that merely mentions a following page cannot be
    projected out of Markdown as a placeholder.
    """

    match = FIGURE_KEY_RE.match(value)
    if not match:
        return None
    remainder = value[match.end() :].lstrip()
    if not remainder or remainder[0] not in {"|", "｜", ":", "：", "."}:
        return None
    marker = remainder[1:].strip()
    if not marker:
        return None
    if re.fullmatch(
        rf"(?:{NEXT_PAGE_CAPTION_RE.pattern})[.!?。！？]?",
        marker,
        flags=re.IGNORECASE,
    ) is None:
        return None
    return _normalize_figure_key(value)


def _next_page_placeholder_spans(value: str) -> list[tuple[str, str]]:
    """Recover exact, boundary-delimited placeholder spans from one atom."""

    spans: list[tuple[str, str]] = []
    for match in NEXT_PAGE_PLACEHOLDER_SPAN_RE.finditer(value):
        placeholder = match.group("placeholder").strip()
        figure_key = _next_page_caption_placeholder_key(placeholder)
        if figure_key is not None:
            spans.append((placeholder, figure_key))
    return spans


def _next_page_placeholders(strings: Iterable[str]) -> list[dict[str, Any]]:
    """Return only uniquely recoverable placeholder spans for each source atom."""

    placeholders: list[dict[str, Any]] = []
    for index, value in enumerate(strings):
        spans = _next_page_placeholder_spans(value)
        if len(spans) != 1:
            continue
        placeholder, figure_key = spans[0]
        placeholders.append(
            {
                "index": index,
                "text": placeholder,
                "figure_key": figure_key,
            }
        )
    return placeholders


def _ends_with_terminal_punctuation(value: str) -> bool:
    normalized = value.strip()
    while re.search(r"</[^>]+>\s*$", normalized):
        normalized = re.sub(r"</[^>]+>\s*$", "", normalized).rstrip()
    return bool(re.search(r"[.!?。！？][\"'”’)\]}]*$", normalized))


def _first_alpha_is_lowercase(value: str) -> bool:
    for character in value:
        if character.isalpha():
            return character.islower()
    return False


def _content_detection_summary(strings: Iterable[str]) -> dict[str, Any]:
    """Return detection metadata plus exact removable placeholder spans."""

    values = [value for value in strings if value]
    next_page_placeholders = _next_page_placeholders(values)
    figure_keys = list(
        dict.fromkeys(
            [
                figure_key
                for value in values
                if (figure_key := _normalize_figure_key(value)) is not None
            ]
            + [
                placeholder["figure_key"]
                for placeholder in next_page_placeholders
            ]
        )
    )
    next_page_figure_keys = list(
        dict.fromkeys(
            placeholder["figure_key"] for placeholder in next_page_placeholders
        )
    )
    formal_figure_caption_keys = list(
        dict.fromkeys(
            figure_key
            for value in values
            if (figure_key := _formal_figure_caption_key(value)) is not None
        )
    )
    first_value = values[0] if values else ""
    return {
        "figure_keys": figure_keys,
        "leading_figure_key": _normalize_figure_key(first_value),
        "formal_figure_caption_keys": formal_figure_caption_keys,
        "leading_formal_figure_caption_key": _formal_figure_caption_key(first_value),
        "next_page_marker": bool(next_page_placeholders),
        "next_page_figure_keys": next_page_figure_keys,
        "next_page_placeholders": next_page_placeholders,
        "starts_with_lowercase": _first_alpha_is_lowercase(first_value),
        "starts_with_panel_label": bool(PANEL_CONTINUATION_RE.match(first_value)),
        "ends_with_terminal_punctuation": _ends_with_terminal_punctuation(first_value),
    }


def _caption_item_kind(value: str) -> tuple[str, str | None]:
    """Classify one original MinerU caption atom without merging neighbours.

    ``caption-continuation`` deliberately means only "candidate continuation".
    Visual grouping and cross-page linking must still require their existing
    independent figure-anchor and layout evidence.
    """

    figure_key = _normalize_figure_key(value)
    placeholder_key = _next_page_caption_placeholder_key(value)
    if placeholder_key is not None:
        return "next-page-placeholder", placeholder_key
    if (
        _next_page_placeholder_spans(value)
        or NEXT_PAGE_PLACEHOLDER_CANDIDATE_RE.search(value)
    ):
        return "other", figure_key
    if _formal_figure_caption_key(value) is not None:
        return "formal-caption", figure_key
    if PANEL_LABEL_RE.fullmatch(value):
        return "panel-label", None
    if (
        len(value) >= 24
        and figure_key is None
        and _ends_with_terminal_punctuation(value)
        and (
            PANEL_CONTINUATION_RE.match(value)
            or _first_alpha_is_lowercase(value)
        )
    ):
        return "caption-continuation", None
    return "other", figure_key


def _caption_items(strings: Iterable[str]) -> list[dict[str, Any]]:
    """Return ordered, atomic caption records suitable for safe consumers."""

    items: list[dict[str, Any]] = []
    for index, value in enumerate(strings):
        kind, figure_key = _caption_item_kind(value)
        record: dict[str, Any] = {
            "index": index,
            "text": value,
            "kind": kind,
        }
        if figure_key is not None:
            record["figure_key"] = figure_key
        items.append(record)
    return items


def summarize_caption(item: dict[str, Any]) -> dict[str, Any]:
    """Summarize captions while preserving MinerU's original caption atoms."""

    strings: list[str] = []
    fields: list[str] = []
    content = item.get("content") if isinstance(item.get("content"), dict) else {}
    for field in CAPTION_FIELDS:
        for container in (item, content):
            if field in container:
                fields.append(field)
                strings.extend(_flatten_strings(container.get(field)))
    summary = _string_summary(strings)
    summary.update(
        {
            "fields": fields,
            "items": _caption_items(strings),
            "long_item_count": sum(len(value) >= 30 for value in strings),
            "figure_anchor_count": sum(
                _formal_figure_caption_key(value) is not None for value in strings
            ),
            "panel_label_count": sum(bool(PANEL_LABEL_RE.fullmatch(value)) for value in strings),
        }
    )
    summary.update(_content_detection_summary(strings))
    return summary


def _summarize_footnotes(item: dict[str, Any]) -> dict[str, Any]:
    strings: list[str] = []
    fields: list[str] = []
    content = item.get("content") if isinstance(item.get("content"), dict) else {}
    for field in FOOTNOTE_FIELDS:
        for container in (item, content):
            if field in container:
                fields.append(field)
                strings.extend(_flatten_strings(container.get(field)))
    summary = _string_summary(strings)
    summary["fields"] = fields
    return summary


def classify_element(item: dict[str, Any]) -> str:
    source_type = str(item.get("type", "unknown")).strip().lower()
    if source_type in VISUAL_SOURCE_TYPES:
        return "visual"
    if source_type in TABLE_SOURCE_TYPES:
        return "table"
    if source_type in EQUATION_SOURCE_TYPES:
        return "equation"
    if source_type in MARGINAL_SOURCE_TYPES:
        return "marginalia"
    if source_type in {"title", "paragraph_title"}:
        return "title"
    if source_type == "text" and item.get("text_level") is not None:
        return "title"
    if source_type in {"text", "paragraph", "ref_text", "list"}:
        return "text"
    return "other"


def _normalize_asset_path(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    value = unquote(raw.strip().strip("<>")).replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    if not value:
        return None
    if (
        "\x00" in value
        or value.startswith("/")
        or URL_SCHEME_RE.match(value)
        or any(segment == ".." for segment in value.split("/"))
    ):
        return None
    return value


def _extract_asset_path(item: dict[str, Any]) -> str | None:
    content = item.get("content") if isinstance(item.get("content"), dict) else {}
    source = content.get("image_source") or content.get("table_source")
    source = source if isinstance(source, dict) else {}
    for value in (
        item.get("img_path"),
        item.get("image_path"),
        source.get("path"),
        source.get("src"),
        content.get("img_path"),
    ):
        path = _normalize_asset_path(value)
        if path:
            return path
    return None


def _flatten_source_elements(payload: Any) -> tuple[list[tuple[Any, int | None]], bool]:
    if not isinstance(payload, list):
        return [], False
    if payload and all(isinstance(page, list) for page in payload):
        return [
            (item, page_idx)
            for page_idx, page in enumerate(payload)
            for item in page
        ], True
    return [(item, None) for item in payload], False


def extract_markdown_image_occurrences(markdown: str) -> list[dict[str, Any]]:
    """Return ordered Markdown/HTML image occurrences with stable identifiers."""

    raw_matches: list[tuple[int, int, str, str]] = []
    for match in MARKDOWN_IMAGE_RE.finditer(markdown):
        path = _normalize_asset_path(match.group("angle") or match.group("plain"))
        if path:
            raw_matches.append((match.start(), match.end(), path, "markdown"))
    for match in HTML_IMAGE_RE.finditer(markdown):
        path = _normalize_asset_path(match.group("src"))
        if path:
            raw_matches.append((match.start(), match.end(), path, "html"))
    raw_matches.sort(key=lambda value: (value[0], value[1]))

    occurrences: Counter[str] = Counter()
    result: list[dict[str, Any]] = []
    for order, (start, end, path, syntax) in enumerate(raw_matches):
        occurrence = occurrences[path]
        occurrences[path] += 1
        result.append(
            {
                "id": f"md-img-{order:04d}",
                "order": order,
                "asset_path": path,
                "occurrence": occurrence,
                "syntax": syntax,
                "char_start": start,
                "char_end": end,
            }
        )
    return result


def _text_summary(item: dict[str, Any]) -> dict[str, Any]:
    strings: list[str] = []
    for field in ("text", "content", "list_items"):
        if field in item:
            strings.extend(_flatten_strings(item.get(field)))
    summary = _string_summary(strings)
    summary.update(_content_detection_summary(strings))
    return summary


def _metadata(item: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for field in ("text_level", "text_format", "sub_type"):
        value = item.get(field)
        if isinstance(value, (str, int, float, bool)) and not isinstance(value, dict):
            result[field] = value
    return result


def build_viewer_index(
    payload: Any,
    markdown_images: list[dict[str, Any]],
    input_hashes: dict[str, str],
    *,
    packaged_source_pdf: bool,
    source_available_at_generation: bool = True,
) -> dict[str, Any]:
    """Build a deterministic viewer index from MinerU v1 or page-nested v2 output."""

    issues: list[dict[str, Any]] = []
    source_elements, nested_by_page = _flatten_source_elements(payload)
    if not isinstance(payload, list):
        issues.append({"code": "mineru_result_not_array"})

    markdown_by_path: dict[str, list[str]] = defaultdict(list)
    for image in markdown_images:
        path = _normalize_asset_path(image.get("asset_path"))
        image_id = image.get("id")
        if path and isinstance(image_id, str):
            markdown_by_path[path].append(image_id)
    markdown_cursor: Counter[str] = Counter()

    pages: dict[int, list[dict[str, Any]]] = defaultdict(list)
    located_block_count = 0
    accepted_block_count = 0
    for source_index, (raw_item, nested_page_idx) in enumerate(source_elements):
        if not isinstance(raw_item, dict):
            issues.append({"code": "element_not_object", "source_index": source_index})
            continue
        page_idx = nested_page_idx if nested_by_page else raw_item.get("page_idx")
        if isinstance(page_idx, bool) or not isinstance(page_idx, int) or page_idx < 0:
            issues.append({"code": "invalid_page_idx", "source_index": source_index})
            continue
        accepted_block_count += 1
        bbox = normalize_bbox(
            raw_item.get("bbox"), scale_unit_interval=nested_by_page
        )
        if bbox is None:
            issues.append({"code": "missing_or_invalid_bbox", "source_index": source_index})
        else:
            located_block_count += 1

        asset_path = _extract_asset_path(raw_item)
        markdown_ids: list[str] = []
        if asset_path:
            cursor = markdown_cursor[asset_path]
            candidates = markdown_by_path.get(asset_path, [])
            if cursor < len(candidates):
                markdown_ids.append(candidates[cursor])
                markdown_cursor[asset_path] += 1

        page_order = len(pages[page_idx])
        source_type = str(raw_item.get("type", "unknown"))
        pages[page_idx].append(
            {
                "id": f"p{page_idx:04d}-s{source_index:06d}",
                "source_index": source_index,
                "page_order": page_order,
                "source_type": source_type,
                "role": classify_element(raw_item),
                "bbox_norm": bbox,
                "asset_path": asset_path,
                "markdown_image_ids": markdown_ids,
                "text": _text_summary(raw_item),
                "caption": summarize_caption(raw_item),
                "footnote": _summarize_footnotes(raw_item),
                "metadata": _metadata(raw_item),
            }
        )

    if located_block_count == 0:
        status = "unavailable"
    elif issues:
        status = "partial"
    else:
        status = "complete"

    page_records = [
        {"page_idx": page_idx, "blocks": pages[page_idx]}
        for page_idx in sorted(pages)
    ]
    return {
        "schema_version": VIEWER_INDEX_SCHEMA_VERSION,
        "status": status,
        "inputs": {
            "article": {"path": "article.md", "sha256": input_hashes["article"]},
            "mineru_result": {
                "path": "mineru-result.json",
                "sha256": input_hashes["mineru_result"],
            },
        },
        "coordinate_system": {
            "kind": "normalized-page",
            "extent": COORDINATE_EXTENT,
            "page_index_base": 0,
        },
        "pdf_source": {
            "packaged_path": "_extraction/source.pdf" if packaged_source_pdf else None,
            "manifest_source_fallback": True,
            "available_at_generation": source_available_at_generation,
        },
        "summary": {
            "source_element_count": len(source_elements),
            "accepted_block_count": accepted_block_count,
            "located_block_count": located_block_count,
            "page_count": len(page_records),
            "markdown_image_count": len(markdown_images),
        },
        "markdown_images": markdown_images,
        "pages": page_records,
        "issues": issues,
    }


def _bbox_area(bbox: list[int | float]) -> float:
    return float(bbox[2] - bbox[0]) * float(bbox[3] - bbox[1])


def _intersection_area(
    left: list[int | float], right: list[int | float]
) -> float:
    width = max(0.0, min(float(left[2]), float(right[2])) - max(float(left[0]), float(right[0])))
    height = max(0.0, min(float(left[3]), float(right[3])) - max(float(left[1]), float(right[1])))
    return width * height


def find_enclosing_visuals(
    page_blocks: list[dict[str, Any]],
    *,
    containment_threshold: float = 0.95,
    area_ratio: float = 1.2,
) -> list[dict[str, Any]]:
    """Map visual children to the smallest substantially enclosing visual."""

    visuals = [
        block
        for block in page_blocks
        if block.get("role") == "visual"
        and block.get("asset_path")
        and normalize_bbox(block.get("bbox_norm")) is not None
    ]
    relations: list[dict[str, Any]] = []
    for child in visuals:
        child_bbox = normalize_bbox(child["bbox_norm"])
        assert child_bbox is not None
        child_area = _bbox_area(child_bbox)
        candidates: list[tuple[float, dict[str, Any], float]] = []
        for parent in visuals:
            if parent["id"] == child["id"]:
                continue
            parent_bbox = normalize_bbox(parent["bbox_norm"])
            assert parent_bbox is not None
            parent_area = _bbox_area(parent_bbox)
            if parent_area < child_area * area_ratio:
                continue
            containment = _intersection_area(child_bbox, parent_bbox) / child_area
            if containment >= containment_threshold:
                candidates.append((parent_area, parent, containment))
        if candidates:
            _, parent, containment = min(candidates, key=lambda value: value[0])
            relations.append(
                {
                    "child_id": child["id"],
                    "parent_id": parent["id"],
                    "containment": round(containment, 4),
                }
            )
    return relations


def _repair_group_figure_keys(
    member_ids: list[str], block_by_id: dict[str, dict[str, Any]]
) -> set[str]:
    keys: set[str] = set()
    for block_id in member_ids:
        caption = block_by_id.get(block_id, {}).get("caption", {})
        if not isinstance(caption, dict):
            continue
        for field in (
            "formal_figure_caption_keys",
            "next_page_figure_keys",
        ):
            values = caption.get(field, [])
            if isinstance(values, list):
                keys.update(value for value in values if isinstance(value, str) and value)
    return keys


def _repair_groups_are_source_adjacent(
    left_ids: list[str],
    right_ids: list[str],
    block_by_id: dict[str, dict[str, Any]],
) -> bool:
    try:
        left_orders = [int(block_by_id[block_id]["page_order"]) for block_id in left_ids]
        right_orders = [int(block_by_id[block_id]["page_order"]) for block_id in right_ids]
    except (KeyError, TypeError, ValueError):
        return False
    if not left_orders or not right_orders:
        return False
    return (
        min(right_orders) <= max(left_orders) + 1
        and min(left_orders) <= max(right_orders) + 1
    )


def merge_nested_visual_repair_groups(
    groups: list[dict[str, Any]], viewer_index: dict[str, Any]
) -> list[dict[str, Any]]:
    """Fold a repeated contained panel group into its complete figure group.

    MinerU can emit a full multi-panel reconstruction and then repeat a panel
    strip such as p/q/r as a second group. Geometry alone is not enough to
    suppress content, so require same-page auto PDF crops, >=97% containment,
    a >=1.35 area ratio, adjacent source order, and exactly one compatible
    formal figure key. Caption anchors remain on the enclosing group.
    """

    block_by_id = {
        block["id"]: block
        for page in viewer_index.get("pages", [])
        if isinstance(page, dict) and isinstance(page.get("blocks"), list)
        for block in page["blocks"]
        if isinstance(block, dict) and isinstance(block.get("id"), str)
    }
    markdown_order = {
        image["id"]: int(image.get("order", 0))
        for image in viewer_index.get("markdown_images", [])
        if isinstance(image, dict) and isinstance(image.get("id"), str)
    }
    working = [
        {
            **group,
            "member_block_ids": list(group.get("member_block_ids", [])),
            "member_asset_paths": list(group.get("member_asset_paths", [])),
            "member_markdown_image_ids": list(
                group.get("member_markdown_image_ids", [])
            ),
            "caption_anchor_block_ids": list(
                group.get("caption_anchor_block_ids", [])
            ),
            "signals": dict(group.get("signals", {})),
            "reason_codes": list(group.get("reason_codes", [])),
            "warning_codes": list(group.get("warning_codes", [])),
        }
        for group in groups
    ]

    while True:
        match: tuple[int, int, float] | None = None
        for left_index, left in enumerate(working):
            left_replacement = left.get("replacement", {})
            left_bbox = normalize_bbox(left_replacement.get("bbox_norm"))
            if (
                left.get("decision") != "auto"
                or left_replacement.get("mode") != "pdf_crop"
                or left_bbox is None
            ):
                continue
            for right_index in range(left_index + 1, len(working)):
                right = working[right_index]
                right_replacement = right.get("replacement", {})
                right_bbox = normalize_bbox(right_replacement.get("bbox_norm"))
                if (
                    right.get("page_idx") != left.get("page_idx")
                    or right.get("decision") != "auto"
                    or right_replacement.get("mode") != "pdf_crop"
                    or right_bbox is None
                ):
                    continue
                left_area = _bbox_area(left_bbox)
                right_area = _bbox_area(right_bbox)
                if left_area <= 0 or right_area <= 0:
                    continue
                outer_index, inner_index = (
                    (left_index, right_index)
                    if left_area >= right_area
                    else (right_index, left_index)
                )
                outer = working[outer_index]
                inner = working[inner_index]
                outer_bbox = normalize_bbox(outer["replacement"].get("bbox_norm"))
                inner_bbox = normalize_bbox(inner["replacement"].get("bbox_norm"))
                assert outer_bbox is not None and inner_bbox is not None
                outer_area = _bbox_area(outer_bbox)
                inner_area = _bbox_area(inner_bbox)
                if outer_area < inner_area * 1.35:
                    continue
                containment = _intersection_area(outer_bbox, inner_bbox) / inner_area
                if containment < 0.97:
                    continue
                outer_ids = outer.get("member_block_ids", [])
                inner_ids = inner.get("member_block_ids", [])
                if not _repair_groups_are_source_adjacent(
                    outer_ids, inner_ids, block_by_id
                ):
                    continue
                figure_keys = _repair_group_figure_keys(
                    outer_ids, block_by_id
                ) | _repair_group_figure_keys(inner_ids, block_by_id)
                if len(figure_keys) != 1:
                    continue
                match = (outer_index, inner_index, containment)
                break
            if match is not None:
                break
        if match is None:
            break

        outer_index, inner_index, containment = match
        outer = working[outer_index]
        inner = working[inner_index]
        member_ids = sorted(
            set(outer.get("member_block_ids", []))
            | set(inner.get("member_block_ids", [])),
            key=lambda block_id: int(block_by_id.get(block_id, {}).get("page_order", 10**9)),
        )
        markdown_ids = sorted(
            set(outer.get("member_markdown_image_ids", []))
            | set(inner.get("member_markdown_image_ids", [])),
            key=lambda image_id: markdown_order.get(image_id, 10**9),
        )
        caption_anchor_ids = sorted(
            set(outer.get("caption_anchor_block_ids", []))
            | set(inner.get("caption_anchor_block_ids", [])),
            key=lambda block_id: int(block_by_id.get(block_id, {}).get("page_order", 10**9)),
        )
        signals = dict(outer.get("signals", {}))
        inner_signals = inner.get("signals", {})
        for signal_name in (
            "representative_count",
            "adjacent_pair_count",
            "caption_char_count",
            "long_caption_anchor_count",
            "figure_caption_anchor_count",
            "panel_label_count",
        ):
            signals[signal_name] = int(signals.get(signal_name, 0)) + int(
                inner_signals.get(signal_name, 0)
            )
        signals.update(
            {
                "member_count": len(member_ids),
                "nested_group_count": int(signals.get("nested_group_count", 0))
                + int(inner_signals.get("nested_group_count", 0))
                + 1,
                "nested_overlap_containment": round(containment, 4),
            }
        )
        merged = {
            **outer,
            "member_block_ids": member_ids,
            "member_asset_paths": sorted(
                {
                    block_by_id[block_id]["asset_path"]
                    for block_id in member_ids
                    if block_id in block_by_id
                    and isinstance(block_by_id[block_id].get("asset_path"), str)
                    and block_by_id[block_id]["asset_path"]
                }
            ),
            "member_markdown_image_ids": markdown_ids,
            "caption_anchor_block_ids": caption_anchor_ids,
            "confidence": min(
                float(outer.get("confidence", 0)),
                float(inner.get("confidence", 0)),
            ),
            "signals": signals,
            "reason_codes": list(
                dict.fromkeys(
                    [
                        *outer.get("reason_codes", []),
                        *inner.get("reason_codes", []),
                        "nested_visual_overlap_deduplicated",
                    ]
                )
            ),
            "warning_codes": list(
                dict.fromkeys(
                    [
                        *outer.get("warning_codes", []),
                        *inner.get("warning_codes", []),
                    ]
                )
            ),
        }
        insert_at = min(outer_index, inner_index)
        remove_at = max(outer_index, inner_index)
        working.pop(remove_at)
        working[insert_at] = merged

    return working


def _axis_overlap(start_a: float, end_a: float, start_b: float, end_b: float) -> float:
    return max(0.0, min(end_a, end_b) - max(start_a, start_b))


def build_visual_adjacency(
    page_blocks: list[dict[str, Any]],
    *,
    gap_threshold: float = 20.0,
    overlap_ratio: float = 0.15,
) -> list[dict[str, Any]]:
    """Return conservative spatial edges between visual blocks."""

    visuals = [
        block
        for block in page_blocks
        if block.get("role") == "visual"
        and block.get("asset_path")
        and normalize_bbox(block.get("bbox_norm")) is not None
    ]
    edges: list[dict[str, Any]] = []
    for index, left in enumerate(visuals):
        left_bbox = normalize_bbox(left["bbox_norm"])
        assert left_bbox is not None
        lx0, ly0, lx1, ly1 = map(float, left_bbox)
        left_width = lx1 - lx0
        left_height = ly1 - ly0
        for right in visuals[index + 1 :]:
            right_bbox = normalize_bbox(right["bbox_norm"])
            assert right_bbox is not None
            rx0, ry0, rx1, ry1 = map(float, right_bbox)
            right_width = rx1 - rx0
            right_height = ry1 - ry0
            x_gap = max(0.0, max(lx0, rx0) - min(lx1, rx1))
            y_gap = max(0.0, max(ly0, ry0) - min(ly1, ry1))
            x_overlap = _axis_overlap(lx0, lx1, rx0, rx1)
            y_overlap = _axis_overlap(ly0, ly1, ry0, ry1)
            horizontally_near = (
                x_gap <= gap_threshold
                and y_overlap >= overlap_ratio * min(left_height, right_height)
            )
            vertically_near = (
                y_gap <= gap_threshold
                and x_overlap >= overlap_ratio * min(left_width, right_width)
            )
            if horizontally_near or vertically_near:
                edges.append(
                    {
                        "left_id": left["id"],
                        "right_id": right["id"],
                        "x_gap": _stable_number(x_gap),
                        "y_gap": _stable_number(y_gap),
                    }
                )
    return edges


def cluster_visual_blocks(
    page_blocks: list[dict[str, Any]],
    *,
    gap_threshold: float = 20.0,
    overlap_ratio: float = 0.15,
) -> list[list[dict[str, Any]]]:
    visuals = [
        block
        for block in page_blocks
        if block.get("role") == "visual"
        and block.get("asset_path")
        and normalize_bbox(block.get("bbox_norm")) is not None
    ]
    by_id = {block["id"]: block for block in visuals}
    adjacency: dict[str, set[str]] = {block_id: set() for block_id in by_id}
    for edge in build_visual_adjacency(
        visuals,
        gap_threshold=gap_threshold,
        overlap_ratio=overlap_ratio,
    ):
        left_id = edge["left_id"]
        right_id = edge["right_id"]
        adjacency[left_id].add(right_id)
        adjacency[right_id].add(left_id)

    components: list[list[dict[str, Any]]] = []
    visited: set[str] = set()
    for block in sorted(visuals, key=lambda value: value.get("page_order", 0)):
        block_id = block["id"]
        if block_id in visited:
            continue
        stack = [block_id]
        visited.add(block_id)
        component_ids: list[str] = []
        while stack:
            current = stack.pop()
            component_ids.append(current)
            for neighbor in sorted(adjacency[current], reverse=True):
                if neighbor not in visited:
                    visited.add(neighbor)
                    stack.append(neighbor)
        components.append(
            sorted(
                (by_id[item] for item in component_ids),
                key=lambda value: value.get("page_order", 0),
            )
        )
    return components


def _union_bbox(blocks: list[dict[str, Any]]) -> list[int | float]:
    boxes = [normalize_bbox(block.get("bbox_norm")) for block in blocks]
    valid = [bbox for bbox in boxes if bbox is not None]
    return [
        _stable_number(min(float(bbox[0]) for bbox in valid)),
        _stable_number(min(float(bbox[1]) for bbox in valid)),
        _stable_number(max(float(bbox[2]) for bbox in valid)),
        _stable_number(max(float(bbox[3]) for bbox in valid)),
    ]


def _markdown_context(
    blocks: list[dict[str, Any]], markdown_images: list[dict[str, Any]]
) -> tuple[list[str], bool, float, int | None]:
    image_order = {
        image["id"]: image["order"]
        for image in markdown_images
        if isinstance(image.get("id"), str) and isinstance(image.get("order"), int)
    }
    image_by_id = {
        image["id"]: image
        for image in markdown_images
        if isinstance(image.get("id"), str)
    }
    referenced_block_count = sum(
        1
        for block in blocks
        if any(image_id in image_order for image_id in block.get("markdown_image_ids", []))
    )
    image_ids = sorted(
        {
            image_id
            for block in blocks
            for image_id in block.get("markdown_image_ids", [])
            if image_id in image_order
        },
        key=image_order.__getitem__,
    )
    orders = [image_order[image_id] for image_id in image_ids]
    max_gap_chars: int | None = None
    if len(image_ids) >= 2:
        gaps = []
        for left_id, right_id in zip(image_ids, image_ids[1:]):
            left = image_by_id[left_id]
            right = image_by_id[right_id]
            left_end = left.get("char_end")
            right_start = right.get("char_start")
            if isinstance(left_end, int) and isinstance(right_start, int):
                gaps.append(max(0, right_start - left_end))
        if len(gaps) == len(image_ids) - 1:
            max_gap_chars = max(gaps, default=0)
    coverage = referenced_block_count / len(blocks) if blocks else 0.0
    contiguous = (
        len(orders) >= 2
        and max(orders) - min(orders) + 1 == len(orders)
        and coverage >= 0.80
        and max_gap_chars is not None
        and max_gap_chars <= 160
    )
    return image_ids, contiguous, coverage, max_gap_chars


def _components_share_extended_band(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    *,
    gap_threshold: float = 40.0,
    overlap_ratio: float = 0.65,
) -> bool:
    """Allow a slightly wider gap only when two components share a broad row/column."""

    left_bbox = _union_bbox(left)
    right_bbox = _union_bbox(right)
    lx0, ly0, lx1, ly1 = map(float, left_bbox)
    rx0, ry0, rx1, ry1 = map(float, right_bbox)
    left_width = lx1 - lx0
    left_height = ly1 - ly0
    right_width = rx1 - rx0
    right_height = ry1 - ry0
    x_gap = max(0.0, max(lx0, rx0) - min(lx1, rx1))
    y_gap = max(0.0, max(ly0, ry0) - min(ly1, ry1))
    x_overlap = _axis_overlap(lx0, lx1, rx0, rx1)
    y_overlap = _axis_overlap(ly0, ly1, ry0, ry1)
    vertically_aligned = (
        y_gap <= gap_threshold
        and x_overlap >= overlap_ratio * max(left_width, right_width)
    )
    horizontally_aligned = (
        x_gap <= gap_threshold
        and y_overlap >= overlap_ratio * max(left_height, right_height)
    )
    return vertically_aligned or horizontally_aligned


def merge_caption_anchored_components(
    components: list[list[dict[str, Any]]],
    markdown_images: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """Bridge split panel rows only with one explicit figure caption and MD continuity."""

    working = [
        sorted(component, key=lambda value: value.get("page_order", 0))
        for component in components
    ]
    working.sort(key=lambda value: (_union_bbox(value)[1], _union_bbox(value)[0]))
    while len(working) > 1:
        merged_pair = False
        for index in range(len(working) - 1):
            left = working[index]
            right = working[index + 1]
            if not _components_share_extended_band(left, right):
                continue
            combined = sorted(
                [*left, *right], key=lambda value: value.get("page_order", 0)
            )
            if len(combined) < 3:
                continue
            figure_anchor_count = sum(
                int(block.get("caption", {}).get("figure_anchor_count", 0))
                for block in combined
            )
            if figure_anchor_count != 1:
                continue
            _, markdown_contiguous, coverage, _ = _markdown_context(
                combined, markdown_images
            )
            if not markdown_contiguous or coverage < 0.80:
                continue
            union_area_fraction = _bbox_area(_union_bbox(combined)) / (
                COORDINATE_EXTENT**2
            )
            if not 0.03 <= union_area_fraction <= 0.80:
                continue
            working[index : index + 2] = [combined]
            working.sort(
                key=lambda value: (_union_bbox(value)[1], _union_bbox(value)[0])
            )
            merged_pair = True
            break
        if not merged_pair:
            break
    return working


def _nearest_following_formal_caption(
    component: list[dict[str, Any]], page_blocks: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Return the first formal caption after every visual in reading order."""

    if not component:
        return None
    last_order = max(int(block.get("page_order", -1)) for block in component)
    ordered = sorted(page_blocks, key=lambda block: block.get("page_order", 0))
    for block in ordered:
        if int(block.get("page_order", -1)) <= last_order:
            continue
        if block.get("role") not in {"text", "title"}:
            continue
        summary = block.get("text", {})
        if isinstance(summary, dict) and isinstance(
            summary.get("leading_formal_figure_caption_key"), str
        ):
            return block
    return None


def _caption_adjacency_score(
    caption_bbox: list[int | float], visual_bbox: list[int | float]
) -> float | None:
    caption_width = float(caption_bbox[2]) - float(caption_bbox[0])
    visual_width = float(visual_bbox[2]) - float(visual_bbox[0])
    shared_width = _axis_overlap(
        float(caption_bbox[0]),
        float(caption_bbox[2]),
        float(visual_bbox[0]),
        float(visual_bbox[2]),
    )
    overlap_ratio = shared_width / max(1.0, min(caption_width, visual_width))
    if overlap_ratio < 0.55:
        return None
    if float(caption_bbox[1]) >= float(visual_bbox[3]) - 20.0:
        gap = max(0.0, float(caption_bbox[1]) - float(visual_bbox[3]))
        if gap > 100.0:
            return None
    elif float(visual_bbox[1]) >= float(caption_bbox[3]) - 20.0:
        gap = max(0.0, float(visual_bbox[1]) - float(caption_bbox[3]))
        if gap > 80.0:
            return None
    else:
        return None
    return gap + (1.0 - overlap_ratio) * 40.0


def _components_are_coordinate_neighbours(
    left: list[dict[str, Any]], right: list[dict[str, Any]]
) -> bool:
    left_bbox = _union_bbox(left)
    right_bbox = _union_bbox(right)
    lx0, ly0, lx1, ly1 = map(float, left_bbox)
    rx0, ry0, rx1, ry1 = map(float, right_bbox)
    x_gap = max(0.0, max(lx0, rx0) - min(lx1, rx1))
    y_gap = max(0.0, max(ly0, ry0) - min(ly1, ry1))
    x_overlap = _axis_overlap(lx0, lx1, rx0, rx1)
    y_overlap = _axis_overlap(ly0, ly1, ry0, ry1)
    return (
        x_gap <= 65.0 and y_overlap >= 0.20 * min(ly1 - ly0, ry1 - ry0)
    ) or (
        y_gap <= 65.0 and x_overlap >= 0.20 * min(lx1 - lx0, rx1 - rx0)
    )


def merge_reading_order_caption_components(
    components: list[list[dict[str, Any]]],
    page_blocks: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """Merge close fragments only when the same next formal caption bounds them."""

    if len(components) < 2:
        return components
    anchors = {
        index: _nearest_following_formal_caption(component, page_blocks)
        for index, component in enumerate(components)
    }
    adjacency: dict[int, set[int]] = {
        index: set() for index in range(len(components))
    }
    for left_index, left in enumerate(components):
        left_anchor = anchors[left_index]
        if left_anchor is None:
            continue
        for right_index in range(left_index + 1, len(components)):
            right_anchor = anchors[right_index]
            if (
                right_anchor is None
                or right_anchor.get("id") != left_anchor.get("id")
                or not _components_are_coordinate_neighbours(
                    left, components[right_index]
                )
            ):
                continue
            adjacency[left_index].add(right_index)
            adjacency[right_index].add(left_index)

    merged: list[list[dict[str, Any]]] = []
    visited: set[int] = set()
    for start in range(len(components)):
        if start in visited:
            continue
        pending = [start]
        indexes: list[int] = []
        while pending:
            current = pending.pop()
            if current in visited:
                continue
            visited.add(current)
            indexes.append(current)
            pending.extend(adjacency[current] - visited)
        combined = sorted(
            [block for index in indexes for block in components[index]],
            key=lambda block: block.get("page_order", 0),
        )
        anchor = anchors[indexes[0]]
        caption_bbox = normalize_bbox(anchor.get("bbox_norm")) if anchor else None
        if (
            len(indexes) > 1
            and caption_bbox is not None
            and _caption_adjacency_score(caption_bbox, _union_bbox(combined)) is not None
        ):
            merged.append(combined)
        else:
            merged.extend(components[index] for index in sorted(indexes))
    return sorted(merged, key=lambda value: (_union_bbox(value)[1], _union_bbox(value)[0]))


def score_visual_group(
    blocks: list[dict[str, Any]],
    representatives: list[dict[str, Any]],
    adjacency_edges: list[dict[str, Any]],
    markdown_images: list[dict[str, Any]],
    *,
    replacement_mode: str,
    standalone_caption_anchor: bool = False,
) -> dict[str, Any]:
    """Score one candidate without using paper-specific text."""

    caption_char_count = sum(
        int(block.get("caption", {}).get("char_count", 0)) for block in blocks
    )
    long_caption_anchor_count = sum(
        int(block.get("caption", {}).get("long_item_count", 0)) for block in blocks
    )
    figure_caption_anchor_count = sum(
        int(block.get("caption", {}).get("figure_anchor_count", 0)) for block in blocks
    ) + int(standalone_caption_anchor)
    panel_label_count = sum(
        int(block.get("caption", {}).get("panel_label_count", 0)) for block in blocks
    )
    (
        markdown_ids,
        markdown_contiguous,
        markdown_reference_coverage,
        max_markdown_gap_chars,
    ) = _markdown_context(blocks, markdown_images)
    union = _union_bbox(representatives)
    union_area_fraction = _bbox_area(union) / (COORDINATE_EXTENT**2)

    reason_codes: list[str] = []
    warning_codes: list[str] = []
    if replacement_mode == "existing_asset":
        alias_count = max(0, len(blocks) - 1)
        confidence = 0.78 + min(0.12, alias_count * 0.03)
        reason_codes.append("enclosing_visual_asset")
        if long_caption_anchor_count:
            confidence += 0.05
            reason_codes.append("long_caption_attached")
        if markdown_contiguous:
            confidence += 0.05
            reason_codes.append("markdown_references_contiguous")
        if union_area_fraction > 0.85 and alias_count < 2:
            confidence = min(confidence, 0.79)
            warning_codes.append("near_full_page_enclosing_asset")
    else:
        confidence = 0.50
        if len(representatives) >= 3:
            confidence += 0.15
        else:
            confidence += 0.08
        if len(adjacency_edges) >= max(1, len(representatives) - 1):
            confidence += 0.10
            reason_codes.append("same_page_connected_visuals")
        if long_caption_anchor_count:
            confidence += 0.10
            reason_codes.append("long_caption_attached")
        if panel_label_count:
            confidence += 0.05
            reason_codes.append("panel_labels_detected")
        if standalone_caption_anchor:
            confidence += 0.12
            reason_codes.append("standalone_figure_caption_after_visuals")
        if markdown_contiguous:
            confidence += 0.10
            reason_codes.append("markdown_references_contiguous")
        if 0.03 <= union_area_fraction <= 0.80:
            confidence += 0.05
            reason_codes.append("plausible_union_area")
        if figure_caption_anchor_count > 1:
            confidence -= 0.25
            warning_codes.append("multiple_figure_caption_anchors")
        elif long_caption_anchor_count > 2 and figure_caption_anchor_count == 0:
            confidence -= 0.15
            warning_codes.append("multiple_long_caption_anchors")
        if union_area_fraction > 0.85:
            confidence -= 0.20
            warning_codes.append("near_full_page_union")

    strong_caption_evidence = (
        (long_caption_anchor_count > 0 or standalone_caption_anchor)
        and figure_caption_anchor_count == 1
    )
    strong_panel_grid_evidence = (
        replacement_mode == "pdf_crop"
        and len(representatives) >= 4
        and len(adjacency_edges) >= len(representatives) - 1
        and panel_label_count >= 2
        and markdown_reference_coverage >= 0.80
    )
    if not (strong_caption_evidence or strong_panel_grid_evidence):
        confidence = min(confidence, 0.79)
        warning_codes.append("insufficient_figure_anchor_evidence")
    if figure_caption_anchor_count > 1:
        confidence = min(confidence, 0.79)
        if "multiple_figure_caption_anchors" not in warning_codes:
            warning_codes.append("multiple_figure_caption_anchors")
    elif long_caption_anchor_count > 2 and figure_caption_anchor_count == 0:
        confidence = min(confidence, 0.79)
        if "multiple_long_caption_anchors" not in warning_codes:
            warning_codes.append("multiple_long_caption_anchors")

    confidence = round(max(0.0, min(0.99, confidence)), 3)
    if confidence >= 0.85:
        decision = "auto"
    elif confidence >= 0.65:
        decision = "review"
    else:
        decision = "skip"
    return {
        "confidence": confidence,
        "decision": decision,
        "markdown_image_ids": markdown_ids,
        "signals": {
            "member_count": len(blocks),
            "representative_count": len(representatives),
            "adjacent_pair_count": len(adjacency_edges),
            "caption_char_count": caption_char_count,
            "long_caption_anchor_count": long_caption_anchor_count,
            "figure_caption_anchor_count": figure_caption_anchor_count,
            "panel_label_count": panel_label_count,
            "markdown_references_contiguous": markdown_contiguous,
            "markdown_reference_coverage": round(markdown_reference_coverage, 4),
            "max_markdown_gap_chars": max_markdown_gap_chars,
            "union_area_fraction": round(union_area_fraction, 4),
        },
        "reason_codes": reason_codes,
        "warning_codes": warning_codes,
    }


def _root_parent(block_id: str, parent_by_child: dict[str, str]) -> str:
    seen: set[str] = set()
    current = block_id
    while current in parent_by_child and current not in seen:
        seen.add(current)
        current = parent_by_child[current]
    return current


def _top_text_block(block: dict[str, Any], *, y0_limit: float = 320.0) -> bool:
    if block.get("role") not in {"text", "title"}:
        return False
    bbox = normalize_bbox(block.get("bbox_norm"))
    return bbox is not None and float(bbox[1]) <= y0_limit


def _same_top_caption_band(
    anchor: dict[str, Any], candidate: dict[str, Any]
) -> bool:
    """Recognize only a directly adjacent top-page caption column."""

    anchor_bbox = normalize_bbox(anchor.get("bbox_norm"))
    candidate_bbox = normalize_bbox(candidate.get("bbox_norm"))
    if anchor_bbox is None or candidate_bbox is None:
        return False
    ax0, ay0, ax1, ay1 = map(float, anchor_bbox)
    cx0, cy0, cx1, cy1 = map(float, candidate_bbox)
    if abs(ay0 - cy0) > 45.0:
        return False
    x_overlap = _axis_overlap(ax0, ax1, cx0, cx1)
    if x_overlap > 0:
        return False
    x_gap = max(0.0, max(ax0, cx0) - min(ax1, cx1))
    if x_gap > 80.0:
        return False
    anchor_height = ay1 - ay0
    candidate_height = cy1 - cy0
    y_overlap = _axis_overlap(ay0, ay1, cy0, cy1)
    if y_overlap < 0.55 * min(anchor_height, candidate_height):
        return False
    height_ratio = candidate_height / anchor_height
    return 0.45 <= height_ratio <= 2.2


def _block_char_count(block: dict[str, Any]) -> int:
    value = block.get("text", {}).get("char_count")
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return max(0, value)


def _scan_next_page_caption_candidates(
    target_blocks: list[dict[str, Any]], figure_key: str
) -> tuple[list[dict[str, Any]], list[str], str | None]:
    """Scan from the page top and stop at the first reading-order boundary."""

    candidates: list[dict[str, Any]] = []
    alternate_keys: set[str] = set()
    boundary_code: str | None = None
    ordered = sorted(target_blocks, key=lambda block: block.get("page_order", 0))
    for block in ordered:
        role = block.get("role")
        if role == "marginalia":
            continue
        if role == "visual":
            boundary_code = "visual_boundary"
            break
        if role not in {"text", "title"}:
            if role in {"table", "equation"}:
                boundary_code = f"{role}_boundary"
                break
            continue

        char_count = _block_char_count(block)
        if char_count <= 0:
            continue
        if not _top_text_block(block):
            boundary_code = "body_band_boundary"
            break

        text_summary = block.get("text", {})
        formal_key = text_summary.get("leading_formal_figure_caption_key")
        leading_key = text_summary.get("leading_figure_key")
        if not candidates:
            if formal_key == figure_key:
                candidates.append(block)
                continue
            if isinstance(leading_key, str):
                alternate_keys.add(leading_key)
                boundary_code = (
                    "different_figure_key"
                    if leading_key != figure_key
                    else "nonformal_figure_reference"
                )
            elif role == "title":
                boundary_code = "title_boundary"
            else:
                boundary_code = "body_text_boundary"
            break

        anchor = candidates[0]
        if formal_key == figure_key and _same_top_caption_band(anchor, block):
            candidates.append(block)
            boundary_code = "duplicate_formal_caption_anchor"
            break
        if isinstance(leading_key, str):
            alternate_keys.add(leading_key)
            boundary_code = (
                "different_figure_key"
                if leading_key != figure_key
                else "another_figure_anchor"
            )
        elif role == "title":
            boundary_code = "title_boundary"
        else:
            boundary_code = "body_text_boundary"
        break
    return candidates, sorted(alternate_keys), boundary_code


def _collect_cross_page_caption_blocks(
    anchor: dict[str, Any], target_blocks: list[dict[str, Any]]
) -> tuple[list[str], str, list[str]]:
    """Collect one safe adjacent column without crossing reading boundaries."""

    caption_ids = [anchor["id"]]
    reason_codes: list[str] = []
    anchor_summary = anchor.get("text", {})
    if anchor_summary.get("ends_with_terminal_punctuation") is True:
        return caption_ids, "complete", reason_codes

    ordered = sorted(target_blocks, key=lambda block: block.get("page_order", 0))
    try:
        anchor_position = next(
            index
            for index, block in enumerate(ordered)
            if block.get("id") == anchor.get("id")
        )
    except StopIteration:
        reason_codes.append("caption_anchor_missing_from_target_page")
        return caption_ids, "partial", reason_codes

    for continuation in ordered[anchor_position + 1 :]:
        role = continuation.get("role")
        if role == "marginalia":
            continue
        if role == "visual":
            reason_codes.append("visual_boundary_before_caption_continuation")
            return caption_ids, "partial", reason_codes
        if role not in {"text", "title"}:
            if role in {"table", "equation"}:
                reason_codes.append(f"{role}_boundary_before_caption_continuation")
                return caption_ids, "partial", reason_codes
            continue

        text_summary = continuation.get("text", {})
        if _block_char_count(continuation) <= 0:
            if _same_top_caption_band(anchor, continuation):
                reason_codes.append("empty_adjacent_caption_column")
                return caption_ids, "partial", reason_codes
            continue
        if text_summary.get("leading_figure_key") is not None:
            reason_codes.append("new_figure_anchor_in_adjacent_column")
            return caption_ids, "partial", reason_codes
        if role == "title":
            reason_codes.append("title_band_in_adjacent_column")
            return caption_ids, "partial", reason_codes
        if not _same_top_caption_band(anchor, continuation):
            reason_codes.append("body_text_boundary_before_caption_continuation")
            return caption_ids, "partial", reason_codes
        if not (
            text_summary.get("starts_with_lowercase") is True
            or text_summary.get("starts_with_panel_label") is True
        ):
            reason_codes.append("uncertain_adjacent_caption_continuation")
            return caption_ids, "partial", reason_codes

        caption_ids.append(continuation["id"])
        if text_summary.get("ends_with_terminal_punctuation") is True:
            return caption_ids, "complete", reason_codes
        reason_codes.append("unterminated_caption_continuation")
        return caption_ids, "partial", reason_codes

    reason_codes.append("unterminated_caption_anchor")
    return caption_ids, "partial", reason_codes


def _build_cross_page_caption_links(
    viewer_index: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Link explicit next-page placeholders to unique formal captions."""

    pages = {
        page.get("page_idx"): page.get("blocks", [])
        for page in viewer_index.get("pages", [])
        if isinstance(page, dict)
        and isinstance(page.get("page_idx"), int)
        and isinstance(page.get("blocks"), list)
    }
    links: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for source_page_idx in sorted(pages):
        source_blocks = pages[source_page_idx]
        for visual in source_blocks:
            if (
                visual.get("role") != "visual"
                or not visual.get("asset_path")
                or normalize_bbox(visual.get("bbox_norm")) is None
            ):
                continue
            caption = visual.get("caption", {})
            if caption.get("next_page_marker") is not True:
                continue
            figure_keys = caption.get("figure_keys", [])
            marker_keys = caption.get("next_page_figure_keys", [])
            if (
                not isinstance(figure_keys, list)
                or not isinstance(marker_keys, list)
                or len(figure_keys) != 1
                or len(marker_keys) != 1
                or figure_keys[0] != marker_keys[0]
            ):
                issues.append(
                    {
                        "code": "ambiguous_visual_next_page_figure_key",
                        "visual_block_id": visual.get("id"),
                        "source_page_idx": source_page_idx,
                    }
                )
                continue

            figure_key = figure_keys[0]
            target_page_idx = source_page_idx + 1
            target_blocks = pages.get(target_page_idx)
            if target_blocks is None:
                issues.append(
                    {
                        "code": "next_page_figure_caption_not_found",
                        "visual_block_id": visual.get("id"),
                        "source_page_idx": source_page_idx,
                        "target_page_idx": target_page_idx,
                        "figure_key": figure_key,
                    }
                )
                continue

            candidates, alternate_keys, scan_boundary = (
                _scan_next_page_caption_candidates(target_blocks, figure_key)
            )
            if len(candidates) > 1:
                issue = {
                    "code": "ambiguous_next_page_figure_caption",
                    "visual_block_id": visual.get("id"),
                    "source_page_idx": source_page_idx,
                    "target_page_idx": target_page_idx,
                    "figure_key": figure_key,
                    "candidate_count": len(candidates),
                }
                if scan_boundary:
                    issue["scan_boundary"] = scan_boundary
                issues.append(issue)
                continue
            if not candidates:
                issue: dict[str, Any] = {
                    "code": "next_page_figure_caption_not_found",
                    "visual_block_id": visual.get("id"),
                    "source_page_idx": source_page_idx,
                    "target_page_idx": target_page_idx,
                    "figure_key": figure_key,
                }
                if alternate_keys:
                    issue["alternate_figure_keys"] = alternate_keys
                if scan_boundary:
                    issue["scan_boundary"] = scan_boundary
                issues.append(issue)
                continue

            caption_ids, status, reason_codes = _collect_cross_page_caption_blocks(
                candidates[0], target_blocks
            )
            links.append(
                {
                    "visual_block_id": visual["id"],
                    "caption_block_ids": caption_ids,
                    "source_page_idx": source_page_idx,
                    "target_page_idx": target_page_idx,
                    "figure_key": figure_key,
                    "relation": "next_page_figure_caption",
                    "status": status,
                }
            )
            if status == "partial":
                issues.append(
                    {
                        "code": "partial_next_page_figure_caption",
                        "visual_block_id": visual["id"],
                        "source_page_idx": source_page_idx,
                        "target_page_idx": target_page_idx,
                        "figure_key": figure_key,
                        "reason_codes": reason_codes,
                    }
                )
    return links, issues


def build_visual_repair(viewer_index: dict[str, Any]) -> dict[str, Any]:
    """Build a non-destructive visual repair plan from a viewer index."""

    markdown_images = viewer_index.get("markdown_images", [])
    groups: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    eligible_visual_count = 0

    for page in viewer_index.get("pages", []):
        page_idx = page.get("page_idx")
        page_blocks = page.get("blocks", [])
        visuals = [
            block
            for block in page_blocks
            if block.get("role") == "visual"
            and block.get("asset_path")
            and normalize_bbox(block.get("bbox_norm")) is not None
        ]
        eligible_visual_count += len(visuals)
        if not visuals:
            continue

        relations = find_enclosing_visuals(visuals)
        parent_by_child = {
            relation["child_id"]: relation["parent_id"] for relation in relations
        }
        by_id = {block["id"]: block for block in visuals}
        aliases_by_root: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for child_id in parent_by_child:
            root_id = _root_parent(child_id, parent_by_child)
            if root_id in by_id:
                aliases_by_root[root_id].append(by_id[child_id])

        representatives = [
            block for block in visuals if block["id"] not in parent_by_child
        ]
        components = merge_reading_order_caption_components(
            merge_caption_anchored_components(
                cluster_visual_blocks(representatives), markdown_images
            ),
            page_blocks,
        )
        page_candidates: list[
            tuple[
                list[int | float],
                list[dict[str, Any]],
                list[dict[str, Any]],
            ]
        ] = []
        for component in components:
            members = list(component)
            for representative in component:
                members.extend(aliases_by_root.get(representative["id"], []))
            members = sorted(
                {block["id"]: block for block in members}.values(),
                key=lambda value: value.get("page_order", 0),
            )
            has_aliases = len(members) > len(component)
            if len(component) == 1 and not has_aliases:
                continue
            page_candidates.append((_union_bbox(component), component, members))

        page_candidates.sort(key=lambda value: (value[0][1], value[0][0]))
        for group_order, (union_bbox, component, members) in enumerate(page_candidates):
            edges = build_visual_adjacency(component)
            following_caption = _nearest_following_formal_caption(
                component, page_blocks
            )
            following_caption_bbox = (
                normalize_bbox(following_caption.get("bbox_norm"))
                if following_caption is not None
                else None
            )
            attached_caption_count = sum(
                int(block.get("caption", {}).get("figure_anchor_count", 0))
                for block in members
            )
            has_standalone_caption_anchor = bool(
                attached_caption_count == 0
                and following_caption_bbox is not None
                and _caption_adjacency_score(
                    following_caption_bbox, union_bbox
                ) is not None
            )
            replacement_mode = (
                "existing_asset" if len(component) == 1 and len(members) > 1 else "pdf_crop"
            )
            score = score_visual_group(
                members,
                component,
                edges,
                markdown_images,
                replacement_mode=replacement_mode,
                standalone_caption_anchor=has_standalone_caption_anchor,
            )
            strict_component_count = len(cluster_visual_blocks(component))
            if strict_component_count > 1:
                score["signals"]["caption_anchored_component_count"] = (
                    strict_component_count
                )
                score["reason_codes"].append("caption_anchored_spatial_bridge")
            if replacement_mode == "existing_asset":
                replacement = {
                    "mode": "existing_asset",
                    "block_id": component[0]["id"],
                    "asset_path": component[0]["asset_path"],
                }
            else:
                replacement = {
                    "mode": "pdf_crop",
                    "bbox_norm": union_bbox,
                    "padding_norm": 6,
                }
            caption_anchor_block_ids = [
                block["id"]
                for block in members
                if int(block.get("caption", {}).get("long_item_count", 0)) > 0
            ]
            if has_standalone_caption_anchor and following_caption is not None:
                caption_anchor_block_ids.append(following_caption["id"])
            groups.append(
                {
                    "id": f"vr-p{int(page_idx):04d}-g{group_order:04d}",
                    "page_idx": page_idx,
                    "member_block_ids": [block["id"] for block in members],
                    "member_asset_paths": sorted(
                        {block["asset_path"] for block in members if block.get("asset_path")}
                    ),
                    "member_markdown_image_ids": score.pop("markdown_image_ids"),
                    "caption_anchor_block_ids": caption_anchor_block_ids,
                    "decision": score.pop("decision"),
                    "confidence": score.pop("confidence"),
                    "replacement": replacement,
                    "signals": score.pop("signals"),
                    "reason_codes": score.pop("reason_codes"),
                    "warning_codes": score.pop("warning_codes"),
                    "fallback": "original_assets",
                }
            )

    groups = merge_nested_visual_repair_groups(groups, viewer_index)
    caption_links, caption_link_issues = _build_cross_page_caption_links(viewer_index)
    issues.extend(caption_link_issues)
    if eligible_visual_count == 0:
        status = "unavailable"
        issues.append({"code": "no_locatable_visual_blocks"})
    elif viewer_index.get("status") == "complete":
        status = "complete"
    else:
        status = "partial"

    decisions = Counter(group["decision"] for group in groups)
    caption_link_statuses = Counter(link["status"] for link in caption_links)
    return {
        "schema_version": VISUAL_REPAIR_SCHEMA_VERSION,
        "algorithm_version": VISUAL_REPAIR_ALGORITHM_VERSION,
        "status": status,
        "viewer_index": "viewer-index.json",
        "inputs": viewer_index.get("inputs", {}),
        "render_requirements": {
            "pdf_crop_requires_original_pdf": True,
            "fallback": "original_assets",
        },
        "summary": {
            "eligible_visual_count": eligible_visual_count,
            "group_count": len(groups),
            "auto_group_count": decisions["auto"],
            "review_group_count": decisions["review"],
            "skipped_group_count": decisions["skip"],
            "caption_link_count": len(caption_links),
            "complete_caption_link_count": caption_link_statuses["complete"],
            "partial_caption_link_count": caption_link_statuses["partial"],
        },
        "groups": groups,
        "caption_links": caption_links,
        "issues": issues,
    }


def _validate_detection_summary(summary: Any, label: str) -> list[str]:
    if not isinstance(summary, dict):
        return [f"invalid viewer {label} summary"]
    errors: list[str] = []
    figure_keys = summary.get("figure_keys")
    if not isinstance(figure_keys, list) or any(
        not isinstance(key, str) or not NORMALIZED_FIGURE_KEY_RE.fullmatch(key)
        for key in figure_keys
    ):
        errors.append(f"invalid viewer {label} figure_keys")
        figure_keys = []
    elif len(set(figure_keys)) != len(figure_keys):
        errors.append(f"duplicate viewer {label} figure_keys")
    leading_key = summary.get("leading_figure_key")
    if leading_key is not None and (
        not isinstance(leading_key, str)
        or not NORMALIZED_FIGURE_KEY_RE.fullmatch(leading_key)
        or leading_key not in figure_keys
    ):
        errors.append(f"invalid viewer {label} leading_figure_key")
    formal_keys = summary.get("formal_figure_caption_keys")
    if not isinstance(formal_keys, list) or any(
        not isinstance(key, str)
        or not NORMALIZED_FIGURE_KEY_RE.fullmatch(key)
        or key not in figure_keys
        for key in formal_keys
    ):
        errors.append(f"invalid viewer {label} formal_figure_caption_keys")
        formal_keys = []
    elif len(set(formal_keys)) != len(formal_keys):
        errors.append(f"duplicate viewer {label} formal_figure_caption_keys")
    leading_formal_key = summary.get("leading_formal_figure_caption_key")
    if leading_formal_key is not None and (
        not isinstance(leading_formal_key, str)
        or not NORMALIZED_FIGURE_KEY_RE.fullmatch(leading_formal_key)
        or leading_formal_key not in formal_keys
        or leading_formal_key != leading_key
    ):
        errors.append(f"invalid viewer {label} leading_formal_figure_caption_key")
    marker_keys = summary.get("next_page_figure_keys")
    if not isinstance(marker_keys, list) or any(
        not isinstance(key, str)
        or not NORMALIZED_FIGURE_KEY_RE.fullmatch(key)
        or key not in figure_keys
        for key in marker_keys
    ):
        errors.append(f"invalid viewer {label} next_page_figure_keys")
        marker_keys = []
    elif len(set(marker_keys)) != len(marker_keys):
        errors.append(f"duplicate viewer {label} next_page_figure_keys")
    placeholders = summary.get("next_page_placeholders")
    placeholder_keys: list[str] = []
    if not isinstance(placeholders, list):
        errors.append(f"invalid viewer {label} next_page_placeholders")
        placeholders = []
    else:
        seen_placeholder_indices: set[int] = set()
        for position, placeholder in enumerate(placeholders):
            if not isinstance(placeholder, dict):
                errors.append(
                    f"invalid viewer {label} next-page placeholder: {position}"
                )
                continue
            index = placeholder.get("index")
            text = placeholder.get("text")
            figure_key = placeholder.get("figure_key")
            if (
                isinstance(index, bool)
                or not isinstance(index, int)
                or index < 0
                or index in seen_placeholder_indices
            ):
                errors.append(
                    f"invalid viewer {label} next-page placeholder index: {position}"
                )
            else:
                seen_placeholder_indices.add(index)
            expected_key = (
                _next_page_caption_placeholder_key(text)
                if isinstance(text, str) and text == text.strip()
                else None
            )
            if expected_key is None or figure_key != expected_key:
                errors.append(
                    f"invalid viewer {label} next-page placeholder span: {position}"
                )
                continue
            placeholder_keys.append(figure_key)
    expected_marker_keys = list(dict.fromkeys(placeholder_keys))
    if marker_keys != expected_marker_keys:
        errors.append(
            f"viewer {label} next_page_figure_keys disagree with placeholders"
        )
    if not isinstance(summary.get("next_page_marker"), bool):
        errors.append(f"invalid viewer {label} next_page_marker")
    elif summary["next_page_marker"] is not bool(placeholders):
        errors.append(f"viewer {label} next_page_marker disagrees with placeholders")
    for field in (
        "starts_with_lowercase",
        "starts_with_panel_label",
        "ends_with_terminal_punctuation",
    ):
        if not isinstance(summary.get(field), bool):
            errors.append(f"invalid viewer {label} {field}")
    return errors


def _validate_caption_items(summary: Any, label: str) -> list[str]:
    """Validate additive caption atoms while accepting legacy summaries."""

    if not isinstance(summary, dict) or "items" not in summary:
        return []
    items = summary.get("items")
    if not isinstance(items, list):
        return [f"invalid viewer {label} items"]

    errors: list[str] = []
    texts: list[str] = []
    for position, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append(f"invalid viewer {label} caption item: {position}")
            continue
        index = item.get("index")
        text = item.get("text")
        kind = item.get("kind")
        if isinstance(index, bool) or not isinstance(index, int) or index != position:
            errors.append(f"invalid viewer {label} caption item index: {position}")
        if not isinstance(text, str) or not text or text != text.strip():
            errors.append(f"invalid viewer {label} caption item text: {position}")
            continue
        texts.append(text)
        if kind not in CAPTION_ITEM_KINDS:
            errors.append(f"invalid viewer {label} caption item kind: {position}")
            continue

        expected_kind, expected_figure_key = _caption_item_kind(text)
        if kind != expected_kind:
            errors.append(f"misclassified viewer {label} caption item: {position}")
        figure_key = item.get("figure_key")
        if expected_figure_key is None:
            if figure_key is not None:
                errors.append(
                    f"unexpected viewer {label} caption item figure_key: {position}"
                )
        elif figure_key != expected_figure_key:
            errors.append(f"invalid viewer {label} caption item figure_key: {position}")

    if len(texts) != len(items):
        return errors
    if summary.get("next_page_placeholders") != _next_page_placeholders(texts):
        errors.append(f"viewer {label} items disagree with next_page_placeholders")
    expected_counts = {
        "item_count": len(texts),
        "char_count": sum(len(text) for text in texts),
        "long_item_count": sum(len(text) >= 30 for text in texts),
        "figure_anchor_count": sum(
            _formal_figure_caption_key(text) is not None for text in texts
        ),
        "panel_label_count": sum(
            _caption_item_kind(text)[0] == "panel-label" for text in texts
        ),
    }
    for field, expected in expected_counts.items():
        if summary.get(field) != expected:
            errors.append(f"viewer {label} items disagree with {field}")
    return errors


def validate_viewer_index(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["viewer index is not an object"]
    if payload.get("schema_version") != VIEWER_INDEX_SCHEMA_VERSION:
        errors.append("unsupported viewer index schema_version")
    if payload.get("status") not in {"complete", "partial", "unavailable"}:
        errors.append("invalid viewer index status")
    inputs = payload.get("inputs")
    if not isinstance(inputs, dict):
        errors.append("viewer index inputs is not an object")
    else:
        for input_name in ("article", "mineru_result"):
            input_record = inputs.get(input_name)
            digest = input_record.get("sha256") if isinstance(input_record, dict) else None
            if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest.lower()):
                errors.append(f"invalid viewer input sha256: {input_name}")
    markdown_images = payload.get("markdown_images")
    markdown_ids: set[str] = set()
    if not isinstance(markdown_images, list):
        errors.append("viewer index markdown_images is not an array")
    else:
        for image in markdown_images:
            if not isinstance(image, dict) or not isinstance(image.get("id"), str):
                errors.append("invalid viewer Markdown image record")
                continue
            image_id = image["id"]
            if image_id in markdown_ids:
                errors.append(f"duplicate viewer Markdown image id: {image_id}")
            markdown_ids.add(image_id)
            asset_path = image.get("asset_path")
            if _normalize_asset_path(asset_path) != asset_path:
                errors.append(f"unsafe viewer Markdown image path: {image_id}")
    pages = payload.get("pages")
    if not isinstance(pages, list):
        return [*errors, "viewer index pages is not an array"]
    block_ids: set[str] = set()
    page_indices: set[int] = set()
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get("blocks"), list):
            errors.append("invalid viewer page record")
            continue
        page_idx = page.get("page_idx")
        if isinstance(page_idx, bool) or not isinstance(page_idx, int) or page_idx < 0:
            errors.append("invalid viewer page index")
        elif page_idx in page_indices:
            errors.append(f"duplicate viewer page index: {page_idx}")
        else:
            page_indices.add(page_idx)
        for block in page["blocks"]:
            if not isinstance(block, dict) or not isinstance(block.get("id"), str):
                errors.append("invalid viewer block record")
                continue
            if block["id"] in block_ids:
                errors.append(f"duplicate viewer block id: {block['id']}")
            block_ids.add(block["id"])
            bbox = block.get("bbox_norm")
            if bbox is not None and normalize_bbox(bbox) is None:
                errors.append(f"invalid viewer block bbox: {block['id']}")
            asset_path = block.get("asset_path")
            if asset_path is not None and _normalize_asset_path(asset_path) != asset_path:
                errors.append(f"unsafe viewer block asset path: {block['id']}")
            errors.extend(
                _validate_detection_summary(block.get("text"), f"text: {block['id']}")
            )
            errors.extend(
                _validate_detection_summary(
                    block.get("caption"), f"caption: {block['id']}"
                )
            )
            errors.extend(
                _validate_caption_items(
                    block.get("caption"), f"caption: {block['id']}"
                )
            )
            for image_id in block.get("markdown_image_ids", []):
                if image_id not in markdown_ids:
                    errors.append(f"unknown block Markdown image: {image_id}")
    return errors


def validate_visual_repair(
    payload: Any, viewer_index: dict[str, Any]
) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["visual repair is not an object"]
    if payload.get("schema_version") != VISUAL_REPAIR_SCHEMA_VERSION:
        errors.append("unsupported visual repair schema_version")
    if payload.get("algorithm_version") != VISUAL_REPAIR_ALGORITHM_VERSION:
        errors.append("unsupported visual repair algorithm_version")
    if payload.get("status") not in {"complete", "partial", "unavailable"}:
        errors.append("invalid visual repair status")
    groups = payload.get("groups")
    if not isinstance(groups, list):
        return [*errors, "visual repair groups is not an array"]
    known_blocks: set[str] = set()
    block_page: dict[str, int] = {}
    block_by_id: dict[str, dict[str, Any]] = {}
    block_role: dict[str, str] = {}
    page_blocks_by_idx: dict[int, list[dict[str, Any]]] = {}
    for page in viewer_index.get("pages", []):
        page_idx = page.get("page_idx")
        if isinstance(page_idx, int) and isinstance(page.get("blocks"), list):
            page_blocks_by_idx[page_idx] = page["blocks"]
        for block in page.get("blocks", []):
            if isinstance(block, dict) and isinstance(block.get("id"), str):
                known_blocks.add(block["id"])
                block_page[block["id"]] = page_idx
                block_by_id[block["id"]] = block
                block_role[block["id"]] = block.get("role")
    known_markdown_images = {
        image["id"]
        for image in viewer_index.get("markdown_images", [])
        if isinstance(image, dict) and isinstance(image.get("id"), str)
    }
    used_blocks: set[str] = set()
    for group in groups:
        if not isinstance(group, dict):
            errors.append("invalid visual repair group")
            continue
        confidence = group.get("confidence")
        if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            errors.append(f"invalid visual repair confidence: {group.get('id')}")
        if group.get("decision") not in {"auto", "review", "skip"}:
            errors.append(f"invalid visual repair decision: {group.get('id')}")
        member_ids = group.get("member_block_ids", [])
        if not isinstance(member_ids, list) or not member_ids:
            errors.append(f"visual repair group has no members: {group.get('id')}")
        for block_id in member_ids:
            if block_id not in known_blocks:
                errors.append(f"unknown visual repair block: {block_id}")
            if block_id in used_blocks:
                errors.append(f"visual repair block appears in multiple groups: {block_id}")
            used_blocks.add(block_id)
            if block_id in block_page and block_page[block_id] != group.get("page_idx"):
                errors.append(f"visual repair member is on another page: {block_id}")
        for image_id in group.get("member_markdown_image_ids", []):
            if image_id not in known_markdown_images:
                errors.append(f"unknown visual repair Markdown image: {image_id}")
        external_caption_anchors: list[str] = []
        for block_id in group.get("caption_anchor_block_ids", []):
            if block_id in member_ids:
                continue
            if (
                block_id not in known_blocks
                or block_page.get(block_id) != group.get("page_idx")
                or block_role.get(block_id) not in {"text", "title"}
            ):
                errors.append(f"invalid standalone visual repair caption anchor: {block_id}")
                continue
            external_caption_anchors.append(block_id)
        if external_caption_anchors:
            member_blocks = [
                block_by_id[block_id]
                for block_id in member_ids
                if block_id in block_by_id
            ]
            expected_anchor = _nearest_following_formal_caption(
                member_blocks, page_blocks_by_idx.get(group.get("page_idx"), [])
            )
            if (
                len(external_caption_anchors) != 1
                or expected_anchor is None
                or external_caption_anchors[0] != expected_anchor.get("id")
            ):
                errors.append(
                    f"visual repair standalone caption anchor is not the nearest following formal caption: {group.get('id')}"
                )
            else:
                caption_bbox = normalize_bbox(expected_anchor.get("bbox_norm"))
                member_bbox = (
                    _union_bbox(member_blocks)
                    if member_blocks
                    and all(
                        normalize_bbox(block.get("bbox_norm")) is not None
                        for block in member_blocks
                    )
                    else None
                )
                if (
                    caption_bbox is None
                    or member_bbox is None
                    or _caption_adjacency_score(caption_bbox, member_bbox) is None
                ):
                    errors.append(
                        f"visual repair standalone caption anchor is not spatially adjacent: {group.get('id')}"
                    )
        replacement = group.get("replacement")
        if not isinstance(replacement, dict):
            errors.append(f"missing visual repair replacement: {group.get('id')}")
        elif replacement.get("mode") == "pdf_crop":
            crop_bbox = normalize_bbox(replacement.get("bbox_norm"))
            if crop_bbox is None:
                errors.append(f"invalid visual repair crop bbox: {group.get('id')}")
            else:
                member_boxes = [
                    normalize_bbox(block_by_id[block_id].get("bbox_norm"))
                    for block_id in member_ids
                    if block_id in block_by_id
                ]
                for member_bbox in (bbox for bbox in member_boxes if bbox is not None):
                    if _intersection_area(crop_bbox, member_bbox) < _bbox_area(member_bbox):
                        errors.append(
                            f"visual repair crop does not cover member: {group.get('id')}"
                        )
                        break
        elif replacement.get("mode") == "existing_asset":
            replacement_path = replacement.get("asset_path")
            if _normalize_asset_path(replacement_path) != replacement_path:
                errors.append(f"missing visual repair existing asset: {group.get('id')}")
            replacement_block_id = replacement.get("block_id")
            if replacement_block_id not in member_ids:
                errors.append(
                    f"visual repair existing asset block is not a member: {group.get('id')}"
                )
        else:
            errors.append(f"unsupported visual repair mode: {group.get('id')}")

    caption_links = payload.get("caption_links")
    if not isinstance(caption_links, list):
        return [*errors, "visual repair caption_links is not an array"]
    linked_visuals: set[str] = set()
    used_caption_blocks: set[str] = set()
    for link in caption_links:
        if not isinstance(link, dict):
            errors.append("invalid visual repair caption link")
            continue
        visual_block_id = link.get("visual_block_id")
        if not isinstance(visual_block_id, str) or visual_block_id not in known_blocks:
            errors.append(f"unknown caption-link visual block: {visual_block_id}")
        else:
            if block_role.get(visual_block_id) != "visual":
                errors.append(f"caption-link source is not visual: {visual_block_id}")
            if visual_block_id in linked_visuals:
                errors.append(f"visual has multiple caption links: {visual_block_id}")
            linked_visuals.add(visual_block_id)

        source_page_idx = link.get("source_page_idx")
        target_page_idx = link.get("target_page_idx")
        if (
            isinstance(source_page_idx, bool)
            or not isinstance(source_page_idx, int)
            or source_page_idx < 0
        ):
            errors.append(f"invalid caption-link source page: {visual_block_id}")
        elif block_page.get(visual_block_id) != source_page_idx:
            errors.append(f"caption-link visual is on another page: {visual_block_id}")
        if (
            isinstance(target_page_idx, bool)
            or not isinstance(target_page_idx, int)
            or target_page_idx < 0
        ):
            errors.append(f"invalid caption-link target page: {visual_block_id}")
        elif isinstance(source_page_idx, int) and target_page_idx != source_page_idx + 1:
            errors.append(f"caption-link target is not the next page: {visual_block_id}")

        figure_key = link.get("figure_key")
        if not isinstance(figure_key, str) or not NORMALIZED_FIGURE_KEY_RE.fullmatch(
            figure_key
        ):
            errors.append(f"invalid caption-link figure_key: {visual_block_id}")
        elif isinstance(visual_block_id, str) and visual_block_id in block_by_id:
            visual_caption = block_by_id[visual_block_id].get("caption", {})
            if (
                visual_caption.get("next_page_marker") is not True
                or visual_caption.get("next_page_figure_keys") != [figure_key]
                or visual_caption.get("figure_keys") != [figure_key]
            ):
                errors.append(
                    f"caption-link visual lacks an unambiguous marker: {visual_block_id}"
                )
        if link.get("relation") != "next_page_figure_caption":
            errors.append(f"invalid caption-link relation: {visual_block_id}")
        if link.get("status") not in {"complete", "partial"}:
            errors.append(f"invalid caption-link status: {visual_block_id}")

        caption_block_ids = link.get("caption_block_ids")
        if not isinstance(caption_block_ids, list) or not caption_block_ids:
            errors.append(f"caption link has no caption blocks: {visual_block_id}")
            continue
        if not all(isinstance(block_id, str) for block_id in caption_block_ids):
            errors.append(f"invalid caption block id in link: {visual_block_id}")
        elif len(set(caption_block_ids)) != len(caption_block_ids):
            errors.append(f"duplicate blocks in caption link: {visual_block_id}")
        for position, caption_block_id in enumerate(caption_block_ids):
            if not isinstance(caption_block_id, str) or caption_block_id not in known_blocks:
                errors.append(f"unknown caption-link caption block: {caption_block_id}")
                continue
            if caption_block_id in used_caption_blocks:
                errors.append(
                    f"caption block appears in multiple links: {caption_block_id}"
                )
            used_caption_blocks.add(caption_block_id)
            if caption_block_id in used_blocks:
                errors.append(
                    f"cross-page caption block is also a group member: {caption_block_id}"
                )
            if block_page.get(caption_block_id) != target_page_idx:
                errors.append(
                    f"caption-link caption block is on another page: {caption_block_id}"
                )
            if block_role.get(caption_block_id) not in {"text", "title"}:
                errors.append(
                    f"caption-link target is not text/title: {caption_block_id}"
                )
            text_summary = block_by_id[caption_block_id].get("text", {})
            char_count = text_summary.get("char_count")
            if (
                isinstance(char_count, bool)
                or not isinstance(char_count, int)
                or char_count <= 0
            ):
                errors.append(f"caption-link target has no text: {caption_block_id}")
            leading_key = text_summary.get("leading_figure_key")
            formal_key = text_summary.get("leading_formal_figure_caption_key")
            if position == 0 and formal_key != figure_key:
                errors.append(
                    f"caption-link anchor is not a formal matching caption: {caption_block_id}"
                )
            elif position > 0 and leading_key is not None:
                errors.append(
                    f"caption-link continuation starts a new figure: {caption_block_id}"
                )

        if (
            isinstance(figure_key, str)
            and NORMALIZED_FIGURE_KEY_RE.fullmatch(figure_key)
            and isinstance(target_page_idx, int)
            and caption_block_ids
            and isinstance(caption_block_ids[0], str)
            and caption_block_ids[0] in block_by_id
        ):
            target_blocks = page_blocks_by_idx.get(target_page_idx, [])
            candidates, _, _ = _scan_next_page_caption_candidates(
                target_blocks, figure_key
            )
            if len(candidates) != 1 or candidates[0].get("id") != caption_block_ids[0]:
                errors.append(f"caption-link anchor is not unique: {visual_block_id}")
            else:
                expected_ids, expected_status, _ = _collect_cross_page_caption_blocks(
                    candidates[0], target_blocks
                )
                if caption_block_ids != expected_ids:
                    errors.append(
                        f"caption-link continuation set is incomplete: {visual_block_id}"
                    )
                if link.get("status") != expected_status:
                    errors.append(
                        f"caption-link completeness status mismatch: {visual_block_id}"
                    )

    summary = payload.get("summary")
    if not isinstance(summary, dict):
        errors.append("visual repair summary is not an object")
    else:
        expected_caption_counts = Counter(
            link.get("status")
            for link in caption_links
            if isinstance(link, dict)
        )
        if summary.get("caption_link_count") != len(caption_links):
            errors.append("visual repair caption_link_count mismatch")
        if summary.get("complete_caption_link_count") != expected_caption_counts["complete"]:
            errors.append("visual repair complete_caption_link_count mismatch")
        if summary.get("partial_caption_link_count") != expected_caption_counts["partial"]:
            errors.append("visual repair partial_caption_link_count mismatch")
    return errors
