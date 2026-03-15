.PHONY: build test lint format release clean node_modules

# ── VERSION resolution ─────────────────────────────────────
# Supports: make release VERSION=1.2.3 | VERSION=patch | VERSION=minor | VERSION=major
ifdef VERSION
  ifneq ($(filter v%,$(VERSION)),)
    $(error VERSION must not start with 'v' — the prefix is added automatically. Usage: make release VERSION=1.2.3)
  endif
  ifneq ($(filter patch minor major,$(VERSION)),)
    _LATEST_TAG := $(shell git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo v0.0.0)
    _LATEST_VER := $(patsubst v%,%,$(_LATEST_TAG))
    _VER_PARTS  := $(subst ., ,$(_LATEST_VER))
    _CUR_MAJOR  := $(or $(word 1,$(_VER_PARTS)),0)
    _CUR_MINOR  := $(or $(word 2,$(_VER_PARTS)),0)
    _CUR_PATCH  := $(or $(word 3,$(_VER_PARTS)),0)
    ifeq ($(VERSION),patch)
      override VERSION := $(_CUR_MAJOR).$(_CUR_MINOR).$(shell echo $$(($(_CUR_PATCH) + 1)))
    else ifeq ($(VERSION),minor)
      override VERSION := $(_CUR_MAJOR).$(shell echo $$(($(_CUR_MINOR) + 1))).0
    else ifeq ($(VERSION),major)
      override VERSION := $(shell echo $$(($(_CUR_MAJOR) + 1))).0.0
    endif
  endif
  ifeq ($(shell echo '$(VERSION)' | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+$$'),0)
    $(error Invalid VERSION '$(VERSION)'. Must be semver X.Y.Z (e.g. 1.2.3) or bump keyword (patch|minor|major))
  endif
endif
# ────────────────────────────────────────────────────────────

build: node_modules
	pnpm build

node_modules:
	pnpm i

test: node_modules
	pnpm test

lint:
	pnpm lint

format:
	pnpm format

# Release: bump version, commit, tag, push
# Usage: make release VERSION=0.2.0
release:
ifndef VERSION
	$(error VERSION is required. Usage: make release VERSION=1.2.3 (or patch|minor|major))
endif
	@echo "Releasing v$(VERSION)$(if $(_LATEST_VER), (was v$(_LATEST_VER)),)"
	@node -e "const p=require('./package.json'); p.version='$(VERSION)'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"
	git add package.json
	git commit -m "chore: release v$(VERSION)"
	git tag v$(VERSION)
	git push origin main v$(VERSION)

clean:
	rm -rf dist
