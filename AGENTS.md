# AGENTS.md

This file provides guidance to Codex when working in this repository.

**作業を始める前に `CLAUDE.md` を読むこと。** 構成・作業ルール・検証・注意点の正本は `CLAUDE.md` で、この文書には Codex で異なる点だけを書く。

## Codex で異なる点

- `.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）が編集のたびに `make test` を実行する。

## インストール

```bash
codex plugin marketplace add yoshiysh/claude-plugins
codex plugin add <plugin-name>@yoshiysh-claude-plugins
```

Codex は `.claude-plugin/plugin.json` の `dependencies` を見ないため、依存 plugin は自動で入らない。依存は推移的に辿って全部 install する（例: `notion` は `research` に依存し、`research` は `workflow` に依存するので、`notion` には `research` と `workflow` の両方が要る）。plugin ごとの依存は次で確認する。

```bash
jq -r '.dependencies[]?' plugins/<plugin-name>/.claude-plugin/plugin.json
```
