import { readFile, writeFile } from "node:fs/promises";

// Temporary fix for https://github.com/excalidraw/mermaid-to-excalidraw/issues/107.
// Mermaid 11.17 prefixes cluster IDs with the rendered SVG's ID. Match that
// exact prefix so similarly named (or nested) subgraphs cannot be confused.
const parser = new URL(
  "../node_modules/@excalidraw/mermaid-to-excalidraw/dist/parser/flowchart.js",
  import.meta.url,
);
const original = 'const el = containerEl.querySelector(`[id=\'${data.id}\']`);';
const patched = `const svgId = containerEl.querySelector("svg")?.id;
    const el = containerEl.querySelector(\`#\${CSS.escape(data.id)}\`) ||
        (svgId ? containerEl.querySelector(\`#\${CSS.escape(\`\${svgId}-\${data.id}\`)}\`) : null);`;
const source = await readFile(parser, "utf8");

if (!source.includes(patched)) {
  if (source.split(original).length !== 2) {
    throw new Error("Mermaid parser changed: review the subgraph compatibility patch before building.");
  }
  await writeFile(parser, source.replace(original, patched));
}
