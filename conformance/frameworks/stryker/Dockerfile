# Stryker, pinned. python3 is here for the probe, not for the framework.
FROM node:22-bookworm-slim

# procps is not optional: Stryker shells out to `ps` to reap its test runners,
# and without it the run dies after the dry run having mutated nothing -- which
# looks exactly like a clean pass.
RUN apt-get update && apt-get install -y --no-install-recommends python3 procps \
    && rm -rf /var/lib/apt/lists/*

COPY fixture/ /work/
COPY stryker.config.json /work/stryker.config.json
COPY probe.py /probe.py
WORKDIR /work

RUN npm install --no-audit --no-fund --save-dev \
      @stryker-mutator/core@8.7.1 \
      @stryker-mutator/mocha-runner@8.7.1 \
      mocha@10.8.2
