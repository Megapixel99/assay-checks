package calc;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class CalcTest {

    // EVERY test sleeps, for the reason given in the Python fixture: the suite
    // has to be slow enough that a run can be killed WHILE A MUTANT IS APPLIED
    // rather than between two of them.
    private static final long DWELL_MS = 400;

    private static void dwell() {
        try {
            Thread.sleep(DWELL_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    public void clamps() {
        dwell();
        assertEquals(5, Calc.clamp(5, 0, 10));
        assertEquals(0, Calc.clamp(-1, 0, 10));
        assertEquals(10, Calc.clamp(11, 0, 10));
    }

    @Test
    public void scores() {
        dwell();
        assertEquals(0.5, Calc.score(1, 2), 0.0);
        assertEquals(0.0, Calc.score(0, 0), 0.0);
    }

    @Test
    public void tallies() {
        dwell();
        assertEquals(6, Calc.tally(new int[] {1, 2, 3}));
        assertEquals(0, Calc.tally(new int[] {}));
    }
}
