# Lint Pragmas

TcView supports two pragma families for lint suppression:

- `tcview` pragmas for TcView-specific diagnostic control
- selected Beckhoff TwinCAT pragmas where there is a clear overlap with TcView lint behavior

TcView only recognizes its own custom pragmas when they explicitly use `tcview`.

## TcView Pragmas

### Block Suppression

```iecst
{tcview lint-disable unused-instance}
fbMyTest : FB_MyTcUnitTest;
{tcview lint-enable unused-instance}
```

### Inline Suppression

```iecst
fbMyTest : FB_MyTcUnitTest; // tcview lint-ignore unused-instance
```

### Supported TcView Rule Names

- `unused-instance`
- `undefined-variable`
- `duplicate-declaration`
- `type-mismatch`
- `unknown-type`

Aliases:

- `unused-variable` -> `unused-instance`
- `undefined-symbol` -> `undefined-variable`
- `unresolved-type` -> `unknown-type`
- `all` or `*` -> all TcView lint rules currently handled by the pragma layer

### Notes

- `lint-disable` / `lint-enable` affect subsequent lines until re-enabled
- `lint-ignore` affects only the declaration or code line carrying the inline comment
- TcView syntax and parser errors such as missing semicolons are intentionally not suppressible through these pragmas

## Beckhoff Pragmas Honored By TcView

TcView now honors a small conservative subset of Beckhoff pragmas where the meaning overlaps with TcView linting.

### Supported Beckhoff Forms

```iecst
{analysis -33}
{analysis +33}
```

```iecst
{attribute 'analysis' := '-33'}
```

```iecst
{attribute 'no-analysis'}
```

### Current Beckhoff Rule Mapping

- `SA0033` / `33` -> `unused-instance`
- `SA0035` / `35` -> `unused-instance`
- `SA0036` / `36` -> `unused-instance`

TcView uses these mappings only where they are a reasonable match for current TcView diagnostics. It does not try to emulate the full TE1200 static analysis engine.

### Current Behavior

- `{analysis -33}` disables the matching TcView lint rule until `{analysis +33}` restores it
- `{attribute 'analysis' := '-33'}` suppresses the next relevant declaration line, or the rest of the object when placed on the object header path
- `{attribute 'no-analysis'}` suppresses TcView lint diagnostics for the remaining object/file content

## Beckhoff Pragmas Parsed But Not Yet Mapped To TcView Rules

These are recognized and treated as pragma lines, but they do not currently suppress any additional TcView lint rule by themselves:

- `{warning disable <compiler ID>}`
- `{warning restore <compiler ID>}`
- `{attribute 'suppress_wrn_C0410'}`

That means they remain parse-safe in TcView, but only gain suppression behavior when there is an explicit TcView rule mapping for the corresponding warning family.
