PYTHON ?= python3
SKILLS_DIR := .agents/skills
VALIDATOR := $(SKILLS_DIR)/skill-creator-best-practices/scripts/quick_validate.py
PORTABILITY := $(SKILLS_DIR)/manage-marketplace-plugin/scripts/check_portability.py
REFERENCES := $(SKILLS_DIR)/manage-marketplace-plugin/scripts/check_references.py

# スキル一覧・tests ディレクトリはどちらも毎回導出する。ハードコードすると、スキルの
# 追加・リネームのたびに検証対象から静かに漏れる（実例: worktree-sync → cleanup-branches の
# リネーム時、unittest の 2 行だけがハードコードのまま残り make test が壊れた）。
SKILLS := $(notdir $(patsubst %/,%,$(wildcard $(SKILLS_DIR)/*/)))
TEST_DIRS := $(wildcard $(SKILLS_DIR)/*/tests)

.PHONY: test portability references check

# 合否ゲート。1 つでも失敗したら止まる。
test: references
	@set -e; for s in $(SKILLS); do \
		echo "── $$s"; \
		$(PYTHON) $(VALIDATOR) $(SKILLS_DIR)/$$s --verbose; \
	done
	@set -e; for t in $(TEST_DIRS); do \
		echo "── unittest $$t"; \
		$(PYTHON) -m unittest discover -s $$t -p 'test_*.py'; \
	done

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
