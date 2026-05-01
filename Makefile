MARKED_VERSION    := 13.0.3
HLJS_VERSION      := 11.11.1
HLJS_THEME        := atom-one-dark
HLJS_THEME_LOCAL  := one-dark
HLJS_LANGUAGES    := python javascript typescript bash json css xml markdown rust go ruby java c cpp

VENDOR_DIR        := public/vendor
HLJS_DIR          := $(VENDOR_DIR)/hljs
HLJS_LANG_DIR     := $(HLJS_DIR)/languages

MARKED_URL        := https://cdn.jsdelivr.net/npm/marked@$(MARKED_VERSION)/marked.min.js
HLJS_BASE         := https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@$(HLJS_VERSION)

CURL              := curl -fsSL

JS_SOURCES        := $(shell find . -name node_modules -prune -o \( -name '*.mjs' -o -name '*.js' \) -not -path './public/vendor/*' -print)

.PHONY: build lint test precommit start vendor vendor-clean

.DEFAULT_GOAL := build

build: node_modules

node_modules: package.json package-lock.json
	@npm install
	@touch node_modules

lint: node_modules
	@echo "==> lint"
	@for f in $(JS_SOURCES); do node --check $$f || exit 1; done

test: node_modules
	@echo "==> test"
	@npm test

precommit: lint test

start: node_modules
	@npm start


vendor: vendor-clean
	@mkdir -p $(HLJS_LANG_DIR)
	@echo "fetching marked $(MARKED_VERSION)"
	@$(CURL) $(MARKED_URL) -o $(VENDOR_DIR)/marked.min.js
	@echo "fetching highlight.js $(HLJS_VERSION)"
	@$(CURL) $(HLJS_BASE)/highlight.min.js -o $(HLJS_DIR)/highlight.min.js
	@$(CURL) $(HLJS_BASE)/styles/$(HLJS_THEME).min.css -o $(HLJS_DIR)/$(HLJS_THEME_LOCAL).min.css
	@for lang in $(HLJS_LANGUAGES); do \
		echo "fetching hljs language $$lang"; \
		$(CURL) $(HLJS_BASE)/languages/$$lang.min.js -o $(HLJS_LANG_DIR)/$$lang.min.js || exit 1; \
	done

vendor-clean:
	@rm -rf $(VENDOR_DIR)
