public class NewLeak {
    public static void main(String[] args) {
        String secret = SourceSink.source();
        String processed = secret.toUpperCase();
        SourceSink.sink(processed);
    }
}
