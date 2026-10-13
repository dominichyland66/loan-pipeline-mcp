// Bundles src/widget/app.ts with esbuild and inlines it into src/widget/app.html,
// producing the single self-contained dist/widget.html the MCP server serves
// as the ui:// resource.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const out = await build({
  entryPoints: ["src/widget/app.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
  legalComments: "none",
});
// "</script" inside the bundled JS would close the inline <script> tag early.
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = fs
  .readFileSync("src/widget/app.html", "utf8")
  // Function replacer: a string replacement would interpret "$'" / "$&" etc. inside the JS.
  .replace('<script type="module" src="./app.ts"></script>', () => `<script>${js}</script>`);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync(path.join("dist", "widget.html"), html);
console.log(`dist/widget.html ${(html.length / 1024).toFixed(0)} KB`);
