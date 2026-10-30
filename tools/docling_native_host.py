"""Chrome Native Messaging host for the installed, loopback-only Docling helper."""
import argparse
import ast
import json
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

MAX_MESSAGE = 64 * 1024
MODEL_FILES = ("config.json", "preprocessor_config.json", "model.safetensors")
MODEL = "docling-project/docling-layout-heron"


class HelperError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def cancelled(event):
    if event.is_set():
        raise HelperError("DOCLING_CANCELLED", "Docling preparation was stopped. Completed model files remain cached.")


def default_home():
    if os.environ.get("PAPER_DOCLING_HOME"):
        return Path(os.environ["PAPER_DOCLING_HOME"])
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "PaperTranslator/Docling"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/PaperTranslator/Docling"
    return Path.home() / ".local/share/paper-translator/docling"


def normalize_origin(origin):
    if not isinstance(origin, str) or not re.fullmatch(r"chrome-extension://[a-p]{32}/?", origin):
        raise HelperError("DOCLING_ORIGIN", "The calling extension is not permitted to use this helper.")
    return origin.rstrip("/")


def read_config(home, origin):
    try:
        config = json.loads((home / "config.json").read_text(encoding="utf-8"))
        origins = [normalize_origin(value) for value in config["allowedOrigins"]]
        python = Path(config["python"])
        if not origins or normalize_origin(origin) not in origins:
            raise ValueError("Unapproved extension")
        if not python.is_absolute() or not python.is_file():
            raise ValueError("Missing Python runtime")
        return {"allowedOrigins": list(dict.fromkeys(origins)), "python": str(python)}
    except (OSError, ValueError, KeyError, TypeError):
        raise HelperError("DOCLING_INSTALLATION", "The Docling helper registration is incomplete. Run its installer again.") from None


