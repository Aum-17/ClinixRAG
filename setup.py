from setuptools import find_packages, setup

setup(
    name="clinixrag",
    version="2.0.0",
    author="Aum-17",
    author_email="aumpatil85@gmail.com",
    description="ClinixRAG — retrieval-augmented medical chat over your own book library.",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "flask>=3.0",
        "python-dotenv>=1.0",
        "langchain>=0.3.7",
        "langchain-community>=0.3.5",
        "langchain-pinecone>=0.2.0",
        "langchain-mistralai>=0.2.0",
        "langchain-huggingface>=0.1.0",
        "pinecone>=5.0",
        "sentence-transformers>=3.0",
        "pypdf>=4.0",
        "python-docx>=1.1",
        "ebooklib>=0.18",
        "beautifulsoup4>=4.12",
    ],
)
