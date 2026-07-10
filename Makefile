PYTHON ?= python3
VALIDATOR := .agents/skills/skill-creator-multi-agent/scripts/quick_validate.py

.PHONY: test

test:
	$(PYTHON) $(VALIDATOR) .agents/skills/skill-creator-multi-agent --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/manage-marketplace-plugin --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/notion-organize-knowledge --verbose
	$(PYTHON) $(VALIDATOR) .agents/skills/url-reader --verbose
