PYTHON ?= python3
VALIDATOR := .agents/skills/skill-creator-best-practices/scripts/quick_validate.py

.PHONY: test

test:
	$(PYTHON) $(VALIDATOR) .agents/skills/manage-marketplace-plugin --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/notion-organize-knowledge --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/url-reader --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/pr-create --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/reference --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/commit --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/worktree-sync --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/skill-creator-best-practices --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/chat --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/chat-rigorous --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/dispatch --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/search --verbose
	$(PYTHON) -m unittest discover -s .agents/skills/worktree-sync/tests -p 'test_*.py'
