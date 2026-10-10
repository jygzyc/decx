export interface HttpResponse {
  status: number;
  location: string | undefined;
  body: ReadableStream<Uint8Array> | null;
  touch: () => void;
  cancel: () => void;
}
