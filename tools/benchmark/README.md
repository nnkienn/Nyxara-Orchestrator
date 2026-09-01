# Nyxara local benchmark

The harness measures local orchestration behavior without changing production code. Fake providers are the default; real providers require explicit `--provider-mode real` and may incur usage/cost.

```sh
npm run benchmark:local -- --quick
npm run benchmark:local -- --full
node tools/benchmark/dist/cli.js run --scenario long-run-normal --quick
node tools/benchmark/dist/cli.js run --realistic --profile repair-heavy --scenario repair-heavy
node tools/benchmark/dist/cli.js extension --auto-detect --quick
node tools/benchmark/dist/cli.js compare before/report.json after/report.json
```

Reports are written to `benchmark-results/<benchmarkRunId>/` as JSON, CSV, Markdown, raw samples, and environment metadata. Use `--label`, `--output`, `--scenario`, `--profile light|normal|heavy|repair-heavy`, `--quick`, `--full`, `--realistic`, and `--provider-mode` to customize runs. Extension profiling uses best-effort auto-detection of an already-running VS Code Extension Host and skips when unavailable or ambiguous.
