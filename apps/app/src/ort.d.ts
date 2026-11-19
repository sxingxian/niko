// The little of ONNX Runtime Web the voice check uses (the package's own types aren't reachable through its exports).
declare module 'onnxruntime-web' {
  export const env: { wasm: { wasmPaths?: string; numThreads?: number } };
  export class Tensor { constructor(type: 'float32', data: Float32Array, dims: number[]); readonly data: Float32Array | Int32Array | BigInt64Array; }
  export class InferenceSession {
    static create(model: Uint8Array, options?: { executionProviders?: string[] }): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}