def read_model_revision(service):
    # Importing the service enables offline mode; preparation must still be able to download.
    values = {}
    for node in ast.parse(service.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in {"MODEL", "REVISION"}:
                    values[target.id] = node.value.value
    if values.get("MODEL") != MODEL or not isinstance(values.get("REVISION"), str) or not re.fullmatch(r"[a-f0-9]{40}", values["REVISION"]):
        raise HelperError("DOCLING_INSTALLATION", "The installed Docling model configuration is invalid. Reinstall the helper.")
    return values["REVISION"]


def valid_model_file(path):
    try:
        if path.is_symlink():
            return False
        if path.name.endswith(".json"):
            if not 0 < path.stat().st_size <= 4 * 1024 * 1024:
                return False
            value = json.loads(path.read_text(encoding="utf-8"))
            return isinstance(value, dict) and bool(value)
        size = path.stat().st_size
        with path.open("rb") as stream:
            header_size = struct.unpack("<Q", stream.read(8))[0]
            if not 2 <= header_size <= min(16 * 1024 * 1024, size - 8):
                return False
            header = json.loads(stream.read(header_size))
        tensors = [value for key, value in header.items() if key != "__metadata__"]
        return bool(tensors) and all(isinstance(value, dict) and
            isinstance(value.get("data_offsets"), list) and len(value["data_offsets"]) == 2 and
            all(isinstance(n, int) and not isinstance(n, bool) for n in value["data_offsets"]) and
            0 <= value["data_offsets"][0] <= value["data_offsets"][1] <= size - 8 - header_size
            for value in tensors)
    except (OSError, ValueError, TypeError, AttributeError, struct.error):
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


class DoclingHelper:
    def __init__(self, home, config, port=8876):
        self.home, self.config, self.port = Path(home), config, port
        self.service = self.home / "tools/docling_service.py"
        self.revision = read_model_revision(self.service)
        self.models = self.home / "models"
        self.model_directory = self.models / MODEL.replace("/", "--")
        self.child = None
        self.child_lock = threading.RLock()
        self.closed = False
        self.local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def model_ready(self):
        try:
            revision = (self.models / "revision.txt").read_text(encoding="ascii").strip()
        except (OSError, UnicodeError):
            return False
        return revision == self.revision and all(valid_model_file(self.model_directory / name) for name in MODEL_FILES)

    def http(self, path, *, method="GET", timeout=2):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
            headers={"Origin": self.config["allowedOrigins"][0]}, data=b"" if method == "POST" else None)
        try:
            response = self.local_http.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            error.close()
            raise
        with response:
            raw = response.read(MAX_MESSAGE + 1)
            if len(raw) > MAX_MESSAGE:
                raise ValueError("Oversized Docling status response")
            return json.loads(raw)

    def service_info(self):
        try:
            info = self.http("/v1/info")
            if info.get("schema") == 1 and re.fullmatch(r"[a-f0-9]{64}", info.get("identity", "")) and \
                    info.get("config", {}).get("device") == "cpu" and info["config"].get("batch_size") == 1:
                return info
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        return None

    def status(self, busy=False):
        info = self.service_info()
        managed = self.child is not None and self.child.poll() is None
        loaded = info.get("modelLoaded") if info else False
        return {"schema": 1, "installed": True, "modelReady": self.model_ready(),
                "running": info is not None, "managed": managed,
                "modelLoaded": loaded if isinstance(loaded, bool) else None,
                "busy": bool(busy or info and info.get("busy"))}

    def download_models(self, event, progress):
        if self.model_ready():
            return
        self.model_directory.mkdir(parents=True, exist_ok=True)
        try:
            previous_revision = (self.models / "revision.txt").read_text(encoding="ascii").strip()
        except (OSError, UnicodeError):
            previous_revision = None
        if previous_revision != self.revision:
            for name in MODEL_FILES:
                (self.model_directory / name).unlink(missing_ok=True)
            marker = self.models / "revision.txt.partial"
            marker.write_text(self.revision+"\n", encoding="ascii")
            os.replace(marker, self.models / "revision.txt")
        for name in MODEL_FILES:
            cancelled(event)
            target = self.model_directory / name
            if valid_model_file(target):
                continue
            request = urllib.request.Request(f"https://huggingface.co/{MODEL}/resolve/{self.revision}/{name}",
                headers={"User-Agent": "PaperTranslator-Docling-Helper/1"})
            temporary = None
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    if not response.geturl().startswith("https://"):
                        raise ValueError("Unexpected model download redirect")
                    length = response.headers.get("Content-Length")
                    total = int(length) if length is not None else None
                    limit = 4 * 1024 * 1024 if name.endswith(".json") else 2 * 1024 * 1024 * 1024
                    if total is not None and not 0 < total <= limit:
                        raise ValueError("Invalid model file size")
                    loaded, last_progress = 0, 0
                    progress({"phase": "download", "loaded": 0, "total": total, "message": name})
                    with tempfile.NamedTemporaryFile(dir=self.model_directory, prefix=name+".", suffix=".partial", delete=False) as stream:
                        temporary = Path(stream.name)
                        while chunk := response.read(256 * 1024):
                            cancelled(event)
                            loaded += len(chunk)
                            if loaded > limit:
                                raise ValueError("Model file exceeds the size limit")
                            stream.write(chunk)
                            if time.monotonic() - last_progress >= 0.25:
                                progress({"phase": "download", "loaded": loaded, "total": total, "message": name})
                                last_progress = time.monotonic()
                    cancelled(event)
                    if total is not None and loaded != total:
                        raise ValueError("Incomplete model download")
                    # Validate under its intended filename before publishing the file.
                    if name.endswith(".json"):
                        value = json.loads(temporary.read_text(encoding="utf-8"))
                        if not 0 < temporary.stat().st_size <= 4 * 1024 * 1024 or not isinstance(value, dict) or not value:
                            raise ValueError("Invalid model JSON")
                    elif not valid_model_file(temporary):
                        raise ValueError("Invalid model weights")
                    os.replace(temporary, target)
                    temporary = None
                    progress({"phase": "download", "loaded": loaded, "total": total or loaded, "message": name})
            except HelperError:
                raise
            except (OSError, ValueError) as error:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                raise HelperError("DOCLING_DOWNLOAD", "The Docling model download failed. Check the connection and retry.") from error
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        cancelled(event)
        marker = self.models / "revision.txt.partial"
        marker.write_text(self.revision+"\n", encoding="ascii")
        os.replace(marker, self.models / "revision.txt")

    def start(self, event, progress):
        cancelled(event)
        if self.service_info() is None:
            if not self.model_ready():
                raise HelperError("DOCLING_MODEL_NOT_READY", "Prepare the Docling model in extension settings first.")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.3):
                    raise HelperError("DOCLING_PORT_BUSY", "The Docling port is already used by another application.")
            except (ConnectionError, TimeoutError, socket.timeout):
                pass
            (self.home / "logs").mkdir(parents=True, exist_ok=True)
            (self.home / "cache").mkdir(parents=True, exist_ok=True)
            command = [self.config["python"], str(self.service), "--port", str(self.port),
                       "--artifacts", str(self.models), "--cache", str(self.home / "cache")]
            for origin in self.config["allowedOrigins"]:
                command += ["--allow-origin", origin]
            progress({"phase": "start"})
            with self.child_lock:
                cancelled(event)
                if self.closed:
                    raise HelperError("DOCLING_CANCELLED", "The Docling helper has closed.")
                if self.child is None or self.child.poll() is not None:
                    with (self.home / "logs/service.log").open("ab") as log:
                        self.child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                            cwd=self.home, env={**os.environ, "PYTHONUNBUFFERED": "1"},
                            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            deadline = time.monotonic() + 25
            while self.service_info() is None:
                cancelled(event)
                if self.child.poll() is not None:
                    raise HelperError("DOCLING_START_FAILED", "Docling could not start. Check the helper service log.")
                if time.monotonic() >= deadline:
                    raise HelperError("DOCLING_START_FAILED", "Docling did not become ready in time. Check the helper service log.")
                event.wait(0.2)
        cancelled(event)
        info = self.service_info()
        if info and info.get("modelLoaded") is True:
            return self.status()
        progress({"phase": "load"})
        try:
            self.http("/v1/warmup", method="POST", timeout=120)
        except urllib.error.HTTPError as error:
            if error.code == 503:
                raise HelperError("DOCLING_BUSY", "Docling is processing a document. Retry after it finishes.") from None
            if error.code != 404 or self.child is not None and self.child.poll() is None:
                raise HelperError("DOCLING_LOAD_FAILED", "Docling could not load its model. Check the helper service log.") from None
            # An older manually started service can still serve PDFs without the warmup endpoint.
        except (OSError, ValueError):
            raise HelperError("DOCLING_LOAD_FAILED", "Docling model preparation did not complete. Check the helper service log.") from None
        cancelled(event)
        return self.status()

    def stop(self):
        if self.child is None or self.child.poll() is not None:
            if self.service_info() is not None:
                raise HelperError("DOCLING_EXTERNAL_SERVICE", "This Docling service was started separately. Stop it using its original application.")
            return self.status()
        info = self.service_info()
        if info is None or info.get("busy"):
            raise HelperError("DOCLING_BUSY", "Docling is processing a document. Retry after it finishes.")
        self.terminate_child()
        return self.status()

    def terminate_child(self):
        with self.child_lock:
            if self.child is not None and self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=5)
            self.child = None

    def close(self):
        with self.child_lock:
            self.closed = True
            self.terminate_child()


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        data = stream.read(size - len(chunks))
        if not data:
            if not chunks:
                return None
            raise HelperError("DOCLING_PROTOCOL", "Incomplete native message.")
        chunks.extend(data)
    return bytes(chunks)


