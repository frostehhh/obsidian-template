// Helpers for the "Notes - <folder>.base" file created by qa-createOrOpenBaseForFolder.
//
// The base must not use `this.file`: in a sidebar, a split pane or an unfocused tab, `this` is the
// currently focused file, so the base would list another folder's notes. Instead the folder note's
// path is written into one reserved formula, FORMULA_NAME. Only that formula is ever rewritten;
// every other filter, formula and view in the base belongs to the user.

const FORMULA_NAME = "qaFolderChild";

function escapeFormulaString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFormulaValue(parentKey, folderNotePath) {
  const key = escapeFormulaString(parentKey);
  const path = escapeFormulaString(folderNotePath);
  return `if(note["${key}"], !list(note["${key}"]).filter(value.asFile() && value.asFile().path == "${path}").isEmpty(), false)`;
}

// YAML single-quoted scalar: only ' needs escaping (as '').
function yamlSingleQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildFormulaLine(parentKey, folderNotePath, indent = "  ") {
  return `${indent}${FORMULA_NAME}: ${yamlSingleQuote(buildFormulaValue(parentKey, folderNotePath))}`;
}

function buildBaseContent(parentKey, folderNotePath) {
  return `formulas:
${buildFormulaLine(parentKey, folderNotePath)}
filters:
  and:
    - formula.${FORMULA_NAME}
views:
  - type: table
    name: Table
    order:
      - file.name
      - file.tags
`;
}

// The exact filter line written by earlier versions (uses this.file.folder).
const LEGACY_FILTER_RE = new RegExp(
  "^([ \\t]*)-[ \\t]+'?" +
    escapeRegExp(
      'if(note["KEY"], !list(note["KEY"]).filter(value.asFile().folder == this.file.folder && ("/" + this.file.folder).endsWith("/" + value.asFile().basename)).isEmpty(), false)'
    ).replace(/KEY/g, '[^"]+') +
    "'?[ \\t]*$",
  "m"
);

const FORMULA_LINE_RE = new RegExp(`^([ \\t]+)${FORMULA_NAME}:[ \\t]*(.*)$`, "m");

// Brings an existing base in line with the folder note's current path.
// Returns "unchanged" | "updated" | "migrated" | "skipped" (the reason is in `message`).
// Never re-serializes the YAML, so user edits elsewhere in the file are preserved.
async function syncFolderChildFormula(app, baseFile, parentKey, folderNotePath, parseYaml) {
  const expected = buildFormulaValue(parentKey, folderNotePath);
  let result = { status: "unchanged" };

  await app.vault.process(baseFile, (content) => {
    let parsed = null;
    try {
      parsed = parseYaml(content);
    } catch (e) {
      result = { status: "skipped", message: "Base has invalid YAML; folder filter not updated." };
      return content;
    }

    const current = parsed?.formulas?.[FORMULA_NAME];
    if (typeof current === "string") {
      if (current === expected) return content;

      const match = content.match(FORMULA_LINE_RE);
      if (!match || !match[2].trim() || /^[|>]/.test(match[2].trim())) {
        result = {
          status: "skipped",
          message: `${FORMULA_NAME} is not on a single line; folder filter not updated.`,
        };
        return content;
      }
      result = { status: "updated" };
      return content.replace(FORMULA_LINE_RE, () => buildFormulaLine(parentKey, folderNotePath, match[1]));
    }

    // No reserved formula: migrate the old this.file.folder filter, if it is still there.
    if (parsed?.formulas && typeof parsed.formulas !== "object") return content;
    const legacy = content.match(LEGACY_FILTER_RE);
    if (!legacy) return content;

    let next = content.replace(LEGACY_FILTER_RE, (_, indent) => `${indent}- formula.${FORMULA_NAME}`);
    const formulasHeader = next.match(/^formulas:[ \t]*$/m);
    if (formulasHeader) {
      next = next.replace(/^formulas:[ \t]*$/m, () => `formulas:\n${buildFormulaLine(parentKey, folderNotePath)}`);
    } else if (/^formulas:/m.test(next)) {
      result = { status: "skipped", message: "Base uses an inline formulas block; folder filter not migrated." };
      return content;
    } else {
      next = `formulas:\n${buildFormulaLine(parentKey, folderNotePath)}\n${next}`;
    }
    result = { status: "migrated" };
    return next;
  });

  return result;
}

module.exports = {
  FORMULA_NAME,
  buildFormulaValue,
  buildBaseContent,
  syncFolderChildFormula,
};
