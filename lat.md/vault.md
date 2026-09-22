# Vault Directory

A project names its vault directory in `lat.config.json` at the project root, so a project can keep its knowledge graph in `docs/` instead of the historical `lat.md/`.

## Config file

The file lives at the **project root**, never inside the vault: discovery must know where the vault is before it can read anything the vault contains.

Machine-local vault settings stay in `<vault>/config.local.yaml`, which is a different concern — that file is gitignored, while the vault name is a shared team decision.

```json
{
  "dir": "docs"
}
```

[[packages/core/src/project-config.ts#readLatProjectConfig]] reads and validates the file. It never walks, never writes, and keeps no on-disk cache, so a command leaves the project's directory listing untouched.

`dir` is deliberately **one path segment**. A nested path would break [[src/view/source-target.ts#rewriteLocalFileLink]], which builds synthetic URLs whose depth has to match the real project-relative path, and it would give the vault an index file named after the wrong directory. Absolute paths, dot-prefixed names, and traversal segments are rejected for the same reason.

`exclude` lists vault-relative paths that stay out of the graph entirely. Naming a directory prunes its whole subtree; [[packages/core/src/walk.ts#walkEntries]] applies the list before descending, so excluded files are absent from validation, indexing, and the browser alike. Entries are relative to the vault, not the project root, and an absolute path or a `..` segment is rejected.

It is the explicit counterpart to a vault `.gitignore` rule — the two compose, but only `exclude` states the intent directly: it applies whether or not the project is a Git checkout, and whether or not the paths it names are committed. Dropping a directory still leaves any index entry pointing at it stale, which [[cli#check#index]] reports like any other missing target.

## Discovery

[[packages/core/src/project-discovery.ts#findLatticeDir]] resolves the vault name at each directory level while walking up from the working directory, so a command started in a nested package still works.

Precedence is the `LAT_DIR` environment variable, then that level's config file, then the `lat.md` default.

A level that has a config file is authoritative: it does not also fall back to `lat.md`, so a half-finished migration cannot silently select the old vault. `LAT_DIR` is an ad-hoc override for CI and one-off runs — `lat init` never persists it.

`latticeDirName` never throws, so an agent hook survives a typo in the config and keeps its turn moving. Every command that resolves a project — `lat check`, `lat search`, `lat mcp` — checks [[packages/core/src/project-discovery.ts#projectConfigError]] and fails loudly instead, because silently falling back to the default name would otherwise pick up a leftover vault.

## Derived prefixes

A vault directory name is not just a path — it is the prefix of every section id, because ids are `relative(projectRoot, filePath)`. Three helpers derive everything downstream from the vault path so no call site re-derives it:

- [[packages/core/src/project-discovery.ts#latticeDirRel]] — the project-relative vault path, the same `relative()` derivation section ids use.
- [[packages/core/src/project-discovery.ts#latticePathPrefix]] — the same with a trailing slash; the literal replacement for a hardcoded `lat.md/`.
- [[packages/core/src/project-discovery.ts#latticeIndexFileName]] — the directory's index file name, shared by index validation, external-source configuration, `lat paths`, and the browser's diagnostics.

Renaming the vault therefore rewrites no ids in code. It does invalidate every authored link, `@lat:` comment, and search index entry, so the rename is a data migration: reindex afterwards.

## Init

[[cli#init]] accepts `--vault <name>`; without a flag it reuses the configured name, so a re-run stays on the same vault.

The scaffold's index file ships as `lat.md` and is renamed to match the vault, since an index file must share its directory's name. An existing vault that lacks that index is reported rather than modified — including the leftover `lat.md` index of a renamed vault, for which init prints the exact `git mv`.

The default name writes no config file at all, so a project that keeps `lat.md/` stays byte-identical to what earlier versions produced. Generated agent instructions carry the real directory name: [[src/cli/gen.ts#substituteLatticeDir]] fills the `__LAT_DIR__` placeholder from the project, because an unsubstituted template would teach agents to emit section ids under the wrong prefix.
