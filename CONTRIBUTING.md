# Contributing to SystemVerilog VSCode Extension

Thank you for your interest in contributing to this project!

## Getting Started

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates.
When creating a bug report, please include:

- **VSCode version**
- **Extension version**
- **Operating system**
- **Steps to reproduce** the issue
- **Expected behavior** vs **actual behavior**
- **Sample code** that demonstrates the issue

### Suggesting Enhancements

Enhancement suggestions are welcome! Please provide:

- A clear **description** of the enhancement
- **Use cases** for the enhancement
- **Examples** of how the enhancement would work

## Development Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the Rust native module (needed for formatter changes, requires `cargo`):
   ```bash
   npm run build:native
   ```
4. Run the golden formatter tests before opening a PR:
   ```bash
   npm test
   ```
5. Open the project in VSCode and press `F5` to launch Extension Development Host

Formatter behaviour is defined by `docs/FORMAT_SPEC.md`; when implementation and spec
disagree, fix the implementation. If the spec itself is wrong, change the spec together
with a golden case in `example/`, then the code.

## Code Style

### JavaScript
- Use 4 spaces for indentation
- Follow existing code style
- Add JSDoc comments for functions

### Rust
- Use 4 spaces for indentation and follow the surrounding style (the tree is not
  `cargo fmt`-normalised, so don't reformat files you aren't changing)
- Every formatting change needs a golden case: `example/<name>.sv` plus its expected
  output in `example/target/<name>.sv`
- Idempotency is a hard requirement — formatting the golden output again must be
  byte-identical (`npm test` asserts this)

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Message Format

Follow these guidelines for commit messages:

```
<type>: <subject>

<body>
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

Example:
```
feat: add support for enum alignment

- Add enum parsing to beautifier
- Update formatter options
- Add tests for enum formatting
```

## License

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0.

## Contact

- **Maintainer**: JayceVane <JayceVane@163.com>
- **Issues**: https://github.com/JayceVane/SV-Tools/issues

## Code of Conduct

Be respectful and constructive in all interactions. We strive to maintain a welcoming and inclusive community.
