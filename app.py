"""ClinixRAG — evidence-aware medical chat over your own book library."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

from src.helper import SUPPORTED_EXTENSIONS
from src.rag import ConfigurationError, RAGService

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("clinixrag")

APP_NAME = "ClinixRAG"
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "40"))

app = Flask(__name__)
app.config.update(
    MAX_CONTENT_LENGTH=MAX_UPLOAD_MB * 1024 * 1024,
    JSON_SORT_KEYS=False,
)

service = RAGService(manifest_path=Path(app.instance_path) / "documents.json")


def _clean_filename(filename: str) -> str:
    name = Path((filename or "").replace("\\", "/")).name
    name = "".join(char for char in name if char.isprintable()).strip()
    if not name:
        return "untitled.pdf"
    return name[:180]


def _error(message: str, status: int = 400, code: str = "error"):
    return jsonify({"error": message, "code": code}), status


@app.get("/")
def index():
    return render_template(
        "chatbot.html",
        app_name=APP_NAME,
        max_upload_mb=MAX_UPLOAD_MB,
        supported=sorted(ext.lstrip(".").upper() for ext in SUPPORTED_EXTENSIONS),
    )


@app.get("/api/status")
def status():
    payload = service.status()
    payload["max_upload_mb"] = MAX_UPLOAD_MB
    return jsonify(payload)


@app.get("/healthz")
def healthz():
    return jsonify({"status": "ok", "app": APP_NAME})


@app.post("/get")
@app.post("/api/chat")
def chat():
    payload = request.get_json(silent=True) or request.form
    message = str(payload.get("msg") or payload.get("message") or "").strip()
    if not message:
        return _error("Please type a question first.", 400, "empty_message")
    if len(message) > 4000:
        return _error("That question is too long. Please keep it under 4000 characters.", 413)

    try:
        result = service.answer(message)
        logger.info("Answered: %.90s", message)
        return jsonify(result)
    except ConfigurationError as exc:
        logger.warning("Configuration error: %s", exc)
        return _error(str(exc), 503, "configuration")
    except Exception:  # pragma: no cover - depends on external services
        logger.exception("Chat failed")
        return _error(
            "The medical assistant could not answer right now. "
            "Please try again in a moment.",
            500,
            "chat_failed",
        )


@app.get("/api/documents")
def list_documents():
    return jsonify({"documents": service.list_documents()})


@app.post("/upload")
def upload():
    files = request.files.getlist("files") or request.files.getlist("file")
    files = [item for item in files if item and item.filename]
    if not files:
        return _error("Choose at least one book to upload.", 400, "no_file")

    results = []
    success_count = 0

    for storage in files:
        display_name = _clean_filename(storage.filename)
        extension = Path(display_name).suffix.lower()

        if extension not in SUPPORTED_EXTENSIONS:
            results.append(
                {
                    "filename": display_name,
                    "ok": False,
                    "error": f"Unsupported format. Use {', '.join(sorted(e.lstrip('.').upper() for e in SUPPORTED_EXTENSIONS))}.",
                }
            )
            continue

        safe_name = secure_filename(display_name) or f"book{extension}"
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=extension) as temp:
                temp_path = Path(temp.name)
                storage.save(temp_path)

            size = temp_path.stat().st_size
            if size == 0:
                raise ValueError("The file is empty.")

            record = service.ingest(temp_path, display_name, size=size)
            record["ok"] = True
            results.append(record)
            success_count += 1
            logger.info("Uploaded %s (%s chunks)", display_name, record.get("chunks"))
        except ConfigurationError as exc:
            results.append({"filename": display_name, "ok": False, "error": str(exc)})
        except ValueError as exc:
            results.append({"filename": display_name, "ok": False, "error": str(exc)})
        except ImportError:
            logger.exception("Missing dependency while ingesting %s", display_name)
            results.append(
                {
                    "filename": display_name,
                    "ok": False,
                    "error": "The server is missing Python dependencies. Run: pip install -r requirements.txt",
                }
            )
        except Exception:
            logger.exception("Upload failed for %s (%s)", display_name, safe_name)
            results.append(
                {
                    "filename": display_name,
                    "ok": False,
                    "error": "Could not index this book. Check the server logs and try again.",
                }
            )
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    status_code = 200 if success_count else 400
    return jsonify({"results": results, "uploaded": success_count}), status_code


@app.delete("/api/documents/<doc_id>")
def delete_document(doc_id: str):
    try:
        result = service.delete_document(doc_id)
        return jsonify(result)
    except KeyError:
        return _error("Book not found in the library.", 404, "not_found")
    except ConfigurationError as exc:
        return _error(str(exc), 503, "configuration")


@app.errorhandler(413)
def too_large(_error):
    return _error(
        f"That upload is larger than the {MAX_UPLOAD_MB} MB limit. "
        "Raise MAX_UPLOAD_MB in your .env to allow bigger books.",
        413,
        "file_too_large",
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    logger.info("Starting %s on http://127.0.0.1:%s", APP_NAME, port)
    app.run(host="0.0.0.0", port=port, debug=debug)
