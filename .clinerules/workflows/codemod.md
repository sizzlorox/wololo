<!-- Use for migrations, renames and any change touching many files. Write a deterministic codemod instead of editing files by hand. -->
# codemod

Agents rewriting N files drift: each edit is slightly different. A codemod is reviewable, repeatable and exact.

1. `wololo codemod new <name>` scaffolds `.wololo/codemods/<name>.mjs` with `files` globs and a `transform(source)` function. Use an AST tool (ts-morph, jscodeshift, ast-grep, libcst) when regex is not exact.
2. `wololo codemod run <name>` is a dry run: read the diff summary, spot-check files.
3. `wololo codemod run <name> --write` applies it and runs verify.
4. Commit the codemod with the change so the migration is auditable and re-runnable on late branches.

Hand-edit only the handful of cases the codemod reports it could not handle.
