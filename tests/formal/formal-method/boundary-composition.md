# operational model の分割と合成

対象は `operational.smt2` の状態・イベントモデルであり、PRD 全体や実装全体の証明ではない。既存の 31 SCC 候補と 45 参照は構文上の来歴として保持する。状態変数を一つずつ部品と呼ぶと、状態更新の責務や環境からの入力が表れないため、次の意味上の分割を採用する。

| 境界 | 所有するもの | 採用理由 |
|---|---|---|
| control | phase, reported, answered, need, epoch, worked | 中断、報告、回答、再開の制御 |
| evidence | available, saved, value, reused, checked, matched | 結果の受領、保存、照合、再利用 |
| producer | message, produced | 環境入力からの生成 |
| consumer | consumed, consumedReady | 生成結果の受領 |
| coordinator | init, next, init の assertion | 初期化とイベント選択の同期 |
| environment | 入力、version、event、resultChoice、mutation flags、入力範囲 assertion | 部品自身が作れない外部条件 |

`boundary_composition.rs` が全ノードの所有者を検査し、全参照を `boundary-dependency-map.tsv` に写像する。未知のノードやイベント、重複・欠落した状態更新は失敗する。原モデルの init assertion は初期化証明に用い、それ以外の assertion は逐語で保持する。環境範囲を別の狭い範囲に置き換えない。通常ケースでは mutation flags を false に固定する。

## 証明の順序

1. 実際の next の各イベントから guard と所有者ごとの更新を抽出する。各フィールドに一つの所有者と一つの更新があることを検査する。guard と全更新の同期積が元の next と同値であることを Z3 で検査する。
2. 独立に記述した `boundary-contracts.smt2` の関係契約を、各部品の具体的な更新が満たすことを証明する。guard も coordinator から同じ方法で供給する。関係契約は post-state の更新内容と他のフィールドを保持する条件を含む。
3. init が共同の事前不変条件を確立することを証明する。各部品は、自分の具体的な更新、証明済み guard 契約、共同の事前不変条件だけを使って自分の事後不変条件を示す。control は evidence の関係契約、consumer は producer の関係契約も必要とする。相手の具体的な更新を読み込んだ仮定や、同じ時点で未証明の事後不変条件を使わない。二つの必要な import を外すと反例が得られる。
4. 許可する更新フィールドをイベントごとに列挙し、それ以外を保持する frame 条件を全イベントで証明する。全イベントについて不変条件を満たす事前状態からの有効な遷移が存在することも検査する。これは到達可能性の証明とは区別する。
5. 元の next や部品の実装を使わず、各部品の事後不変条件と元の環境 assertion だけから全体の安全性を導く。consumer の値が環境入力に等しく範囲内であること、再利用には保存・報告・version 一致が伴うこと、旧 epoch では遅い結果によって完了しないこと、再開した epoch には回答があることを結論とする。

共同の事前不変条件は仮定の循環ではなく、init と全遷移で帰納的に維持する帰納仮説である。相互に制御を参照する control と evidence を独立した事前条件だけに分解できるとは主張しない。証明の式は二状態の操作モデルであり、実行例の上限までの安全性を超えて、この抽象モデルの init から有限回遷移した状態へ帰納法を適用できる。ただし具体的なシステムがこのモデルを精緻化すること、無限実行の活性、並行実行、可変の外部環境、実ファイルの耐久性はここでは証明していない。

## 反例と成果物

全 mutation flag の意味ある破壊を検出する。保存は独立した event 3 の事後条件でも検査する。抽象合成から各所有者の保証または環境 anchor を一つ外すと、全体の安全性に反例が存在する。正常な抽象状態と全イベントの有効状態も存在し、矛盾した仮定だけによる合格を避ける。

`FORMAL_RUN_DIR` を指定すると、再実行可能な `boundary_*.smt2`、合成前の関係 `boundary-projections.smt2`、全参照の写像 `boundary-dependency-map.tsv`、イベントごとの更新と保持条件 `boundary-frames.tsv` を保存する。solver の起動・timeout・出力判定は既存の Rust 共通処理を使う。SAT の存在チェックは query を保存するが、ここでは具体的な get-value witness の保存・replay を追加していない。既存の operational witness 検査と実保存検査は別の結果として扱う。
