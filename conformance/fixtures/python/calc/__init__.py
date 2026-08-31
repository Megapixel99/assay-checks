"""A deliberately small target: every line here is mutable, and every line is tested."""


def clamp(value, low, high):
    if value < low:
        return low
    if value > high:
        return high
    return value


def score(hits, total):
    if total == 0:
        return 0.0
    return hits / total


def tally(values):
    out = 0
    for v in values:
        out = out + v
    return out
