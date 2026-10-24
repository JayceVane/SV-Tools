# Security policy

## Release scope

The 4.0 release candidate is tested on Windows x64 in VS Code compatible desktop hosts. Preview versions remain development releases. Report issues against the exact extension version and host version; a clean audit does not guarantee the absence of vulnerabilities.

## Reporting

Send security reports privately to [JayceVane@163.com](mailto:JayceVane@163.com). Include the affected version, a minimal reproduction, expected impact and relevant logs. Remove secrets, license details and proprietary RTL before sharing attachments. Do not publish an exploitable reproduction before the maintainer has reviewed it. Response and fix timing depend on the issue; no response-time guarantee is made.

## Execution and files

- The formatter and generators run the packaged Rust native module. They do not require Python.
- Lint, simulation and Vivado commands execute local tools selected by the user. RTL, Tcl, compiler arguments and workspace configuration must be trusted before these tools run.
- The bundled Yosys frontend runs a local WASM process. The circuit and waveform views use workers with bounded input/query budgets and nonce-based webview policies.
- Temporary compilation inputs, generated scripts and diagnostic logs are written under task directories, normally `.svtools` in the relevant project. Generated templates are inserted into the editor; image and layout exports use a save dialog.
- The extension does not download toolchains or send telemetry. Configured external tools may implement their own licensing, network access and file operations.
- The extension has not opted into untrusted workspace support. VS Code disables it in Restricted Mode by default; trust a project only after reviewing its scripts and settings.

## Dependency and artifact checks

Run `npm audit` at the repository root and in `src/native` when preparing a release. Root npm dependencies are build/verification tools, while selected fixed ELK and Yosys resources are copied into the VSIX. Audit the packaged files as well as the dependency tree. npm results do not cover Rust crates, WASM internals or configured vendor tools.

Keep versioned packages immutable. Rebuild changed code under a new preview number; record the source commit, target and SHA256. A GitHub Release should never overwrite assets from an earlier build with the same version.
