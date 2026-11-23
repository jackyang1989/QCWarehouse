#!/usr/bin/env python3
"""
Self-hosted OCR engine for QCWarehouse using RapidOCR (ONNX PP-OCRv4), pypdf, and pypdfium2.
Runs locally without any external network call or China mainland ICP dependency.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any


def check_health() -> dict[str, Any]:
    status: dict[str, Any] = {
        "ok": False,
        "engine": "rapidocr_onnxruntime",
        "model": "PP-OCRv4",
        "pypdf": False,
        "pypdfium2": False,
        "pil": False,
    }
    try:
        import pypdf  # noqa: F401
        status["pypdf"] = True
    except Exception as exc:
        status["error"] = f"pypdf import failed: {exc}"
        return status
    try:
        import pypdfium2  # noqa: F401
        status["pypdfium2"] = True
    except Exception as exc:
        status["error"] = f"pypdfium2 import failed: {exc}"
        return status
    try:
        from PIL import Image  # noqa: F401
        status["pil"] = True
    except Exception as exc:
        status["error"] = f"PIL import failed: {exc}"
        return status
    try:
        from rapidocr_onnxruntime import RapidOCR

        _ = RapidOCR()
        status["ok"] = True
    except Exception as exc:
        status["error"] = f"RapidOCR init failed: {exc}"
    return status


def _normalize_box(box: Any, width: int, height: int) -> list[float]:
    try:
        xs = [float(pt[0]) for pt in box]
        ys = [float(pt[1]) for pt in box]
        w = max(1.0, float(width))
        h = max(1.0, float(height))
        return [
            round(max(0.0, min(1.0, min(xs) / w)), 4),
            round(max(0.0, min(1.0, min(ys) / h)), 4),
            round(max(0.0, min(1.0, max(xs) / w)), 4),
            round(max(0.0, min(1.0, max(ys) / h)), 4),
        ]
    except Exception:
        return [0.0, 0.0, 1.0, 1.0]


def _run_rapidocr_on_pil(ocr_engine: Any, img: Any, page: int) -> list[dict[str, Any]]:
    import numpy as np

    rgb = img.convert("RGB")
    w, h = rgb.size
    arr = np.array(rgb)
    result, _elapsed = ocr_engine(arr)
    blocks: list[dict[str, Any]] = []
    if not result:
        return blocks
    for entry in result:
        if not entry or len(entry) < 3:
            continue
        box, text, score = entry[0], str(entry[1]).strip(), float(entry[2])
        if not text:
            continue
        blocks.append(
            {
                "page": page,
                "text": text,
                "confidence": round(max(0.0, min(1.0, score)), 4),
                "bbox": _normalize_box(box, w, h),
                "width": w,
                "height": h,
            }
        )
    return blocks


def extract_image(path: Path) -> dict[str, Any]:
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    with Image.open(path) as img:
        w, h = img.size
        blocks = _run_rapidocr_on_pil(ocr, img, page=1)
    full_text = "\n".join(b["text"] for b in blocks)
    avg_conf = (
        round(sum(b["confidence"] for b in blocks) / len(blocks), 4) if blocks else 0.0
    )
    return {
        "ok": True,
        "engine": "paddle_ocr",
        "page_count": 1,
        "width": w,
        "height": h,
        "full_text": full_text,
        "avg_confidence": avg_conf,
        "blocks": blocks,
    }


def extract_pdf(path: Path, max_pages: int) -> dict[str, Any]:
    import pypdf
    import pypdfium2 as pdfium
    from rapidocr_onnxruntime import RapidOCR

    try:
        reader = pypdf.PdfReader(str(path))
    except Exception as exc:
        return {"ok": False, "code": "PDF_CORRUPT", "error": f"Failed to parse PDF: {exc}"}

    if reader.is_encrypted:
        return {
            "ok": False,
            "code": "PDF_ENCRYPTED",
            "error": "Password-protected PDF files cannot be processed.",
        }

    total_pages = len(reader.pages)
    if total_pages == 0:
        return {"ok": False, "code": "PDF_EMPTY", "error": "PDF contains zero pages."}
    if total_pages > max_pages:
        return {
            "ok": False,
            "code": "PDF_PAGE_LIMIT",
            "error": f"PDF has {total_pages} pages, exceeding maximum {max_pages} pages.",
        }

    blocks: list[dict[str, Any]] = []
    ocr_engine: Any = None
    pdf_doc: Any = None

    try:
        for idx in range(total_pages):
            page_num = idx + 1
            native_text = (reader.pages[idx].extract_text() or "").strip()
            lines = [ln.strip() for ln in native_text.splitlines() if ln.strip()]
            if len("".join(lines)) >= 35:
                for ln in lines:
                    blocks.append(
                        {
                            "page": page_num,
                            "text": ln,
                            "confidence": 0.97,
                            "bbox": None,
                            "source": "pdf_native_text",
                        }
                    )
            else:
                if ocr_engine is None:
                    ocr_engine = RapidOCR()
                if pdf_doc is None:
                    pdf_doc = pdfium.PdfDocument(str(path))
                page_obj = pdf_doc[idx]
                w_pt = max(1.0, float(page_obj.get_width()))
                h_pt = max(1.0, float(page_obj.get_height()))
                render_scale = min(2.0, 2400.0 / max(w_pt, h_pt))
                bitmap = page_obj.render(scale=max(0.5, render_scale))
                pil_img = bitmap.to_pil()
                blocks.extend(_run_rapidocr_on_pil(ocr_engine, pil_img, page=page_num))
    finally:
        if pdf_doc is not None:
            pdf_doc.close()

    full_text = "\n".join(b["text"] for b in blocks)
    avg_conf = (
        round(sum(b["confidence"] for b in blocks) / len(blocks), 4) if blocks else 0.0
    )
    return {
        "ok": True,
        "engine": "paddle_ocr",
        "page_count": total_pages,
        "full_text": full_text,
        "avg_confidence": avg_conf,
        "blocks": blocks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--input", type=str)
    parser.add_argument("--mime", type=str, default="image/png")
    parser.add_argument("--max-pages", type=int, default=10)
    args = parser.parse_args()

    if args.health:
        res = check_health()
        print(json.dumps(res, ensure_ascii=False))
        return 0 if res.get("ok") else 1

    if not args.input:
        print(json.dumps({"ok": False, "code": "BAD_ARGS", "error": "--input is required"}))
        return 2

    target = Path(args.input)
    if not target.exists():
        print(json.dumps({"ok": False, "code": "NOT_FOUND", "error": "Input file missing"}))
        return 2

    try:
        mime = args.mime.lower().strip()
        if mime == "application/pdf" or target.suffix.lower() == ".pdf":
            out = extract_pdf(target, max_pages=max(1, args.max_pages))
        else:
            out = extract_image(target)
        print(json.dumps(out, ensure_ascii=False))
        return 0 if out.get("ok") else 1
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": "OCR_RUNTIME_ERROR",
                    "error": str(exc),
                    "trace": traceback.format_exc(limit=3),
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
