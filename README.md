<p align="center">
  <b>Specseal</b>
</p>

<p align="center">
  <b>Every AI-built change, sealed against its spec</b>
</p>

<p align="center">
  <a href="https://github.com/MomoChenisMe/speclink/actions/workflows/ci.yml"><img src="https://github.com/MomoChenisMe/speclink/actions/workflows/ci.yml/badge.svg" alt="CI (upstream engine)" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <b>English</b>
</p>

> **About the name.** Specseal is a fork of [Speclink](https://github.com/MomoChenisMe/speclink) (MIT), rebuilt around one idea: an AI-built change is not done until it carries **recorded, checkable evidence** that it matches its spec. In this release the engine's command name is still `speclink` — the binary/package rename ships together with our own release channels, not before. See [REBRAND-NOTES.md](REBRAND-NOTES.md) for the migration plan.

Specseal is a Spec-Driven Development (SDD) engine written in Rust. Each change starts with a small spec that says what the change must do. An AI agent builds it. Before archive, two quality stations — **review** and **verify** — check the work, and `verify` produces a stamped ticket holding the scope, the rounds, and the findings. Specs are plain Markdown and YAML in your repo.

Specseal has two deployment paths. One person needs only Local Repo. A team that wants shared specs connects a Remote Store.

- **Local Repo**: Specs live in the `speclink/` folder of your repo. Git handles collaboration. No server is necessary.
- **Remote Store**: Specs live in a shared Store. A Host handles authentication, revisions, transactions, events, and workflow decisions. The Host and Protocol are public contracts, so you can use the official server or write your own. At this team layer, PMs and POs take part in discussions and proposals, and they share one set of terms with engineers and AI agents: change, artifact, task, verify, and archive.

## <a id="why"></a>Why Specseal

- **Sealed, not just checked.** `verify scope → add-round → show --json → stamp` is a machine-readable evidence chain: the frozen scope, every verification round, and a stamp that refuses to land while a must-fix finding is open. Wire the same chain into CI, and an unstamped change cannot merge. See the [workflow template](integrations/ci/specseal-verify.yml).
- **The specs live next to your code.** They are plain Markdown and YAML files in your repo. You can read them without Specseal, and every edit shows in the Git diff.
- **Your AI agent knows each step.** Specseal writes skills for Claude Code, Codex, GitHub Copilot, pi, and Cursor. For any other agent, hand it the [universal instruction file](integrations/universal/SPECSEAL-AGENT-INSTRUCTIONS.md) instead — no per-tool work needed.
- **One set of principles behind every station.** [Principles](docs/principles.md) are the repo-level constitution: the rules that specs, review rounds, and verify rounds are checked against.
- **One workflow from one person to a team.** Start in one repo with Git. When the team grows, connect a shared server. The workflow and the terms stay the same.

## <a id="demo"></a>See it in action

```text
You: /speclink-propose add-dark-mode
AI:  Created speclink/changes/add-dark-mode/
     ✓ proposal.md — why we're doing this
     ✓ specs/      — requirements with concrete scenarios
     ✓ tasks.md    — implementation checklist

You: /speclink-apply add-dark-mode
AI:  ✓ 1.1 Theme context provider
     ✓ 1.2 Toggle component
     ✓ 2.1 CSS variables + persistence
     All tasks done.

You: speclink verify scope add-dark-mode --json
     scope frozen: 4 files, 2 spec deltas

You: /speclink-verify add-dark-mode
AI:  Round 1: 1 must-fix (toggle state not persisted on reload)
     Fixed. Round 2 clean.

You: speclink verify stamp add-dark-mode
     ✓ Stamped verification for change 'add-dark-mode'
```

The stamp is the product: a change without a stamp is visibly not done.

## <a id="compare"></a>How Specseal compares

| | Specseal | [spec-kit](https://github.com/github/spec-kit) | [OpenSpec](https://github.com/Fission-AI/OpenSpec) | [BMAD](https://github.com/bmad-code-org/BMAD-METHOD) |
|---|---|---|---|---|
| Spec-first workflow | ✅ | ✅ | ✅ | ✅ |
| Recorded verification evidence | ✅ stamped ticket + rounds | ⚠️ convergence report | ⚠️ verify profile | ❌ human review |
| CI gate on unstamped changes | ✅ workflow ships here | ❌ | ❌ | ❌ |
| Team Store with auth/transactions/events | ✅ public protocol + server | ❌ per-repo | ⚠️ git-store beta | ❌ |
| Desktop board for non-engineers | ✅ | ❌ | ⚠️ dashboard | ❌ |
| Project principles layer | ✅ documented convention | ✅ constitution | ❌ | ❌ |

Full, honest detail in [docs/comparison.md](docs/comparison.md). Specseal's wedge is the sealed evidence chain plus the team layer; everything else deliberately stays lean.

## <a id="quick-start"></a>Quick start

1. Install the CLI (stable Rust toolchain):

   ```bash
   cargo install --path crates/adapters/speclink-cli
   speclink --version
   ```

   Upstream channels (`npm i -g @speclink/cli`, `brew install MomoChenisMe/tap/speclink`, desktop installers) serve Speclink-branded builds of the same engine today; Specseal's own channels ship with the rename. See [Install](#install) and [REBRAND-NOTES.md](REBRAND-NOTES.md).

2. Initialize the repo where you want to use Specseal:

   ```bash
   speclink init --tools claude,codex
   ```

   `--tools` lists the agent tools that you use: `claude`, `codex`, `copilot`, `pi`, and `cursor`, in any comma-separated combination.

3. Ask your agent to start a change. In Claude Code, GitHub Copilot, or Cursor, enter `/speclink-propose <change-name>`. In Codex, enter `$speclink-propose <change-name>`. In pi, enter `/skill:speclink-propose <change-name>`. The agent writes the proposal, the specs, and the task list.

For the full first round (propose, apply, check, archive), see [Getting started](docs/getting-started.md). To connect to a shared server, see [Remote getting started](docs/remote-getting-started.md). To let an AI do the setup for you, paste the [setup prompt](docs/ai-setup-prompt.md) into your coding assistant.

## <a id="features"></a>Features

- **Plain text**: In Local mode, the files live under `speclink/` in your repo: `specs/<capability>/spec.md`, `changes/<name>/`, `changes/archive/`, and `config.yaml`. All content is Markdown and YAML. You can read and edit it without Specseal, and each change shows in the Git diff. Speclink adds only two items: `discussions/` (discussion records) and a `.meta.yaml` file in each change (lifecycle metadata). This applies to Local mode only. In remote mode, the specs live in the Store, and your machine has only a read-only projection. To import a project that uses OpenSpec, run `speclink init` in the project root. Specseal moves `openspec/` to `speclink/`, and after that the OpenSpec CLI cannot read the project. The import is one-way: you cannot convert the project back.
- **Skills for AI agents**: `speclink init` writes skill files for Claude Code, Codex, GitHub Copilot, pi, and Cursor. Each stage, from discussion to archive, has a `/speclink-*` command (`$speclink-*` in Codex, `/skill:speclink-*` in pi). Any other agent works from the [universal instruction file](integrations/universal/SPECSEAL-AGENT-INSTRUCTIONS.md).
- **Quality stations**: `review` checks code craft. `verify` checks that the delivery matches the specs and stamps the ticket. Both stations are optional.
- **Execution order**: `speclink plan` puts changes into waves from their declared dependencies and shows the next change that is ready to start.
- **Manual and trace**: Specseal generates a readable manual from the specs, and `trace` shows how a capability came to be.
- **Team sharing**: After you connect a server, the CLI, the desktop app, and AI agents read and write the same specs.
- **CI gate**: the [workflow template](integrations/ci/specseal-verify.yml) fails a PR whose changes are unstamped or whose spec files no longer validate.

## <a id="how-it-works"></a>How it works

```
baseline? → discuss?/improve? → propose → apply ⇄ ingest → (quality? | review? ∥ verify?) → archive
                                            ↑
                                    resume after a pause: drift first

worktree: apply-with-worktree ⇄ ingest → (quality? | review? ∥ verify?) → worktree-merge → archive

tools: validate / analyze / audit / commit / config / manual / trace / plan
```

A stage with `?` is optional. Your situation tells you where to start:

| Situation | Entry |
| --- | --- |
| The requirement is clear | `propose` |
| The requirement needs decisions | `discuss` (you bring the topic) or `improve` (the model finds topics) |
| The code has no specs yet | `baseline` |
| The requirement changes during the work | `ingest` |
| You resume a change after a pause | `drift` first |
| You want to move several independent changes at the same time | the worktree flow |

Before archive, two optional quality stations are available: `review` checks craft, and `verify` checks the specs. Choose the stations from the risk. For a low-risk change, you can skip both. For the purpose, skill, done criteria, and next step of each stage, see the [SDD workflow](docs/workflow.md).

## <a id="install"></a>Install

The desktop app and the CLI are two ways to use the same engine.

**From source (documented path for this fork):**

```bash
cargo install --path crates/adapters/speclink-cli
speclink --version
```

**Upstream channels (work today, Speclink-branded builds of the same engine):**

- With Node.js (any platform): `npm i -g @speclink/cli`
- macOS or Linux: `brew install MomoChenisMe/tap/speclink`, or the install script: `curl -fsSL https://raw.githubusercontent.com/MomoChenisMe/speclink/main/scripts/install.sh | sh`
- Desktop installers (macOS/Windows/Linux): upstream [Releases](https://github.com/MomoChenisMe/speclink/releases)

Windows has no install script. With Node.js, use npm. Without Node.js, install the desktop app; its installer also puts the CLI on your PATH.

### Claude Code plugin (optional)

`speclink-skills` adds a row of speclink skill buttons above the Claude Code input box, plus a side panel that lists changes, discussions, and open quality tickets:

```
/plugin install speclink-skills --marketplace MomoChenisMe/speclink
```

### Herdr mod (optional)

`speclink` adds a panel to Herdr, next to your terminals: the changes and discussions of the current project, the review and verify stamps, the suggested next skill. Setup and shortcuts: [speclink for Herdr](integrations/herdr).

## <a id="self-hosting"></a>Self-hosting a server

You need a server only when a team shares one set of specs. For one person in one repo, you do not need a server.

`speclink-server` is the official reference implementation. Pick one way to run it:

| Method | Command |
| --- | --- |
| npx (needs only Node.js) | `npx @speclink/server` |
| Docker | `docker run -d -p 8080:8080 -v speclink-data:/data ghcr.io/momochenisme/speclink-server:latest` |
| Docker Compose | `cd deploy && docker compose up -d` |

On the first start, the server prints a one-time `/setup` link. The default Store is SQLite, and the data goes to `./speclink-data` (`/data` in the container). Environment variables, PostgreSQL, upgrades, and rollbacks: [Server deployment](docs/server-deployment.md). Remote mode does not depend on this server: `host-runtime` and `client-protocol` in `speclink/specs/` are public contracts, so you can write your own server and connect the CLI and the desktop app to it. To load the engine in your own program, see the [Node SDK](docs/sdk-node.md).

## <a id="docs"></a>Documentation

**For one person, start with these**

| Document | Content |
| --- | --- |
| [Getting started](docs/getting-started.md) | From install to your first archive |
| [SDD workflow](docs/workflow.md) | The purpose, skill, done criteria, and next step of each stage |
| [Configuration](docs/configuration.md) | `.speclink.yaml`, `speclink/config.yaml`, and remote settings |
| [Principles](docs/principles.md) | The repo-level constitution, with a ready-to-copy template |
| [AI setup prompt](docs/ai-setup-prompt.md) | Let your AI install and initialize Specseal for you |
| [Comparison](docs/comparison.md) | Honest positioning against spec-kit, OpenSpec, BMAD, and task-master |

**For a team that shares one set of specs**

| Document | Content |
| --- | --- |
| [Remote getting started](docs/remote-getting-started.md) | From server start to a connected desktop app and CLI |
| [Server deployment](docs/server-deployment.md) | npx, Docker, Compose, upgrades, and rollbacks |
| [Server Store drivers](docs/server-store-drivers.md) | How to choose SQLite, Server FS, or PostgreSQL |
| [Server backup and restore](docs/server-backup.md) | `backup`, `verify-backup`, and `restore` |

**To connect Specseal to your own program**

| Document | Content |
| --- | --- |
| [Node SDK](docs/sdk-node.md) | Load `@speclink/engine`, the Store interface, and `dispatch` |
| [Verb and flag contract](docs/verb-contract.md) | Local and remote verbs, output shapes, and HTTP endpoints |

**Project status and direction**

| Document | Content |
| --- | --- |
| [Product status](docs/product-status.md) | What is available and what is partial, with evidence and limits |
| [Roadmap](docs/roadmap.md) | The work that comes next |
| [Changelog](CHANGELOG.md) | The changes in each version |

`speclink/` is your project's own spec workspace, created by `speclink init`. This repository starts clean: no upstream dogfood history (specs, changes, or discussions) is carried over.

## <a id="status"></a>Project status

- **Available**: Local Repo CLI, Local desktop app, agent skills (Claude, Codex, GitHub Copilot, pi, and Cursor), quality stations, execution order, manual and trace, Node SDK (`@speclink/engine`), three TeamStores (SQLite, Server FS, PostgreSQL), single-node server and admin console, Remote CLI, install channels, server operations (deployment, backup, and restore).
- **Partial**: Remote workspaces in the desktop app, the Claude Code plugin, the Herdr mod.
- **Planned upstream**: Agent tool packages and MCP, SSO, runtime plugins, multi-node deployment.

Specseal-specific priorities (in [REBRAND-NOTES.md](REBRAND-NOTES.md)): the staged rename, MCP server, the verify CI gate as a reusable GitHub Action, and a spec-kit migration command.

## <a id="contributing"></a>Contributing

Issues and pull requests are welcome, in English or Simplified Chinese.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the tests to run, the commit style, and how changes go through the engine itself.
- Do not report a security problem in a public issue. Follow [SECURITY.md](SECURITY.md) to report it privately.

To build the CLI from source (stable Rust toolchain):

```bash
cargo install --path crates/adapters/speclink-cli
speclink --version
```

## <a id="acknowledgments"></a>Acknowledgments

- **[Speclink](https://github.com/MomoChenisMe/speclink)** — this project is a direct fork. The engine, the workflow, the server, and the desktop app are its work; Specseal adds the evidence-first framing, the universal instruction path, the CI gate, and the principles layer. Thank you.
- **[OpenSpec](https://github.com/Fission-AI/OpenSpec)**: Local mode uses the OpenSpec folder layout for specs and changes.
- **Spectra App 2.3.1**: the Local CLI started with its CLI as the behavior reference.
- **[GitHub spec-kit](https://github.com/github/spec-kit)**: the project-principles ("constitution") idea.

## <a id="license"></a>License

MIT. This fork keeps the upstream copyright and license notice, as the MIT license requires.
