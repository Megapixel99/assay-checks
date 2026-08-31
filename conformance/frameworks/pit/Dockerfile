# PIT, pinned. Maven's dependencies are resolved at BUILD time so the probed run
# is offline: a network stall in the middle of a timed kill would be measuring
# the registry rather than the framework.
FROM maven:3.9-eclipse-temurin-17

RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

COPY fixture/ /work/
COPY probe.py /probe.py
WORKDIR /work

RUN mvn -B -q dependency:go-offline \
 && mvn -B -q test-compile \
 && mvn -B -q org.pitest:pitest-maven:1.16.1:help >/dev/null 2>&1 || true
