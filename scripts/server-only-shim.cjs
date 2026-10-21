// Скрипты командной строки выполняют серверный код вне Next.js: пакет «server-only»
// там не нужен (он лишь запрещает импорт в браузерный бандл), поэтому подменяем его пустым модулем.
const Module = require("node:module");
const path = require("node:path");
const empty = path.join(__dirname, "server-only-empty.cjs");
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return empty;
  return orig.call(this, request, ...rest);
};
