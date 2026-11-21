# coreforge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nostoryworld/coreforge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nostoryworld/coreforge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

coreforge is a GitHub-compatible git forge that runs as a single Node process, with no git binary involved and nothing beyond the Node standard library. It serves the git smart HTTP protocol (both v2 and v0), a GitHub REST API v3 surface, a GraphQL API v4 surface, and an MCP server so agents can work with repositories directly.

## Run

```
node --experimental-strip-types main.ts
```

Requires Node 22.18 or newer.

Built for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).
