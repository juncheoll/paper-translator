"""CPU PDF layout API. Native PDF.js text stays in the extension."""
import os

# Set before importing torch; inference is explicitly CPU-only as well.
os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                   "TOKENIZERS_PARALLELISM": "false", "OMP_NUM_THREADS": "4",
                   "MKL_NUM_THREADS": "4", "VECLIB_MAXIMUM_THREADS": "4"})

import argparse
import gc
import hashlib
import hmac
import io
import json
import logging
import math
import re
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlsplit

MODEL = "docling-project/docling-layout-heron"
REVISION = "8f39ad3c0b4c58e9c2d2c84a38465abf757272d8"
SCHEMA = 1
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PAGES = 500
DEFAULT_ORIGIN = "chrome-extension://bbikcebphjmoffaecpckkbohlnjblknb"
LOG = logging.getLogger("paper.docling")


def identity():
    config = {"schema": SCHEMA, "model": MODEL, "revision": REVISION,
              "docling": version("docling"), "docling_parse": version("docling-parse"),
              "torch": version("torch"), "transformers": version("transformers"),
              "device": "cpu", "threads": 4, "batch_size": 1, "images_scale": 1.0,
              "ocr": False, "tables": False, "enrichment": False}
    digest = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    return digest, config


def box(x, y, right, bottom):
    values = [x, y, right, bottom]
    if not all(math.isfinite(v) for v in values) or right <= x or bottom <= y:
        return None
    return {"x": x, "y": y, "width": right - x, "height": bottom - y}


