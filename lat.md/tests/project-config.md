---
lat:
  require-code-mention: true
---

# Project Configuration

Tests verify the project-level config file that names the vault directory, and the discovery that honors it.

## Project config

Reading `lat.config.json` never mutates the project, and a rejected file degrades to the default name so the CLI can report the error itself.

### Reads and validates the vault directory

A config file's `dir` selects the vault, an absent file keeps the historical `lat.md` default, and an `exclude` list is parsed and preserved before anything consumes it.

### Rejects a directory name that would escape or hide the vault

Absolute paths, nested paths, and dot-prefixed names are rejected with a message naming the rule, because such a name would let discovery walk outside the project or into a directory the walker skips.

## Vault discovery

Discovery resolves the vault name at each directory level, so a configured vault is found from any nested working directory.

### Finds a configured vault from a subdirectory

Walking up from a nested directory returns the configured vault, while a project without a config file keeps resolving `lat.md`.

### Ignores an unusable LAT_DIR override

A multi-segment, absolute, or escaping `LAT_DIR` is refused rather than honored, because it would flatten section ids and hide everything outside that subtree; discovery falls back to the configured vault.

### Derives section prefixes from the vault path

Section-id prefixes, route prefixes, and the index file name all derive from the vault path, so a renamed vault needs no id rewriting and a vault named `lat.md` keeps its existing index name.

## Configured vault

A vault that is not named `lat.md` flows through validation, indexing, and code references unchanged.

### Validates and prefixes ids under the configured name

Link validation, code-reference scanning, and section ids all use the configured prefix, so `lat check` passes and `@lat:` comments address the real ids.

## Embedding endpoint selection

The embedding endpoint can come from the environment or the durable per-repo preference, and the environment wins so a CI job can redirect it.

### Prefers the environment over the repo preference

An environment-provided endpoint is used without reading repo config at all, and neither source set means no endpoint is selected.

## Excluded vault paths

The config's `exclude` list keeps paths out of the walk itself, so they are absent from the graph, validation, indexing, and the browser.

### Keeps excluded paths out of the vault walk

A named directory is pruned with its whole subtree and a named file is skipped, while everything else stays visible; the paths are relative to the vault, and a vault `.gitignore` rule composes with the list.

### Validates a vault whose excluded paths are incomplete

A vault passes validation without anything being demanded for the excluded paths, because the walker never sees them — and dropping a directory leaves its index entry stale, which the index validator still reports.

### Normalizes equivalent spellings of an excluded path

`private`, `private/`, and `./private` all resolve to the same canonical entry, because the directory walker and the publication policy match paths differently and would otherwise disagree about the same config file.

### Keeps excluded paths out of the published site

Static export applies the exclusion in both its Git and non-Git branches, so an excluded source is never shipped even though the Git branch enumerates a flat file list rather than walking directories.
