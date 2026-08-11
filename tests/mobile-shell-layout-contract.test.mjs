import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../app/globals.css", import.meta.url);

test("keeps the fixed mobile mode switch clear of gallery actions and safe areas", async () => {
  const css = await readFile(cssUrl, "utf8");
  const mobile = css.match(
    /@media\s*\(max-width:\s*(?:900|1120)px\)\s*\{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(mobile, "the mobile shell media query must exist");
  assert.match(
    mobile,
    /\.workspace\s*\{[^}]*padding-bottom:\s*calc\([^;]*env\(safe-area-inset-bottom(?:,\s*0px)?\)[^;]*\)/,
    "mobile workspace needs enough safe-area-aware clearance below the final gallery card",
  );
  assert.match(
    mobile,
    /\.mode-switch\s*\{[^}]*bottom:\s*max\([^;]*env\(safe-area-inset-bottom(?:,\s*0px)?\)[^;]*\)/,
    "the fixed mode switch must sit above the device bottom safe area",
  );
});

test("keeps all four mode labels inside narrow mobile buttons", async () => {
  const css = await readFile(cssUrl, "utf8");
  const buttonRule = css.match(/\.mode-switch button\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(buttonRule, /min-width:\s*0/);
  assert.match(buttonRule, /overflow:\s*hidden/);
  assert.match(buttonRule, /text-overflow:\s*ellipsis/);
  assert.match(buttonRule, /white-space:\s*nowrap/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*400px\)[\s\S]*?\.mode-switch button\s*>\s*svg\s*\{[^}]*display:\s*none/,
    "very narrow screens should reserve the button width for readable labels",
  );
});
