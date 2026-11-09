const SHIM = new URL("./shim-sdk.mjs", import.meta.url).href;

// The real SDK only exists inside the Copilot app, so tests resolve it to the recording shim.
export function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") return { url: SHIM, shortCircuit: true };
    return next(specifier, context);
}
