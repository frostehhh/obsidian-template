# QuickAdd Format Variables

Format variables work in `fileNameFormat.format`, `captureTo`, `format` (Capture), and inside template files.

## Date variables

```
{{DATE}}                      Today in YYYY-MM-DD
{{DATE:YYYY-MM-DD HH:mm}}     Today with custom moment.js format
{{DATE+1d}}                   Today + 1 day
{{DATE-1w}}                   Today − 1 week
{{DATE+1d:YYYY-MM-DD}}        Offset with custom format
```

Offset units: `d` (days), `w` (weeks), `M` (months), `y` (years).

Date aliases configured in `data.json → dateAliases`:

| Alias | Meaning |
|-------|---------|
| `t` | today |
| `tm` | tomorrow |
| `yd` | yesterday |
| `nw` | next week |
| `nm` | next month |
| `ny` | next year |
| `lw` | last week |
| `lm` | last month |
| `ly` | last year |

Use aliases as: `{{DATE:alias}}` → `{{DATE:t}}`.

## Value variables

```
{{VALUE}}                     Prompts user for input (unnamed)
{{VALUE:varName}}             Named variable — set by a macro script via params.variables["varName"]
```

If `{{VALUE}}` appears in a `fileNameFormat`, QuickAdd shows an input prompt before creating the file.

## Context variables

```
{{NAME}}                      The new note's file name (without extension)
{{TITLE}}                     The active note's display title
{{CLIPBOARD}}                 Current clipboard contents
```

## Macro output

```
{{MACRO:macroName}}           Output returned by a Macro choice (the string a script returns)
```

## moment.js format tokens (common)

| Token | Output |
|-------|--------|
| `YYYY` | 2025 |
| `YY` | 25 |
| `MM` | 01–12 |
| `MMMM` | January |
| `MMM` | Jan |
| `DD` | 01–31 |
| `ddd` | Mon |
| `dddd` | Monday |
| `HH` | 00–23 |
| `mm` | 00–59 |
| `ss` | 00–59 |
| `x` | Unix ms timestamp |
