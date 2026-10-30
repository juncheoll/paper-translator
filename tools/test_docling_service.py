import hashlib
import http.client
import json
import tempfile
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
from pathlib import Path
from docling_service import DEFAULT_ORIGIN, LayoutServer, LayoutStore


class FakeEngine:
    def __init__(self):
        self.calls = 0
        self.converter = None

    def prepare(self):
        self.converter = object()

    def analyze(self, data):
        self.calls += 1
        time.sleep(0.02)
        return [{"pageNumber": 1, "width": 600, "height": 800, "regions": []}]


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.engine = FakeEngine()
        self.store = LayoutStore(self.directory, self.engine, "a"*64)
        self.server = LayoutServer(("127.0.0.1", 0), self.store, [DEFAULT_ORIGIN])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.pdf = b"%PDF-1.7\nfixture"
        self.document_id = hashlib.sha256(self.pdf).hexdigest()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, method="GET", data=None, origin=DEFAULT_ORIGIN, **headers):
        req = urllib.request.Request(self.url+path, data=data, method=method,
            headers={"Origin": origin, **headers})
        try:
            with urllib.request.urlopen(req) as result:
                return result.status, result.headers, json.load(result)
        except urllib.error.HTTPError as error:
            return error.code, error.headers, json.load(error)

    def test_cache_survives_service_restart_and_model_changes_do_not_reuse_it(self):
        first = self.store.analyze(self.document_id, self.pdf)
        restarted = LayoutStore(self.directory, FakeEngine(), self.store.identity)
        second = restarted.analyze(self.document_id, self.pdf)
        self.assertEqual(first["pages"], second["pages"])
        self.assertEqual(second["cache"], "disk")
        self.assertEqual(restarted.engine.calls, 0)
        changed = LayoutStore(self.directory, FakeEngine(), "b"*64)
        self.assertIsNone(changed.cached(self.document_id))
        self.assertFalse(list(self.directory.rglob("*.pdf")))

    def test_corrupted_cache_is_replaced_and_wrong_pdf_digest_is_rejected(self):
        (self.store.directory/f"{self.document_id}.json").write_text("broken")
        self.assertEqual(self.store.analyze(self.document_id, self.pdf)["cache"], "computed")
        with self.assertRaises(ValueError):
            self.store.analyze(self.document_id, self.pdf+b"changed")
        self.assertEqual(self.engine.calls, 1)

    def test_simultaneous_identical_requests_only_analyze_once(self):
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.store.analyze(self.document_id,self.pdf))) for _ in range(3)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(self.engine.calls, 1)
        self.assertEqual(sorted(r["cache"] for r in results), ["computed", "disk", "disk"])

    def test_http_cors_content_validation_and_cache_hit(self):
        path = "/v1/layout/"+self.document_id
        status, headers, _ = self.request(path, "OPTIONS")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], DEFAULT_ORIGIN)
        self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request(path, "POST", self.pdf, **{"Content-Type":"application/pdf"})[0], 200)
        self.assertEqual(self.request(path)[2]["cache"], "disk")
        self.assertEqual(self.request(path, "POST", b"bad", **{"Content-Type":"application/pdf"})[0], 400)
        self.assertEqual(self.request(path, "POST", self.pdf, **{"Content-Type":"text/plain"})[0], 415)
        self.assertEqual(self.engine.calls, 1)

    def test_warmup_loads_without_a_pdf_and_reports_memory_state(self):
        self.assertFalse(self.request("/v1/info")[2]["modelLoaded"])
        self.assertEqual(self.request("/v1/warmup", "POST")[0], 200)
        self.assertTrue(self.request("/v1/info")[2]["modelLoaded"])
        self.assertEqual(self.engine.calls, 0)
        self.assertEqual(self.request("/v1/warmup", "POST", origin="https://evil.example")[0], 403)
        self.assertEqual(self.request("/v1/warmup", "POST", b"unexpected")[0], 400)

    def test_warmup_refuses_to_load_while_a_document_is_being_analyzed(self):
        self.store.lock.acquire()
        try:
            self.assertEqual(self.request("/v1/warmup", "POST")[0], 503)
            self.assertFalse(self.engine.converter)
        finally:
            self.store.lock.release()

    def test_unapproved_web_origins_and_dns_rebinding_hosts_are_rejected(self):
        status, headers, _ = self.request("/v1/info", origin="https://example.com")
        self.assertEqual(status, 403)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        self.assertEqual(self.request("/v1/info", Host="evil.example")[0], 403)

    def test_server_token_is_required_for_info_cache_and_uploads(self):
        self.server.token = "test-secret"
        self.assertEqual(self.request("/v1/info")[0], 401)
        self.assertEqual(self.request("/v1/info", Authorization="Bearer wrong")[0], 401)
        self.assertEqual(self.request("/v1/info", Authorization="Bearer test-secret")[0], 200)
        self.assertEqual(self.request("/v1/layout/" + self.document_id, Authorization="Bearer test-secret")[0], 404)
        self.assertEqual(self.request("/v1/info", "OPTIONS")[0], 200)
        self.server.hosts.add("layout.example.org")
        self.assertEqual(self.request("/v1/info", Host="layout.example.org", Authorization="Bearer test-secret")[0], 200)

    def test_non_ascii_bearer_header_returns_401_and_keeps_service_usable(self):
        self.server.token = "test-secret"
        for method, path, body in [("GET", "/v1/info", None),
                ("GET", "/v1/layout/" + self.document_id, None),
                ("POST", "/v1/layout/" + self.document_id, self.pdf)]:
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            try:
                connection.request(method, path, body=body, headers={
                    "Authorization": "Bearer 설정한토큰".encode("utf-8"),
                    "Content-Type": "application/pdf",
                })
                response = connection.getresponse()
                self.assertEqual(response.status, 401)
                self.assertEqual(json.loads(response.read())["error"], "A valid bearer token is required")
            finally:
                connection.close()
        self.assertEqual(self.request("/v1/info", Authorization="Bearer test-secret")[0], 200)
        self.assertEqual(self.engine.calls, 0)

    def test_unauthenticated_mode_explicitly_disables_an_existing_token(self):
        import docling_service
        server = mock.MagicMock()
        argv = ["docling_service.py", "--artifacts", str(self.directory),
                "--bind", "192.0.2.20", "--allow-host", "192.0.2.20:8876", "--allow-unauthenticated"]
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.dict(os.environ, {"PAPER_DOCLING_TOKEN": "previous-secret"}), \
                mock.patch.object(docling_service.logging, "basicConfig"), \
                mock.patch.object(docling_service.logging, "warning"), \
                mock.patch.object(docling_service, "LayoutEngine"), \
                mock.patch.object(docling_service, "LayoutStore"), \
                mock.patch.object(docling_service, "LayoutServer", return_value=server) as factory:
            docling_service.main()
        self.assertEqual(factory.call_args.args[0], ("192.0.2.20", 8876))
        self.assertEqual(factory.call_args.args[3], "")
        server.serve_forever.assert_called_once()

    def test_unauthenticated_http_still_enforces_host_and_origin(self):
        self.assertEqual(self.request("/v1/info")[0], 200)
        path = "/v1/layout/" + self.document_id
        self.assertEqual(self.request(path, "POST", self.pdf, **{"Content-Type": "application/pdf"})[0], 200)
        self.assertEqual(self.request(path)[2]["cache"], "disk")
        self.assertEqual(self.request("/v1/info", Host="evil.example")[0], 403)
        self.assertEqual(self.request("/v1/info", origin="https://evil.example")[0], 403)

    def test_public_bind_without_token_still_requires_an_explicit_opt_in(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("docling_service.py")),
            "--artifacts", str(self.directory), "--bind", "0.0.0.0"],
            env={**os.environ, "PAPER_DOCLING_TOKEN": ""}, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("A bearer token is required", result.stderr)

    def test_authentication_modes_are_mutually_exclusive(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("docling_service.py")),
            "--artifacts", str(self.directory), "--require-token", "--allow-unauthenticated"],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not allowed with argument", result.stderr)

    def test_production_service_refuses_an_empty_token_even_on_loopback(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('docling_service.py')),
            '--artifacts', str(self.directory), '--require-token'],
            env={**os.environ, 'PAPER_DOCLING_TOKEN': ''}, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('A bearer token is required', result.stderr)
        self.assertIn('--require-token', Path(__file__).with_name('docling-server.service').read_text())


if __name__ == "__main__":
    unittest.main()
