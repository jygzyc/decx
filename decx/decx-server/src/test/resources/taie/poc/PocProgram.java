/**
 * Small test program for the Tai-e PoC.
 * Exercises virtual dispatch, field access, and a simple data flow
 * so we can verify CallGraph, points-to, and signature bridging.
 */
public class PocProgram {

    static Interface impl1 = new ImplA();
    static Interface impl2 = new ImplB();

    public static void main(String[] args) {
        Interface obj = getImpl(args.length);
        String data = obj.fetch();       // virtual dispatch: ImplA.fetch or ImplB.fetch
        sink(data);                       // data flows from fetch() to sink()
    }

    static Interface getImpl(int n) {
        if (n > 0) {
            return impl1;                 // returns ImplA instance
        } else {
            return impl2;                 // returns ImplB instance
        }
    }

    static void sink(String input) {
        System.out.println(input);
    }

    interface Interface {
        String fetch();
    }

    static class ImplA implements Interface {
        public String fetch() {
            return "data-a";
        }
    }

    static class ImplB implements Interface {
        public String fetch() {
            return "data-b";
        }
    }
}
