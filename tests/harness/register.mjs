import * as nodeModule from "node:module";
import { resolve } from "./hooks.mjs";

// `registerHooks` runs in this thread (Node 22.15+); `register`, deprecated, is only the way in where it is missing.
if (typeof nodeModule.registerHooks === "function") nodeModule.registerHooks({ resolve });
else nodeModule.register("./hooks.mjs", import.meta.url);
