import time

from calc import clamp, score, tally

# EVERY test sleeps. The suite has to be slow enough that a run can be killed
# WHILE A MUTANT IS APPLIED rather than between two of them -- otherwise a
# framework that mutates in place would look clean for reasons of timing.
DWELL = 0.4


def test_clamp():
    time.sleep(DWELL)
    assert clamp(5, 0, 10) == 5
    assert clamp(-1, 0, 10) == 0
    assert clamp(11, 0, 10) == 10


def test_score():
    time.sleep(DWELL)
    assert score(1, 2) == 0.5
    assert score(0, 0) == 0.0


def test_tally():
    time.sleep(DWELL)
    assert tally([1, 2, 3]) == 6
    assert tally([]) == 0
