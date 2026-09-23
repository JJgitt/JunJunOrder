<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project knowledge for agents

- Before changing business behavior, read [docs/wiki/README.md](docs/wiki/README.md) and follow its topic-specific links.
- Treat code, `db/schema.ts`, and applied `drizzle/*.sql` as the source of truth when a document is stale; update the Wiki with the change.
- Preserve unrelated working-tree changes. Never put credentials or production data in documentation.

## Delivery workflow

- At the start of every iteration that will change code, configuration, or documentation, run `git status --short --branch`, then `git pull --ff-only` for the current branch's upstream before editing. Verify the pull succeeds; do not rely on cached `origin/*` refs or CI checkout as a substitute.
- Preserve all existing work. Never automatically stash, reset, checkout, or overwrite changes to make the pull succeed. If the pull fails, branches diverge, or no upstream exists, stop editing and report the blocker. Read-only investigations do not require a pull.
- After completing a code change and its relevant local checks pass, commit the scoped changes, push them to `main`, and monitor the existing CI/CD workflow until the production deployment succeeds.
- Do not include unrelated or pre-existing working-tree changes in the commit.
- If the user explicitly asks for a local-only change, a review, or says not to deploy yet, do not commit or push.
- If CI/CD fails, keep the current production version running, diagnose the failure, and report or fix it within the requested scope.
