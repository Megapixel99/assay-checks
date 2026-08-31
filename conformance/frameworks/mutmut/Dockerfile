# mutmut, pinned. A conformance result that cannot be reproduced is an anecdote.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir mutmut==3.7.0 pytest==8.3.4

COPY fixture/ /work/
COPY probe.py /probe.py
WORKDIR /work
