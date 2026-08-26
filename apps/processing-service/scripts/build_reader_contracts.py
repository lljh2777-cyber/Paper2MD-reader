#!/usr/bin/env python3
"""Build validated, non-destructive Reader contracts for one staged MinerU package."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from mineru_viewer_contract import (
    build_viewer_index,
    build_visual_repair,
    extract_markdown_image_occurrences,
    validate_viewer_index,
    validate_visual_repair,
)
from mineru_visual_adjudication import (
    build_visual_candidates,
    validate_visual_candidates,
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    package_root = args.package_root.resolve(strict=True)
    article_path = package_root / "article.md"
    mineru_path = package_root / "mineru-result.json"
    source_pdf = package_root / "_extraction" / "source.pdf"
    for path in (article_path, mineru_path, source_pdf):
        if not path.is_file():
            raise RuntimeError(f"Missing staged package input: {path.name}")

    article = article_path.read_text(encoding="utf-8")
    payload = json.loads(mineru_path.read_text(encoding="utf-8"))
    input_hashes = {
        "article": sha256_file(article_path),
        "mineru_result": sha256_file(mineru_path),
    }
    viewer_index = build_viewer_index(
        payload,
        extract_markdown_image_occurrences(article),
        input_hashes,
        packaged_source_pdf=True,
        source_available_at_generation=True,
    )
    viewer_errors = validate_viewer_index(viewer_index)
    if viewer_errors:
        raise RuntimeError("Invalid viewer index: " + "; ".join(viewer_errors))

    visual_repair = build_visual_repair(viewer_index)
    repair_errors = validate_visual_repair(visual_repair, viewer_index)
    if repair_errors:
        raise RuntimeError("Invalid visual repair: " + "; ".join(repair_errors))

    visual_candidates = build_visual_candidates(viewer_index, visual_repair)
    candidate_errors = validate_visual_candidates(
        visual_candidates,
        viewer_index,
        visual_repair,
    )
    if candidate_errors:
        messages = [
            str(error.get("message") or error.get("code") or error)
            if isinstance(error, dict)
            else str(error)
            for error in candidate_errors
        ]
        raise RuntimeError("Invalid visual candidates: " + "; ".join(messages))

    extraction_root = package_root / "_extraction"
    write_json(extraction_root / "viewer-index.json", viewer_index)
    write_json(extraction_root / "visual-repair.json", visual_repair)
    write_json(extraction_root / "visual-candidates.json", visual_candidates)
    print(
        json.dumps(
            {
                "viewer": viewer_index.get("summary", {}),
                "repair": visual_repair.get("summary", {}),
                "candidates": visual_candidates.get("summary", {}),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