def read_message(stream):
    prefix = read_exact(stream, 4)
    if prefix is None:
        return None
    length = struct.unpack("=I", prefix)[0]
    if not 0 < length <= MAX_MESSAGE:
        raise HelperError("DOCLING_PROTOCOL", "Native message exceeds the supported size.")
    body = read_exact(stream, length)
    if body is None:
        raise HelperError("DOCLING_PROTOCOL", "Incomplete native message.")
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HelperError("DOCLING_PROTOCOL", "Invalid native message JSON.") from None


def serve(helper, input_stream, output_stream):
    write_lock, job_lock = threading.Lock(), threading.Lock()
    current = {"id": None, "event": None, "thread": None}

    def send(message):
        raw = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_MESSAGE:
            raise HelperError("DOCLING_PROTOCOL", "Native response exceeds the supported size.")
        with write_lock:
            output_stream.write(struct.pack("=I", len(raw)) + raw)
            output_stream.flush()

    def error_message(identifier, error):
        return {"kind": "error", "id": identifier, "error": {"code": getattr(error, "code", "DOCLING_HELPER"),
            "message": str(error)[:1000] if isinstance(error, HelperError) else "The Docling helper operation failed. Check its installation and log."}}

    def failure(identifier, error):
        send(error_message(identifier, error))

    def run(operation, identifier, event):
        try:
            progress = lambda value: send({"kind": "progress", "id": identifier, "event": value})
            if operation == "prepare":
                helper.download_models(event, progress)
            result = helper.start(event, progress) if operation in {"prepare", "start"} else helper.stop()
            cancelled(event)
            terminal = {"kind": "result", "id": identifier, "result": result}
        except Exception as error:
            terminal = error_message(identifier, error)
        finally:
            with job_lock:
                if current["event"] is event:
                    current.update(id=None, event=None, thread=None)
        try:
            send(terminal)
        except (OSError, ValueError):
            pass

    try:
        while (message := read_message(input_stream)) is not None:
            identifier = message.get("id") if isinstance(message, dict) else None
            operation = message.get("operation") if isinstance(message, dict) else None
            if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) or \
                    set(message) != {"id", "operation"} or not isinstance(operation, str) or operation not in {"status", "prepare", "start", "stop", "unload", "cancel"}:
                failure(identifier if isinstance(identifier, str) and len(identifier) <= 128 else "", HelperError("DOCLING_REQUEST", "Invalid Docling helper request."))
                continue
            if operation == "status":
                send({"kind": "result", "id": identifier, "result": helper.status(current["id"] is not None)})
            elif operation == "cancel":
                with job_lock:
                    if current["id"] == identifier:
                        current["event"].set()
            else:
                with job_lock:
                    if current["id"] is not None:
                        failure(identifier, HelperError("DOCLING_BUSY", "A Docling helper operation is already running."))
                        continue
                    event = threading.Event()
                    worker = threading.Thread(target=run, args=(operation, identifier, event), daemon=True)
                    current.update(id=identifier, event=event, thread=worker)
                    worker.start()
    except HelperError as error:
        failure("", error)
    except (OSError, BrokenPipeError):
        pass
    finally:
        with job_lock:
            if current["event"]:
                current["event"].set()
        helper.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("--home", type=Path, default=default_home())
    parser.add_argument("--port", type=int, default=8876)
    parser.add_argument("--parent-window", type=int, default=0)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("invalid local service port")
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        home = args.home.resolve()
        config = read_config(home, args.origin)
        helper = DoclingHelper(home, config, args.port)
        serve(helper, sys.stdin.buffer, sys.stdout.buffer)
    except (HelperError, OSError, ValueError) as error:
        print(f"Docling helper: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
