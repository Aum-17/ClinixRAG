"""Build (or refresh) the Pinecone knowledge base for ClinixRAG.

Usage:
    python store_index.py                 # index every PDF in ./Data
    python store_index.py --data ./books  # use a different folder
    python store_index.py --reset --yes   # recreate the index from scratch
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from src.helper import download_hugging_face_embeddings, load_pdf_file, text_split

DEFAULT_INDEX_NAME = "medicalbot"
VECTOR_DIMENSION = 384  # all-MiniLM-L6-v2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Index medical PDFs into Pinecone for ClinixRAG.")
    parser.add_argument("--data", default="Data", help="Folder containing PDF books (default: Data).")
    parser.add_argument("--index", default=os.getenv("PINECONE_INDEX_NAME", DEFAULT_INDEX_NAME))
    parser.add_argument("--reset", action="store_true", help="Delete and recreate the index before indexing.")
    parser.add_argument("--yes", action="store_true", help="Skip the confirmation prompt used by --reset.")
    return parser.parse_args()


def main() -> int:
    load_dotenv()
    args = parse_args()

    api_key = os.getenv("PINECONE_API_KEY", "").strip()
    if not api_key:
        print("Missing PINECONE_API_KEY. Add it to your .env file first.", file=sys.stderr)
        return 1

    data_dir = Path(args.data)
    if not data_dir.exists():
        print(f"Data folder not found: {data_dir}", file=sys.stderr)
        return 1
    if not list(data_dir.glob("*.pdf")):
        print(f"No PDF files found in {data_dir}", file=sys.stderr)
        return 1

    try:
        from pinecone import Pinecone, ServerlessSpec
        from langchain_pinecone import PineconeVectorStore
    except ImportError as exc:
        print(f"Missing dependency: {exc}. Run `pip install -r requirements.txt`.", file=sys.stderr)
        return 1

    os.environ["PINECONE_API_KEY"] = api_key
    pc = Pinecone(api_key=api_key)
    existing = {index["name"] for index in pc.list_indexes()}

    if args.index in existing and args.reset:
        if not args.yes:
            answer = input(f"Recreate index '{args.index}' and delete its vectors? [y/N] ").strip().lower()
            if answer not in {"y", "yes"}:
                print("Aborted.")
                return 1
        print(f"Deleting index '{args.index}'...")
        pc.delete_index(args.index)
        existing.discard(args.index)

    if args.index not in existing:
        print(f"Creating index '{args.index}' (dimension={VECTOR_DIMENSION}, cosine)...")
        pc.create_index(
            name=args.index,
            dimension=VECTOR_DIMENSION,
            metric="cosine",
            spec=ServerlessSpec(cloud="aws", region="us-east-1"),
        )

    print(f"Loading PDFs from {data_dir}...")
    documents = load_pdf_file(str(data_dir))
    chunks = text_split(documents)
    print(f"Loaded {len(documents)} pages -> {len(chunks)} chunks.")

    print("Downloading embeddings and uploading vectors (this can take a minute)...")
    embeddings = download_hugging_face_embeddings()
    PineconeVectorStore.from_documents(
        documents=chunks,
        embedding=embeddings,
        index_name=args.index,
    )
    print(f"Done. Index '{args.index}' is ready with {len(chunks)} chunks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
