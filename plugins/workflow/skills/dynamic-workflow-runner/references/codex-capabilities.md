# Codex Capability Adaptation

## 安定した契約にするもの

runner が依存するのは具体的な feature 名ではなく、現在のセッションで実際に呼べる意味能力である。

- 親が child task を直接管理できる `native_collaboration`
- agent を起動できる `spawn`
- stable handle を受け取れること
- handle の完了または更新を待てる `collect_or_wait`
- optional な message / resume / interrupt

具体的な tool 名は Codex の版や host によって変わり得るため、SKILL orchestrator が preflight 時に adapter を
決める。manifest、state、task prompt に tool 名を固定しない。

## `multi_agent_v2`

`multi_agent_v2` は利用可能な runtime では内部 backend を選ぶ feature になり得るが、portable workflow の
公開契約ではない。次を守る。

- true であっても callable `spawn` / `wait` がなければ unsupported。
- false または不明でも、host が必要な direct collaboration tools を公開していれば意味能力を優先する。
- state へ保存する場合は diagnostic metadata とし、resume identity の中心にしない。
- Responses API の multi-agent とローカル Codex subagent を同じ backend とみなさない。

## `collaboration_modes`

mode 選択が tool schema に公開されていない環境では、flag が存在しても task に指定できない。runner は
`plan`、`pair`、`delegate` などの mode 名を推測して埋め込まない。将来 host が mode selection を明示的に
公開した場合だけ optional adapter capability として利用する。

context isolation は mode 名ではなく、現在使える `fork_turns` 等の実引数と input manifest で表現する。
`fresh` は conversation context の非継承であり、filesystem visibility の遮断ではない。

## 実行 backend の優先順位

1. 現在の Codex host が公開する direct collaboration tools。
2. user が明示的に設定した別 adapter。
3. それ以外は `unsupported_runtime`。

skill が自動的に CLI recursion、shell background process、Responses API、別 provider、MCP serverへ切り替える
ことは禁止する。MCP / plugin 化は、host 外から安定した workflow tool を提供したい場合の別実装であり、この
skill の silent fallback ではない。

## 制約の表示

preflight は少なくとも次をユーザーに残す。

- capability status: supported / limited / unsupported
- resolved semantic operations
- effective concurrency
- unavailable optional operations
- context isolation の強制範囲
- filesystem / tool isolation が attested か enforced か
- external mutation が workflow 内で許可されるか
- source が trusted / untrusted のどちらか、secret-bearing か
- fresh fork が親model contextを継承するか、およびその隔離が enforced / attested_not_enforced のどちらか

`observed_at`、filesystem / tool / external-mutation enforcement、source trust、secret-bearing、fork behavior は
capability receipt の必須fieldである。hostile source またはsecret-bearing inputは、必要な隔離がすべて
`enforced` でなければ `unsupported_runtime` とする。診断flagや親の善意の指示で代替しない。
