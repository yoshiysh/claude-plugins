PYTHON ?= python3
NODE ?= node
NPM ?= npm
FIND ?= find
SKILLS_DIR := .agents/skills
VALIDATOR := $(SKILLS_DIR)/skill-creator-best-practices/scripts/quick_validate.py
PORTABILITY := $(SKILLS_DIR)/manage-marketplace-plugin/scripts/check_portability.py
REFERENCES := $(SKILLS_DIR)/manage-marketplace-plugin/scripts/check_references.py
TRACEABILITY := scripts/traceability/cli.mjs
TRACEABILITY_CONFIG := traceability.config.json
VERIFICATION_OUTPUT ?= .artifacts/verification
RUNTIME_DIR := $(SKILLS_DIR)/dynamic-workflow-runner/scripts/runtime
RUNTIME_STAMP := $(RUNTIME_DIR)/node_modules/.package-lock.stamp

# スキル一覧・tests ディレクトリはどちらも毎回導出する。ハードコードすると、スキルの
# 追加・リネームのたびに検証対象から静かに漏れる（実例: worktree-sync → cleanup-branches の
# リネーム時、unittest の 2 行だけがハードコードのまま残り make test が壊れた）。
SKILLS := $(notdir $(patsubst %/,%,$(wildcard $(SKILLS_DIR)/*/)))
# plugins/*/tests の深さに限るのは、plugins/*/skills/*/tests を SKILLS_DIR 経由と二重に走らせないため。
# unittest は test_*.py を持つ dir だけに絞る（0 件の discover は Python 3.12 以降 exit 5 で失敗する）。
PLUGINS_DIR := plugins
PLUGIN_TEST_ROOTS := $(wildcard $(PLUGINS_DIR)/*/tests)
PLUGIN_TEST_DIRS := $(patsubst %/,%,$(sort $(dir $(wildcard $(PLUGINS_DIR)/*/tests/test_*.py))))
TEST_DIRS := $(wildcard $(SKILLS_DIR)/*/tests) $(PLUGIN_TEST_DIRS)
SKILL_NODE_TEST_FILES := $(shell $(FIND) -L $(SKILLS_DIR) -name node_modules -prune -o -type f -path '*/scripts/*.test.mjs' -print 2>/dev/null)
PLUGIN_NODE_TEST_FILES := $(if $(PLUGIN_TEST_ROOTS),$(shell $(FIND) $(PLUGIN_TEST_ROOTS) -name node_modules -prune -o -type f -name '*.test.mjs' -print 2>/dev/null))
REPO_NODE_TEST_FILES := $(shell $(FIND) tests -type f -name '*.test.mjs' -print 2>/dev/null)
NODE_TEST_FILES := $(SKILL_NODE_TEST_FILES) $(PLUGIN_NODE_TEST_FILES) $(REPO_NODE_TEST_FILES)
EVAL_RUNNERS := $(shell $(FIND) -L $(SKILLS_DIR) -type f -path '*/evals/run-fixtures.mjs' -print 2>/dev/null)

.PHONY: test test-static-and-python test-node-traceability test-node-other test-rust portability references check runtime-deps core-bin traceability traceability-complete

# plugin が同梱する Rust の crate（plugins/<plugin>/crates/<name>）。一覧は毎回導出する。
PLUGIN_CRATES := $(patsubst %/Cargo.toml,%,$(wildcard $(PLUGINS_DIR)/*/crates/*/Cargo.toml))
CARGO ?= cargo

# Pinned runtime dependencies are installed before discovery executes Node tests.
$(RUNTIME_STAMP): $(RUNTIME_DIR)/package-lock.json
	@cd $(RUNTIME_DIR) && $(NPM) ci --ignore-scripts --no-audit --no-fund
	@mkdir -p $(dir $@) && touch $@

runtime-deps: $(RUNTIME_STAMP)

# formal-method の CLI が呼ぶ実行体 formal-method-core（#264）。start が版を検査するので、CLI を起動しうるターゲットは前提に持つ。
# stamp は crate の src・Cargo.toml・Cargo.lock と、実行体が include_str! で読む core.schema.json に依る。
CORE_CRATE := plugins/verification/crates/formal-method-core
CORE_SCHEMA_JSON := plugins/verification/skills/formal-method/references/core.schema.json
CORE_STAMP := $(CORE_CRATE)/target/release/.core-bin.stamp
CORE_ENV := FORMAL_METHOD_CORE_BIN=$(abspath plugins/verification/crates/formal-method-core/target/release/formal-method-core)
$(CORE_STAMP): $(CORE_CRATE)/Cargo.toml $(CORE_CRATE)/Cargo.lock $(CORE_CRATE)/src/ $(wildcard $(CORE_CRATE)/src/*.rs) $(CORE_SCHEMA_JSON)
	@$(CARGO) build --release --locked --manifest-path $(CORE_CRATE)/Cargo.toml --target-dir $(CORE_CRATE)/target
	@mkdir -p $(dir $@) && touch $@

core-bin: $(CORE_STAMP)

test-static-and-python: runtime-deps references core-bin
	@set -e; for s in $(SKILLS); do \
		echo "── $$s"; \
		$(PYTHON) $(VALIDATOR) $(SKILLS_DIR)/$$s --verbose; \
	done
	@echo "── unittest"
	@$(TEST_ENV) $(PYTHON) scripts/parallel_unittest.py $(TEST_DIRS)
	@set -e; for e in $(EVAL_RUNNERS); do \
		echo "── eval preflight $$e"; \
		$(NODE) $$e; \
	done

# Node の段（とそこから起動される子の node）が、読み込んだモジュールのコンパイル結果を使い回す。
# 置き場は Node の文書の勧めに従い一時ディレクトリの下にする（テストの fixture は乱数の path にでき、cache が溜まり続けるため）。
# target-specific の export にしないのは、前提ターゲット（runtime-deps の npm ci）にまで効くため。
# traceability の段はカバレッジを測る子で無効にする（scripts/traceability/runner.mjs）。
# CLAUDE_PLUGINS_SKIP_FSYNC=1 は、テストの段の中だけ本番コードの fsync を省く（既定は fsync する。macOS の fsync は
# F_FULLFSYNC でマシン全体で 1 本ずつ進み、並列のテストの待ちの大半を占める。スイッチ自体は tests/fsync-switch.test.mjs で確かめる）。
NODE_COMPILE_CACHE_DIR ?= $(or $(TMPDIR),/tmp)/claude-plugins-node-compile-cache
TEST_ENV := CLAUDE_PLUGINS_SKIP_FSYNC=1 $(CORE_ENV)
NODE_FOR_TESTS := $(TEST_ENV) NODE_COMPILE_CACHE='$(NODE_COMPILE_CACHE_DIR)' $(NODE)

test-node-traceability: runtime-deps core-bin
	@echo "── Node tests (traceability)"
	@$(NODE_FOR_TESTS) $(TRACEABILITY) --config $(TRACEABILITY_CONFIG) --output $(VERIFICATION_OUTPUT)

test-rust:
	@set -e; for c in $(PLUGIN_CRATES); do \
		echo "── Rust $$c"; \
		$(CARGO) fmt --manifest-path $$c/Cargo.toml --check; \
		$(CARGO) clippy --manifest-path $$c/Cargo.toml --all-targets --locked -q -- -D warnings; \
		$(CARGO) test --manifest-path $$c/Cargo.toml --locked -q; \
	done

test-node-other: runtime-deps core-bin
	@if [ -n "$(NODE_TEST_FILES)" ]; then \
		echo "── Node tests (other)"; \
		$(NODE_FOR_TESTS) scripts/run_node_tests.mjs --config $(TRACEABILITY_CONFIG) -- $(NODE_TEST_FILES); \
	fi

# 合否ゲート。3 つを同時に走らせて全ての終了を待ち、1 つでも失敗したら失敗する。
# runtime-deps と core-bin を先に満たすのは、サブ make が同じ node_modules へ npm ci を、同じ target/ へ cargo build を並列に流さないため。
# レシピに $(MAKE) を字句どおり書くのは、make -n test でもこの行を実行してサブ make に -n を渡すため。
TEST_TARGETS := test-static-and-python test-node-traceability test-node-other test-rust
test: runtime-deps core-bin
	@$(SHELL) scripts/run_make_targets.sh '$(MAKE)' $(TEST_TARGETS)

traceability: runtime-deps core-bin
	@$(CORE_ENV) $(NODE) $(TRACEABILITY) --config $(TRACEABILITY_CONFIG) --output $(VERIFICATION_OUTPUT)

traceability-complete: runtime-deps core-bin
	@$(CORE_ENV) $(NODE) $(TRACEABILITY) --config $(TRACEABILITY_CONFIG) --output $(VERIFICATION_OUTPUT) --complete

# 参照先の実在チェック。こちらは portability と違い合否ゲートにする。
# 「install 先で壊れる書き方か」を分類する check_portability.py と違い、
# 「参照先が今このリポジトリに存在するか」だけを厳密に見るので誤検知が出ない
# （全スキルで 0 件になることを確認済み）。壊れた参照は書き方が正しくても壊れている。
references:
	@echo "── 参照先の実在チェック"
	@$(PYTHON) $(REFERENCES) --quiet && echo "   全スキル ok"

# 配布 portability の一覧。check_portability.py は blocker があっても exit 0 を返すため
# 合否ゲートにはせず、一覧を出して人が読む形にする（既知の false positive が
# 2 件あり、ゲートにすると恒常的に失敗する。詳細は skills-audit.md §4.1b）。
portability:
	@for s in $(SKILLS); do \
		$(PYTHON) $(PORTABILITY) --skill $$s 2>/dev/null | $(PYTHON) -c \
		"import json,sys; d=json.load(sys.stdin); print(('BLOCKER ' if d['has_blockers'] else 'ok      ') + d['skill'] + ('  ' + json.dumps(d['summary'], ensure_ascii=False) if d['summary'] else ''))"; \
	done

# 公開前にまとめて見たいときの入口。
check: test portability
