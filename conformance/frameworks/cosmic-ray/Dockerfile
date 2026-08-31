# cosmic-ray, pinned. Applies mutations to the file on disk and restores them,
# which is the design the SIGKILL question was written about.
FROM python:3.12-slim

RUN pip install --no-cache-dir cosmic-ray==8.4.6 pytest==8.3.4

COPY fixture/ /work/
COPY cosmic-ray.toml /work/cosmic-ray.toml
COPY probe.py /probe.py
WORKDIR /work

# The session is initialised at BUILD time and kept outside the tree, so the
# probed command is `cosmic-ray exec` itself rather than a shell running two
# things. A shell leader would take a leader-only signal on cosmic-ray's behalf,
# leave cosmic-ray orphaned, and let it finish unwatched -- which the report
# would then have to credit to a signal that never reached it.
RUN cosmic-ray init cosmic-ray.toml /session.sqlite
