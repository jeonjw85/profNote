import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

export function createLoader(stubs = {}) {
  const cache = new Map();
  function load(path) {
    const filename = resolve(path);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const localRequire = (name) => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (!name.startsWith(".")) return require(name);
      const target = resolve(dirname(filename), name);
      const dependency = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`]
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (!dependency) throw new Error(`Module not found: ${target}`);
      return load(dependency);
    };
    const run = vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename });
    run(localRequire, module, module.exports);
    return module.exports;
  }
  return load;
}
