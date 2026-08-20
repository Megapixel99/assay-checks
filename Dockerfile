# assay in a pinned image, for CI that has neither a Python nor a Node toolchain.
#
# BOTH RUNTIMES, ONE IMAGE, because the tool is two implementations of one contract
# and an image carrying only one of them would quietly answer a different question
# depending on which command you reached for.
#
#   docker build -t assay .
#   docker run --rm -v "$PWD:/work" assay runners
#   docker run --rm -v "$PWD:/work" assay scan .
#   docker run --rm -v "$PWD:/work" --entrypoint assay-js assay scan src
#
# `diff` needs git history, so mount the repository rather than a checkout of the
# working tree — a shallow clone cannot resolve the base ref and the tool will say so
# rather than reporting a clean audit over nothing.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/assay
COPY python/assay/ ./python/assay/
COPY js/ ./js/
COPY pyproject.toml README.md LICENSE ./

# No install step and no dependency resolution: the package is stdlib-only in both
# languages, so putting it on the path IS the installation. Nothing here can break
# because an index was unreachable on the day the image was built.
# `python/` rather than `/opt/assay`: the package lives beside `js/` and is imported
# as `assay`, so the directory that goes on the path is its PARENT.
ENV PYTHONPATH=/opt/assay/python
RUN printf '#!/bin/sh\nexec python3 -m assay "$@"\n' > /usr/local/bin/assay \
    && printf '#!/bin/sh\nexec node /opt/assay/js/src/cli.js "$@"\n' > /usr/local/bin/assay-js \
    && chmod +x /usr/local/bin/assay /usr/local/bin/assay-js

# git refuses to operate on a mounted repository owned by another user, and its error
# is about ownership rather than about the audit — which reads as the tool being
# broken. Declaring the mount safe keeps the failure modes about the code.
RUN git config --global --add safe.directory /work

WORKDIR /work
ENTRYPOINT ["assay"]
CMD ["--help"]
