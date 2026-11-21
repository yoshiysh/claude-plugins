# 形式検証の道具の版の正本。`make setup-formal` と CI（.github/workflows/verification.yml）がこの値を使う
# （CI の値との一致は tests/formal-tools-versions.test.mjs が照らす）。道具の実体は git 管理外の tools/formal/ に置き、
# .worktreeinclude で worktree へ写す。

TLA2TOOLS_VERSION := 1.7.4
TLA2TOOLS_URL := https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
TLA2TOOLS_SHA256 := 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

Z3_VERSION := 5.3.3
Z3_URL_BASE := https://github.com/Z3Prover/z3/releases/download/z3-5.3.3
# 資産の名前と sha256 は OS とアーキテクチャごと（GitHub の release の digest と同じ値）。
Z3_ASSET_DARWIN_ARM64 := z3-5.3.3-arm64-osx-13.3.zip
Z3_SHA256_DARWIN_ARM64 := 6957e6c75266d7ca8fa77030e86e83d78624567dcdf34cc11f4192fdc6f93c6b
Z3_ASSET_DARWIN_X64 := z3-5.3.3-x64-osx-13.3.zip
Z3_SHA256_DARWIN_X64 := ace69787d5a21762154b103abe68178188f38e02362fb0f82d346621af90f8e7
Z3_ASSET_LINUX_X64 := z3-5.3.3-x64-glibc-2.39.zip
Z3_SHA256_LINUX_X64 := d56f60b06f432f33de5810f7f1a384a339131f361e2d54d08ea83eea14326880
Z3_ASSET_LINUX_ARM64 := z3-5.3.3-arm64-glibc-2.38.zip
Z3_SHA256_LINUX_ARM64 := d4586e12af2609499e07d615ac578256125b19f396f0d6ca358fe7b22988bcec
