declare module "*sql-wasm.js" {
  const initialize: (options: {
    instantiateWasm: (
      imports: WebAssembly.Imports,
      success: (...args: any[]) => void,
    ) => WebAssembly.Exports;
  }) => Promise<any>;
  export default initialize;
}
