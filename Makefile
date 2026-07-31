PYTHON ?= python3
SKILLS_DIR := .agents/skills
VALIDATOR := $(SKILLS_DIR)/skill-creator-best-practices/scripts/quick_validate.py
PORTABILITY := $(SKILLS_DIR)/manage-marketplace-plugin/scripts/check_portability.py

# スキル一覧はディレクトリから毎回導出する。ここをハードコードすると、
# 新しいスキルを追加したときに検証対象から静かに漏れる。
SKILLS := $(notdir $(patsubst %/,%,$(wildcard $(SKILLS_DIR)/*/)))

.PHONY: test portability check

# 合否ゲート。1 つでも失敗したら止まる。
test:
	@set -e; for s in $(SKILLS); do \
		echo "── $$s"; \
		$(PYTHON) $(VALIDATOR) $(SKILLS_DIR)/$$s --verbose; \
	done
	$(PYTHON) -m unittest discover -s $(SKILLS_DIR)/worktree-sync/tests -p 'test_*.py'
	$(PYTHON) -m unittest discover -s $(SKILLS_DIR)/url-reader/tests -p 'test_*.py'

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
