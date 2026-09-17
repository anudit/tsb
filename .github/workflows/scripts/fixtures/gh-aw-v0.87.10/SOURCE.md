# Pinned memory transport fixtures

These are unmodified functions from
[`github/gh-aw-actions` at `bc8c008a419c5b7a29df6f5641edd35fd1c6ea85`](https://github.com/github/gh-aw-actions/tree/bc8c008a419c5b7a29df6f5641edd35fd1c6ea85/setup/js),
the runtime pinned by the generated v0.87.10 workflows:

- `glob_pattern_helpers.cjs`: Git blob `7f8f41db39abc0d1fdecc5a04fda79123fd7f9e1`.
- `validate_memory_files.cjs`: Git blob `2fe8bf15b7611c029ce5631e27b69f9a70a96dd0`.

`push_repo_memory.cjs` (blob `b1297b11f3860fc6275c3ffd269ea2f7877b3f9b`, lines
323–328) invokes the matcher with `matchSubfolderRoot: !pattern.includes("/")`.
Consequently, slashless filters exclude root files, while slash-containing
filters require a slash. No supported file-glob can select root Markdown in
this version. We use the explicit `.md` extension allowlist and no glob instead.

The regression test executes both real helpers, preserves their Git blob
checksums, and exercises root/nested Markdown acceptance and non-Markdown
rejection. It stubs only the validator's error-message helper and log sink;
it never pushes commits or calls GitHub. Review this fixture when upgrading
the workflow runtime. See `LICENSE` for the upstream MIT license.
