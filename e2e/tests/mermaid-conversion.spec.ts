import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";

// Include similarly named, nested subgraphs and multiline labels: the converter
// must resolve the exact rendered cluster, not the first matching ID suffix.
const definition = `flowchart TB
  subgraph GROUP["Outer group"]
    subgraph INNER["Inner group"]
      A["First line
Second line"] --> B["Destination"]
    end
  end
  subgraph OTHER_GROUP["Other group"]
    C["Third node"]
  end
  B --> C
  classDef blue fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  class A,B blue`;

test("Mermaid subgraphs remain editable after conversion and reload", async ({ page, request }) => {
  const drawing = await createDrawing(request, { name: `Mermaid_Test_${Date.now()}` });
  try {
    await page.goto(`/editor/${drawing.id}`);
    await page.locator(".App-toolbar__extra-tools-trigger").click();
    await page.getByText("Mermaid to Excalidraw", { exact: true }).click();
    const dialog = page.locator(".ttd-dialog");
    await dialog.locator("textarea").fill(definition);
    const insert = dialog.getByRole("button", { name: /insert/i });
    await expect(dialog.locator("canvas")).toBeVisible({ timeout: 30000 });
    await expect(insert).toBeEnabled();
    await insert.click();
    await expect(dialog).not.toBeVisible();

    const assertEditable = async () => {
      await expect.poll(async () => {
        const saved = await getDrawing(request, drawing.id);
        return saved.elements?.filter((element) => !element.isDeleted).length ?? 0;
      }).toBeGreaterThan(1);
      const saved = await getDrawing(request, drawing.id);
      const elements = saved.elements!.filter((element) => !element.isDeleted);
      expect(elements.some((element) => element.type === "image")).toBe(false);
      expect(elements.filter((element) => element.type === "arrow")).toHaveLength(2);
      // Labels come from Mermaid's model, so check geometry to catch a wrong cluster match.
      const box = (label: string) => {
        const text = elements.find((element) => element.type === "text" && element.originalText === label);
        const container = elements.find((element) => element.id === text?.containerId);
        expect(container, label).toBeTruthy();
        return container;
      };
      const contains = (outer: string, inner: string) => {
        const a = box(outer);
        const b = box(inner);
        return a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
      };
      expect(contains("Outer group", "Inner group")).toBe(true);
      expect(contains("Inner group", "First line\nSecond line")).toBe(true);
      expect(contains("Inner group", "Destination")).toBe(true);
      expect(contains("Other group", "Third node")).toBe(true);
      expect(contains("Outer group", "Third node")).toBe(false);
      expect(contains("Other group", "Destination")).toBe(false);
    };
    await assertEditable();
    await page.reload();
    await expect(page.locator(".App-toolbar__extra-tools-trigger")).toBeVisible();
    await assertEditable();
  } finally {
    await deleteDrawing(request, drawing.id);
  }
});
