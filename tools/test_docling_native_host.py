import io
import json
import socket
import struct
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from docling_native_host import (
    MAX_MESSAGE, MODEL, MODEL_FILES, DoclingHelper, HelperError, cancelled,
    normalize_origin, read_config, read_message, read_model_revision, serve,
)

ORIGIN = "chrome-extension://" + "a" * 32
REVISION = "1" * 40
INFO = {"schema": 1, "identity": "2" * 64, "config": {"device": "cpu", "batch_size": 1}}


def frame(value):
    raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
    return struct.pack("=I", len(raw)) + raw


def weight_bytes():
    header = json.dumps({"weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
    return struct.pack("<Q", len(header)) + header + b"\0" * 4


MODEL_DATA = {"config.json": b'{"model_type":"rt_detr"}',
              "preprocessor_config.json": b'{"size":640}', "model.safetensors": weight_bytes()}


class Response(io.BytesIO):
    def __init__(self, raw):
        super().__init__(raw)
        self.headers = {"Content-Length": str(len(raw))}

    def geturl(self):
        return "https://huggingface.co/fixed-model"


class Process:
    def __init__(self):
        self.returncode = None
        self.terminated = 0

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated += 1
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        (self.home / "tools").mkdir()
        (self.home / "tools/docling_service.py").write_text(f'MODEL = "{MODEL}"\nREVISION = "{REVISION}"\n')
        self.config = {"python": str(Path(sys.executable).resolve()), "allowedOrigins": [ORIGIN]}
        (self.home / "config.json").write_text(json.dumps(self.config))
        self.helper = DoclingHelper(self.home, self.config, port=18876)
        self.event = threading.Event()

    def tearDown(self):
        self.helper.close()
        self.temporary.cleanup()

    def seed_model(self):
        self.helper.model_directory.mkdir(parents=True, exist_ok=True)
        for name, data in MODEL_DATA.items():
            (self.helper.model_directory / name).write_bytes(data)
        (self.helper.models / "revision.txt").write_text(REVISION)

    def test_origin_and_installer_config_are_validated_before_start(self):
        self.assertEqual(normalize_origin(ORIGIN + "/"), ORIGIN)
        self.assertEqual(read_config(self.home, ORIGIN)["python"], self.config["python"])
        for origin in ("https://example.com", "chrome-extension://" + "z" * 32, ORIGIN + "/page.html"):
            with self.assertRaises(HelperError):
                read_config(self.home, origin)
        with self.assertRaises(HelperError):
            read_config(self.home, "chrome-extension://" + "b" * 32)
        (self.home / "config.json").write_text(json.dumps({**self.config, "python": "python3"}))
        with self.assertRaises(HelperError):
            read_config(self.home, ORIGIN)

    def test_reading_service_constants_does_not_execute_the_service(self):
        marker = self.home / "executed"
        service = self.home / "tools/docling_service.py"
        service.write_text(service.read_text() + f'\nraise RuntimeError("must not run")\n')
        self.assertEqual(read_model_revision(service), REVISION)
        self.assertFalse(marker.exists())

    def test_start_never_downloads_a_missing_model(self):
        with patch.object(self.helper, "service_info", return_value=None), \
                patch.object(self.helper, "download_models") as download, \
                patch("docling_native_host.subprocess.Popen") as spawn:
            with self.assertRaises(HelperError) as error:
                self.helper.start(self.event, lambda _: None)
            self.assertEqual(error.exception.code, "DOCLING_MODEL_NOT_READY")
            download.assert_not_called()
            spawn.assert_not_called()

    def test_download_is_fixed_revision_atomic_and_reuses_completed_files(self):
        calls, progress = [], []

        def response(request, timeout):
            calls.append(request.full_url)
            return Response(MODEL_DATA[request.full_url.rsplit("/", 1)[-1]])

        with patch("docling_native_host.urllib.request.urlopen", side_effect=response):
            self.helper.download_models(self.event, progress.append)
            self.assertTrue(self.helper.model_ready())
            self.helper.download_models(self.event, progress.append)
        self.assertEqual(calls, [f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}" for name in MODEL_FILES])
        self.assertTrue(any(event["phase"] == "download" and event["loaded"] > 0 for event in progress))
        self.assertFalse(list(self.helper.model_directory.glob("*.partial")))

    def test_partial_download_is_not_ready_and_retry_keeps_completed_files(self):
        names = []

        def response(request, timeout):
            name = request.full_url.rsplit("/", 1)[-1]
            names.append(name)
            if name == "model.safetensors" and len(names) == 3:
                return Response(b"truncated")
            return Response(MODEL_DATA[name])

        with patch("docling_native_host.urllib.request.urlopen", side_effect=response):
            with self.assertRaises(HelperError):
                self.helper.download_models(self.event, lambda _: None)
            self.assertFalse(self.helper.model_ready())
            self.helper.download_models(self.event, lambda _: None)
        self.assertEqual(names, [*MODEL_FILES, "model.safetensors"])
        self.assertTrue(self.helper.model_ready())
        self.assertFalse(list(self.helper.model_directory.glob("*.partial")))

    def test_cancelled_download_never_publishes_a_partial_file(self):
        event = self.event

        class CancelResponse(Response):
            def read(self, size=-1):
                data = super().read(size)
                event.set()
                return data

        with patch("docling_native_host.urllib.request.urlopen", return_value=CancelResponse(MODEL_DATA["config.json"])):
            with self.assertRaises(HelperError) as error:
                self.helper.download_models(event, lambda _: None)
            self.assertEqual(error.exception.code, "DOCLING_CANCELLED")
        self.assertFalse(self.helper.model_ready())
        self.assertFalse((self.helper.model_directory / "config.json").exists())
        self.assertFalse(list(self.helper.model_directory.glob("*.partial")))

    def test_oversized_model_json_is_rejected_before_body_read_or_parse(self):
        response = Response(b"not read")
        response.headers["Content-Length"] = str(4 * 1024 * 1024 + 1)
        with patch.object(response, "read", side_effect=AssertionError("Oversized JSON must not be read")), \
                patch("docling_native_host.urllib.request.urlopen", return_value=response), \
                patch("docling_native_host.json.loads", side_effect=AssertionError("Oversized JSON must not be parsed")):
            with self.assertRaises(HelperError) as error:
                self.helper.download_models(self.event, lambda _: None)
            self.assertEqual(error.exception.code, "DOCLING_DOWNLOAD")
        self.assertFalse((self.helper.model_directory / "config.json").exists())
        self.assertFalse(list(self.helper.model_directory.glob("*.partial")))

    def test_headerless_oversized_model_json_is_bounded_before_parse(self):
        response = Response(b"x" * (4 * 1024 * 1024 + 1))
        response.headers = {}
        with patch("docling_native_host.urllib.request.urlopen", return_value=response), \
                patch("docling_native_host.json.loads", side_effect=AssertionError("Oversized JSON must not be parsed")):
            with self.assertRaises(HelperError) as error:
                self.helper.download_models(self.event, lambda _: None)
            self.assertEqual(error.exception.code, "DOCLING_DOWNLOAD")
        self.assertFalse((self.helper.model_directory / "config.json").exists())
        self.assertFalse(list(self.helper.model_directory.glob("*.partial")))

    def test_old_external_service_is_reused_and_cannot_be_stopped(self):
        error = urllib.error.HTTPError("http://127.0.0.1:18876/v1/warmup", 404, "old service", {}, None)
        self.addCleanup(error.close)
        with patch.object(self.helper, "service_info", return_value=INFO), \
                patch.object(self.helper, "http", side_effect=error), \
                patch("docling_native_host.subprocess.Popen") as spawn:
            state = self.helper.start(self.event, lambda _: None)
            self.assertTrue(state["running"])
            self.assertFalse(state["managed"])
            self.assertIsNone(state["modelLoaded"])
            spawn.assert_not_called()
            with self.assertRaises(HelperError) as stopped:
                self.helper.stop()
            self.assertEqual(stopped.exception.code, "DOCLING_EXTERNAL_SERVICE")

    def test_owned_service_starts_with_fixed_arguments_and_stop_obeys_busy_state(self):
        self.seed_model()
        process = Process()
        info = {**INFO, "modelLoaded": True, "busy": False}

        def service_info():
            return info if self.helper.child is not None and process.poll() is None else None

        with patch.object(self.helper, "service_info", side_effect=service_info), \
                patch.object(self.helper, "http", return_value=info), \
                patch("docling_native_host.socket.create_connection", side_effect=ConnectionRefusedError), \
                patch("docling_native_host.subprocess.Popen", return_value=process) as spawn:
            state = self.helper.start(self.event, lambda _: None)
            self.assertTrue(state["managed"])
            command = spawn.call_args.args[0]
            self.assertEqual(command[:2], [self.config["python"], str(self.helper.service)])
            self.assertIn("18876", command)
            self.assertIn(ORIGIN, command)
            self.assertNotIn("shell", spawn.call_args.kwargs)
            info["busy"] = True
            with self.assertRaises(HelperError):
                self.helper.stop()
            self.assertEqual(process.terminated, 0)
            info["busy"] = False
            state = self.helper.stop()
            self.assertEqual(process.terminated, 1)
            self.assertFalse(state["running"])
            self.assertTrue(self.helper.model_ready())

    def test_wrong_service_shape_is_never_treated_as_docling(self):
        with patch.object(self.helper, "http", return_value={"schema": 1, "config": {"device": "cuda"}}):
            self.assertIsNone(self.helper.service_info())

    def test_hot_service_skips_warmup_and_unknown_owned_state_cannot_be_stopped(self):
        with patch.object(self.helper, "service_info", return_value={**INFO, "modelLoaded": True, "busy": True}), \
                patch.object(self.helper, "http") as warmup:
            self.assertTrue(self.helper.start(self.event, lambda _: None)["running"])
            warmup.assert_not_called()
        process = Process()
        self.helper.child = process
        with patch.object(self.helper, "service_info", return_value=None):
            with self.assertRaises(HelperError) as stopped:
                self.helper.stop()
            self.assertEqual(stopped.exception.code, "DOCLING_BUSY")
            self.assertEqual(process.terminated, 0)

    def test_corrupted_revision_marker_is_not_ready_and_is_repaired(self):
        self.seed_model()
        (self.helper.models / "revision.txt").write_bytes(b'\xff')
        self.assertFalse(self.helper.model_ready())
        with patch("docling_native_host.urllib.request.urlopen", side_effect=lambda request, timeout:
                   Response(MODEL_DATA[request.full_url.rsplit("/", 1)[-1]])):
            self.helper.download_models(self.event, lambda _: None)
        self.assertTrue(self.helper.model_ready())


class ChunkedInput(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(2, size))


class FakeHelper:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.closed = False
        self.calls = []
        self.stopped = threading.Event()

    def status(self, busy=False):
        return {"schema": 1, "installed": True, "running": True, "managed": True, "modelReady": True, "busy": busy}

    def start(self, event, progress):
        self.calls.append("start")
        self.started.set()
        progress({"phase": "load"})
        while not self.release.wait(0.01):
            cancelled(event)
        cancelled(event)
        return self.status()

    def close(self):
        self.closed = True

    def stop(self):
        self.calls.append("stop")
        self.stopped.set()
        return {**self.status(), "running": False}


class GateOutput:
    def __init__(self, stream):
        self.stream = stream
        self.gate = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def write(self, raw):
        message = json.loads(raw[4:])
        if self.gate and message.get("kind") == "result" and message.get("id") == "load":
            self.entered.set()
            self.release.wait(2)
        return self.stream.write(raw)

    def flush(self):
        return self.stream.flush()


class ProtocolTests(unittest.TestCase):
    def test_partial_pipe_reads_and_invalid_frames(self):
        message = {"id": "utf8", "operation": "status", "text": "한글"}
        self.assertEqual(read_message(ChunkedInput(frame(message))), message)
        self.assertIsNone(read_message(io.BytesIO()))
        for raw in (struct.pack("=I", MAX_MESSAGE + 1), b"\1", struct.pack("=I", 3) + b"{x}", struct.pack("=I", 10)):
            with self.assertRaises(HelperError):
                read_message(io.BytesIO(raw))

    def setUp(self):
        self.client, self.server = socket.socketpair()
        self.client.settimeout(3)
        self.reader = self.client.makefile("rb")
        self.writer = self.client.makefile("wb")
        self.server_reader = self.server.makefile("rb")
        self.server_writer = self.server.makefile("wb")
        self.output = GateOutput(self.server_writer)
        self.helper = FakeHelper()
        self.thread = threading.Thread(target=serve, args=(self.helper, self.server_reader, self.output), daemon=True)
        self.thread.start()

    def tearDown(self):
        try:
            self.client.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())
        for stream in (self.reader, self.writer, self.server_reader, self.server_writer):
            stream.close()
        self.client.close()
        self.server.close()

    def request(self, payload):
        self.writer.write(frame(payload))
        self.writer.flush()

    def result(self):
        while True:
            message = read_message(self.reader)
            if message["kind"] != "progress":
                return message

    def test_unknown_commands_and_arbitrary_urls_are_rejected_without_dispatch(self):
        for payload in ({"id": "bad", "operation": "exec", "command": "do-not-run"},
                        {"id": "bad", "operation": "start", "url": "https://untrusted.example"},
                        {"id": "bad", "operation": ["start"]},
                        {"id": "bad", "operation": {"command": "start"}},
                        {"id": "bad\nID", "operation": "status"}):
            self.request(payload)
            self.assertEqual(self.result()["error"]["code"], "DOCLING_REQUEST")
        self.assertEqual(self.helper.calls, [])
        self.request({"id": "ok", "operation": "status"})
        self.assertEqual(self.result()["kind"], "result")

    def test_progress_status_busy_cancellation_and_host_cleanup(self):
        self.request({"id": "load", "operation": "start"})
        self.assertTrue(self.helper.started.wait(1))
        self.assertEqual(read_message(self.reader)["event"]["phase"], "load")
        self.request({"id": "status", "operation": "status"})
        self.assertTrue(self.result()["result"]["busy"])
        self.request({"id": "second", "operation": "start"})
        self.assertEqual(self.result()["error"]["code"], "DOCLING_BUSY")
        self.request({"id": "load", "operation": "cancel"})
        self.assertEqual(self.result()["error"]["code"], "DOCLING_CANCELLED")

    def test_disconnect_cancels_pending_work_and_closes_owned_helper(self):
        self.request({"id": "load", "operation": "start"})
        self.assertTrue(self.helper.started.wait(1))
        self.client.shutdown(socket.SHUT_WR)
        self.thread.join(2)
        self.assertTrue(self.helper.closed)
        self.assertFalse(self.thread.is_alive())

    def test_terminal_reply_clears_busy_before_a_following_operation_can_arrive(self):
        self.helper.release.set()
        self.output.gate = True
        self.request({"id": "load", "operation": "start"})
        self.assertTrue(self.output.entered.wait(1))
        try:
            self.request({"id": "stop", "operation": "stop"})
            self.assertTrue(self.helper.stopped.wait(1), "Completed work must not leave a stale busy request")
        finally:
            self.output.release.set()
        replies = [self.result(), self.result()]
        self.assertTrue(all(reply["kind"] == "result" for reply in replies))
        self.assertEqual({reply["id"] for reply in replies}, {"load", "stop"})


if __name__ == "__main__":
    unittest.main()
