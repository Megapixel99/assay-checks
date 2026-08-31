package calc;

/** The Java half of the same deliberately small target, kept parallel to the
 *  Python and JavaScript fixtures so a difference in the report is a difference
 *  in the FRAMEWORK rather than in the code under test. */
public final class Calc {

    private Calc() {}

    public static int clamp(int value, int low, int high) {
        if (value < low) {
            return low;
        }
        if (value > high) {
            return high;
        }
        return value;
    }

    public static double score(int hits, int total) {
        if (total == 0) {
            return 0.0;
        }
        return (double) hits / total;
    }

    public static int tally(int[] values) {
        int out = 0;
        for (int v : values) {
            out = out + v;
        }
        return out;
    }
}
