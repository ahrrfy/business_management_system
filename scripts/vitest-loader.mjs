export function resolve(specifier, context, nextResolve) {
  if (specifier === '#module-evaluator') {
    return {
      shortCircuit: true,
      url: new URL('../node_modules/vitest/dist/module-evaluator.js', import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
