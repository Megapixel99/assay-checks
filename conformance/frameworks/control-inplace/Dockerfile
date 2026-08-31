# The calibration row: a harness that passes all seven properties and mutates
# the tree in place. If the probe cannot report DIRTY here, nothing it reports
# about the real frameworks means anything.
FROM python:3.12-slim

RUN pip install --no-cache-dir pytest==8.3.4

COPY fixture/ /work/
COPY mutations_calc.py /work/mutations_calc.py
COPY probe.py /probe.py
WORKDIR /work
