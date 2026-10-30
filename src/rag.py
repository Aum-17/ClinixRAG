"""RAG service used by the ClinixRAG Flask application.

The service mirrors the original retrieval pipeline (HuggingFace embeddings →
Pinecone → Mistral via LangChain) and adds book ingestion on top of it.
Everything is lazily initialised so the web UI still loads when credentials or
optional packages have not been configured yet.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from src.helper import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    allowed_file,
    download_hugging_face_embeddings,
    extract_documents,
    text_split,
)
from src.prompt import system_prompt

logger = logging.getLogger(__name__)

DEFAULT_INDEX_NAME = "medicalbot"  # kept for compatibility with existing data
DEFAULT_MODEL = "mistral-medium"


class ConfigurationError(RuntimeError):
    """Raised when required credentials or the vector index are missing."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _env(*names: str) -> str:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return ""


class RAGService:
    def __init__(self, manifest_path: str | Path | None = None):
        self.index_name = os.getenv("PINECONE_INDEX_NAME", DEFAULT_INDEX_NAME).strip() or DEFAULT_INDEX_NAME
        self.model_name = os.getenv("MISTRAL_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
        self.manifest_path = Path(manifest_path) if manifest_path else Path("instance/documents.json")
        self._chain = None
        self._store = None
        self._embeddings = None
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ config
    @staticmethod
    def pinecone_api_key() -> str:
        return _env("PINECONE_API_KEY")

    @staticmethod
    def mistral_api_key() -> str:
        return _env("MISTRAL_API_KEY", "MISTRALAI_API_KEY")

    def configuration(self) -> Dict[str, Any]:
        return {
            "pinecone": bool(self.pinecone_api_key()),
            "mistral": bool(self.mistral_api_key()),
            "index": self.index_name,
            "model": self.model_name,
        }

    # ---------------------------------------------------------------- lazy init
    def _embeddings_or_raise(self):
        with self._lock:
            if self._embeddings is None:
                self._embeddings = download_hugging_face_embeddings()
            return self._embeddings

    def _store_or_raise(self):
        if self._store is not None:
            return self._store
        with self._lock:
            if self._store is not None:
                return self._store

            api_key = self.pinecone_api_key()
            if not api_key:
                raise ConfigurationError(
                    "PINECONE_API_KEY is not set. Add it to your .env file and restart the app."
                )
            os.environ.setdefault("PINECONE_API_KEY", api_key)

            try:
                from langchain_pinecone import PineconeVectorStore
            except ImportError as exc:  # pragma: no cover
                raise ConfigurationError(
                    "The langchain-pinecone package is not installed. Run: pip install -r requirements.txt"
                ) from exc

            try:
                self._store = PineconeVectorStore.from_existing_index(
                    index_name=self.index_name,
                    embedding=self._embeddings_or_raise(),
                )
            except Exception as exc:
                logger.exception("Could not open Pinecone index %s", self.index_name)
                raise ConfigurationError(
                    f"Could not open the Pinecone index '{self.index_name}'. "
                    "Create it with `python store_index.py` or check your Pinecone credentials."
                ) from exc
            return self._store

    def _chain_or_raise(self):
        if self._chain is not None:
            return self._chain
        with self._lock:
            if self._chain is not None:
                return self._chain

            mistral_key = self.mistral_api_key()
            if not mistral_key:
                raise ConfigurationError(
                    "MISTRAL_API_KEY is not set. Add it to your .env file and restart the app."
                )
            os.environ.setdefault("MISTRAL_API_KEY", mistral_key)
            os.environ.setdefault("MISTRALAI_API_KEY", mistral_key)

            try:
                from langchain.chains import create_retrieval_chain
                from langchain.chains.combine_documents import create_stuff_documents_chain
                from langchain_core.prompts import ChatPromptTemplate
                from langchain_mistralai import ChatMistralAI
            except ImportError as exc:  # pragma: no cover
                raise ConfigurationError(
                    "LangChain dependencies are missing. Run: pip install -r requirements.txt"
                ) from exc

            store = self._store_or_raise()
            retriever = store.as_retriever(
                search_type="similarity", search_kwargs={"k": 5}
            )
            llm = ChatMistralAI(
                model=self.model_name,
                temperature=0.1,
                max_tokens=700,
                api_key=mistral_key,
            )
            prompt = ChatPromptTemplate.from_messages(
                [("system", system_prompt), ("human", "{input}")]
            )
            question_answer_chain = create_stuff_documents_chain(llm, prompt)
            self._chain = create_retrieval_chain(retriever, question_answer_chain)
            return self._chain

    def _require_chat_credentials(self) -> None:
        missing = []
        if not self.pinecone_api_key():
            missing.append("PINECONE_API_KEY")
        if not self.mistral_api_key():
            missing.append("MISTRAL_API_KEY")
        if missing:
            raise ConfigurationError(
                f"{' and '.join(missing)} {'is' if len(missing) == 1 else 'are'} not set. "
                "Add them to your .env file and restart the app."
            )

    # ------------------------------------------------------------------- answer
    def answer(self, question: str) -> Dict[str, Any]:
        self._require_chat_credentials()
        chain = self._chain_or_raise()
        response = chain.invoke({"input": question})
        answer = (response.get("answer") or "").strip()
        if not answer:
            answer = (
                "I could not find an answer to that in the current medical library. "
                "Try rephrasing the question or uploading a relevant reference book."
            )
        return {"answer": answer, "sources": self._format_sources(response.get("context") or [])}

    @staticmethod
    def _format_sources(documents: List[Any]) -> List[Dict[str, Any]]:
        seen = set()
        sources: List[Dict[str, Any]] = []
        for document in documents:
            metadata = getattr(document, "metadata", {}) or {}
            source = str(metadata.get("source") or "Knowledge base")
            source = Path(source).name
            page = metadata.get("page")
            key = (source, page)
            if key in seen:
                continue
            seen.add(key)
            entry: Dict[str, Any] = {"source": source}
            try:
                if page is not None:
                    entry["page"] = int(page) + 1
            except (TypeError, ValueError):
                pass
            sources.append(entry)
            if len(sources) >= 5:
                break
        return sources

    # ----------------------------------------------------------------- ingest
    def ingest(self, file_path: str | Path, filename: str, size: int | None = None) -> Dict[str, Any]:
        if not allowed_file(filename):
            raise ValueError(f"Unsupported file type: {Path(filename).suffix or 'unknown'}")
        if not self.pinecone_api_key():
            raise ConfigurationError(
                "PINECONE_API_KEY is not set. Add it to your .env file and restart the app."
            )

        documents = extract_documents(file_path, filename)
        chunks = text_split(documents)
        if not chunks:
            raise ValueError("No readable text was found in this file.")

        doc_id = uuid.uuid4().hex[:12]
        for chunk in chunks:
            chunk.metadata.update(
                {
                    "doc_id": doc_id,
                    "source": filename,
                    "file_type": Path(filename).suffix.lstrip(".").lower(),
                    "ingested_at": _now_iso(),
                }
            )

        store = self._store_or_raise()
        batch_size = 100
        for start in range(0, len(chunks), batch_size):
            store.add_documents(chunks[start : start + batch_size])

        record = {
            "id": doc_id,
            "filename": filename,
            "size": int(size or 0),
            "chunks": len(chunks),
            "uploaded_at": _now_iso(),
            "index": self.index_name,
        }
        self._add_to_manifest(record)
        logger.info("Ingested %s (%s chunks) as %s", filename, len(chunks), doc_id)
        return record

    # --------------------------------------------------------------- manifest
    def _read_manifest(self) -> List[Dict[str, Any]]:
        try:
            with self.manifest_path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            documents = payload.get("documents", []) if isinstance(payload, dict) else []
            return [doc for doc in documents if isinstance(doc, dict)]
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return []

    def _write_manifest(self, documents: List[Dict[str, Any]]) -> None:
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.manifest_path.with_suffix(".tmp")
        with temp_path.open("w", encoding="utf-8") as handle:
            json.dump(
                {"index": self.index_name, "documents": documents},
                handle,
                indent=2,
                ensure_ascii=False,
            )
        temp_path.replace(self.manifest_path)

    def _add_to_manifest(self, record: Dict[str, Any]) -> None:
        with self._lock:
            documents = [doc for doc in self._read_manifest() if doc.get("id") != record["id"]]
            documents.insert(0, record)
            self._write_manifest(documents)

    def list_documents(self) -> List[Dict[str, Any]]:
        return self._read_manifest()

    def delete_document(self, doc_id: str) -> Dict[str, Any]:
        with self._lock:
            documents = self._read_manifest()
            record = next((doc for doc in documents if doc.get("id") == doc_id), None)
            if record is None:
                raise KeyError(doc_id)

        vectors_removed = True
        try:
            store = self._store_or_raise()
            store.delete(filter={"doc_id": doc_id})
        except Exception:  # pragma: no cover - depends on Pinecone client version
            logger.exception("Could not delete vectors for %s", doc_id)
            vectors_removed = False

        with self._lock:
            remaining = [doc for doc in self._read_manifest() if doc.get("id") != doc_id]
            self._write_manifest(remaining)

        return {"deleted": doc_id, "vectors_removed": vectors_removed}

    # ----------------------------------------------------------------- status
    def status(self) -> Dict[str, Any]:
        config = self.configuration()
        configured = config["pinecone"] and config["mistral"]
        return {
            "app": "ClinixRAG",
            "configured": configured,
            "configuration": config,
            "documents": len(self.list_documents()),
            "chunk_size": CHUNK_SIZE,
            "chunk_overlap": CHUNK_OVERLAP,
        }