class LayoutEngine:
    def __init__(self, artifacts):
        self.artifacts = artifacts
        self.converter = None

    def prepare(self):
        if self.converter is None:
            import torch
            from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
            from docling.datamodel.base_models import InputFormat
            from docling.datamodel.pipeline_options import PdfPipelineOptions
            from docling.document_converter import DocumentConverter, PdfFormatOption
            torch.set_num_threads(4)
            torch.set_num_interop_threads(1)
            options = PdfPipelineOptions(
                artifacts_path=self.artifacts,
                accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4),
                layout_batch_size=1, images_scale=1.0, do_ocr=False, do_table_structure=False,
                do_code_enrichment=False, do_formula_enrichment=False,
                do_picture_classification=False, do_picture_description=False, do_chart_extraction=False,
                generate_page_images=False, generate_picture_images=False, generate_parsed_pages=False,
                document_timeout=240,
            )
            options.layout_options.model_spec = options.layout_options.model_spec.model_copy(update={"revision": REVISION})
            converter = DocumentConverter(allowed_formats=[InputFormat.PDF],
                format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
            converter.initialize_pipeline(InputFormat.PDF)
            pipeline = next(iter(converter.initialized_pipelines.values()))
            assert {str(p.device) for p in pipeline.layout_model.engine._model.parameters()} == {"cpu"}
            self.converter = converter

    def analyze(self, data):
        self.prepare()
        from docling.datamodel.base_models import DocumentStream
        result = self.converter.convert(DocumentStream(name="document.pdf", stream=io.BytesIO(data)),
                                        max_num_pages=MAX_PAGES, raises_on_error=True)
        if result.status.value != "success" or not result.pages:
            raise ValueError("Incomplete PDF layout")
        pages = []
        for page in result.pages:
            regions = []
            for cluster in page.predictions.layout.clusters:
                bounds = cluster.bbox.to_top_left_origin(page_height=page.size.height)
                bbox = box(bounds.l, bounds.t, bounds.r, bounds.b)
                if bbox is None:
                    continue
                cells = []
                # Only geometry is returned. Never replace native text or character offsets.
                for cell in cluster.cells:
                    rect = cell.rect.to_bounding_box().to_top_left_origin(page_height=page.size.height)
                    cell_box = box(rect.l, rect.t, rect.r, rect.b)
                    if cell_box:
                        cells.append(cell_box)
                regions.append({"id": cluster.id, "label": cluster.label.value,
                                "confidence": float(cluster.confidence), "bbox": bbox, "cells": cells})
            pages.append({"pageNumber": page.page_no, "width": page.size.width,
                          "height": page.size.height, "regions": regions})
        del result
        gc.collect()
        return pages


class LayoutStore:
    def __init__(self, cache_dir, engine, cache_identity=None):
        self.identity, self.config = identity()
        self.identity = cache_identity or self.identity
        self.directory = cache_dir / self.identity
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.engine = engine
        self.lock = threading.Lock()
        self.analyses = 0
        self.cache_hits = 0

    def info(self):
        return {"schema": SCHEMA, "identity": self.identity, "config": self.config,
                "analyses": self.analyses, "cacheHits": self.cache_hits,
                "modelLoaded": getattr(self.engine, "converter", None) is not None,
                "busy": self.lock.locked(), "capabilities": ["warmup"]}

    def cached(self, document_id):
        try:
            data = json.loads((self.directory / f"{document_id}.json").read_text())
            if isinstance(data, dict) and data.get("schema") == SCHEMA and data.get("documentId") == document_id and \
                    data.get("identity") == self.identity and isinstance(data.get("pages"), list) and \
                    0 < len(data["pages"]) <= MAX_PAGES and all(isinstance(page, dict) and page.get("pageNumber") == i+1
                                                              for i, page in enumerate(data["pages"])):
                self.cache_hits += 1
                return {**data, "cache": "disk"}
        except (OSError, ValueError):
            pass
        return None

    def analyze(self, document_id, pdf):
        if hashlib.sha256(pdf).hexdigest() != document_id:
            raise ValueError("PDF digest does not match documentId")
        # One model and one document at a time, including concurrent requests for the same PDF.
        with self.lock:
            cached = self.cached(document_id)
            if cached:
                return cached
            start = time.monotonic()
            pages = self.engine.analyze(pdf)
            data = {"schema": SCHEMA, "documentId": document_id, "identity": self.identity,
                    "pages": pages, "seconds": time.monotonic() - start}
            path = self.directory / f"{document_id}.json"
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", dir=self.directory, delete=False) as stream:
                    temporary = Path(stream.name)
                    json.dump(data, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                    stream.flush()
                # Windows cannot replace or remove this file until its handle is closed.
                os.replace(temporary, path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            self.analyses += 1
            LOG.info("layout complete pages=%d seconds=%.3f", len(pages), data["seconds"])
            return {**data, "cache": "computed"}


class LayoutServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, store, origins, token="", hosts=()):
        super().__init__(address, Handler)
        self.store, self.origins = store, set(origins)
        self.token, self.hosts = token, set(hosts)
        self.slots = threading.BoundedSemaphore(4)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(260)

    def allowed(self):
        host = self.headers.get("Host", "").lower()
        expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}", *self.server.hosts}
        origin = self.headers.get("Origin")
        if host not in expected or origin is not None and origin not in self.server.origins:
            self.reply(403, {"error": "Origin or Host is not allowed"})
            return False
        if self.command != "OPTIONS" and self.server.token and not hmac.compare_digest(
                self.headers.get("Authorization", "").encode("utf-8"), ("Bearer " + self.server.token).encode("utf-8")):
            self.reply(401, {"error": "A valid bearer token is required"})
            return False
        return True

    def reply(self, status, data):
        body = json.dumps(data, allow_nan=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A stopped viewer can still reuse the completed analysis next time.

    def do_OPTIONS(self):
        if self.allowed():
            self.reply(200, {})

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        if path == "/v1/info":
            self.reply(200, self.server.store.info())
        elif match := re.fullmatch(r"/v1/layout/([a-f0-9]{64})", path):
            result = self.server.store.cached(match[1])
            self.reply(200 if result else 404, result or {"error": "Not cached"})
        else:
            self.reply(404, {"error": "Unknown endpoint"})

    def do_POST(self):
        if not self.allowed():
            return
        if urlsplit(self.path).path == "/v1/warmup":
            if self.headers.get("Content-Length", "0") != "0":
                return self.reply(400, {"error": "Warmup does not accept a request body"})
            store = self.server.store
            if not store.lock.acquire(blocking=False):
                return self.reply(503, {"error": "Layout service is busy"})
            try:
                store.engine.prepare()
            except Exception:
                LOG.exception("model warmup failed")
                return self.reply(500, {"error": "Model warmup failed"})
            finally:
                store.lock.release()
            return self.reply(200, store.info())
        match = re.fullmatch(r"/v1/layout/([a-f0-9]{64})", urlsplit(self.path).path)
        if not match:
            return self.reply(404, {"error": "Unknown endpoint"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "Invalid Content-Length"})
        if not 0 < length <= MAX_PDF_BYTES:
            return self.reply(413, {"error": "PDF must be at most 50 MiB"})
        if self.headers.get_content_type() != "application/pdf":
            return self.reply(415, {"error": "Expected application/pdf"})
        if not self.server.slots.acquire(blocking=False):
            return self.reply(503, {"error": "Layout queue is full"})
        try:
            pdf = self.rfile.read(length)
            if len(pdf) != length or b"%PDF-" not in pdf[:1024]:
                return self.reply(400, {"error": "Invalid PDF body"})
            self.reply(200, self.server.store.analyze(match[1], pdf))
        except ValueError as error:
            self.reply(422, {"error": str(error)})
        except Exception:
            LOG.exception("layout request failed")
            self.reply(500, {"error": "Layout analysis failed"})
        finally:
            self.server.slots.release()

    def log_message(self, fmt, *args):
        LOG.info(fmt, *args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8876)
    parser.add_argument("--bind", default="127.0.0.1", help="Keep loopback behind an authenticated HTTPS reverse proxy")
    parser.add_argument("--allow-host", action="append", default=[], help="Explicit Host value including port")
    parser.add_argument("--token-env", default="PAPER_DOCLING_TOKEN", help="Environment variable containing the API bearer token")
    auth = parser.add_mutually_exclusive_group()
    auth.add_argument("--require-token", action="store_true", help="Refuse to start without an API token, including behind a loopback reverse proxy")
    auth.add_argument("--allow-unauthenticated", action="store_true", help="Disable bearer authentication explicitly; restrict access at the network or reverse proxy")
    parser.add_argument("--warmup", action="store_true", help="Load the CPU model before accepting API requests")
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path.home()/"Library/Caches/PaperTranslator/docling-layout")
    parser.add_argument("--allow-origin", action="append", default=[DEFAULT_ORIGIN])
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = "" if args.allow_unauthenticated else os.environ.get(args.token_env, "")
    if (args.require_token or not args.allow_unauthenticated and args.bind not in ("127.0.0.1", "localhost", "::1")) and not token:
        parser.error("A bearer token is required in --token-env for this server configuration")
    if args.allow_unauthenticated:
        LOG.warning("Bearer authentication is disabled; restrict API access at the network or reverse proxy")
    engine = LayoutEngine(args.artifacts)
    if args.warmup:
        engine.prepare()
    server = LayoutServer((args.bind, args.port), LayoutStore(args.cache, engine), args.allow_origin, token, args.allow_host)
    LOG.info("CPU layout service ready at %s:%s", args.bind, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
