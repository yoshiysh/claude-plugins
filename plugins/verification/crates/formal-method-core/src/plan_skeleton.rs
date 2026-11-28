//! `plan-skeleton`: 計画の検査と sanity の骨組み（SP-264-020）。
//! 検査の id・`target_id`・`model_id`・`expected`・`input_refs`・`depends_on` と sanity の列挙は、
//! モデルと採った分割から一意に決まる。時間の上限・前提・範囲は計画作成役の `targets` から写す。

use crate::error::InputError;
use crate::schema;
use crate::types::{
    self, CompositionCondition, PartitionContract, PlanCheck, PlanSanity, PlanSkeletonInput,
    PlanSkeletonOutput, PlanTarget, SkeletonModel, SkeletonPartitions, SkeletonProperty,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const KIND_PROPERTY: &str = "property";
const KIND_CONTRACT: &str = "contract";
const KIND_COMPOSITION: &str = "composition";
const EXPECTED: &str = "unsat";

/// 骨組みを作る間の索引。
struct Ctx<'a> {
    properties: BTreeMap<&'a str, &'a SkeletonProperty>,
    excluded: BTreeSet<&'a str>,
    targets: BTreeMap<&'a str, &'a PlanTarget>,
}

impl Ctx<'_> {
    /// 除く性質: `inventory_property_ids` の全てが除かれるモデルの性質（今の `checkGaps` と同じ）。
    fn is_excluded(&self, mp_id: &str) -> bool {
        let Some(p) = self.properties.get(mp_id) else {
            return false;
        };
        let ids = &p.inventory_property_ids;
        !ids.is_empty() && ids.iter().all(|pid| self.excluded.contains(pid.as_str()))
    }
}

pub fn run(input: Value) -> Result<Value, InputError> {
    let input: PlanSkeletonInput = types::parse(input)?;
    let empty = SkeletonPartitions {
        parts: Vec::new(),
        boundaries: Vec::new(),
        contracts: Vec::new(),
        composition_conditions: Vec::new(),
    };
    let partitions = input.partitions.as_ref().unwrap_or(&empty);
    check_partition_models(&input.models, partitions)?;
    let excluded = &input.excluded_property_ids;
    let ctx = Ctx {
        properties: index_properties(&input.models)?,
        excluded: excluded.iter().map(String::as_str).collect(),
        targets: index_targets(&input.targets),
    };
    let mut missing = BTreeSet::new();
    // 出す契約の検査を先に決める（depends_on には出した検査の id だけを入れる）
    let mut emitted = BTreeSet::new();
    for k in &partitions.contracts {
        if ctx.is_excluded(&k.derived_from) {
            continue;
        }
        if ctx.targets.contains_key(k.id.as_str()) {
            emitted.insert(k.id.as_str());
        }
    }
    let mut checks = Vec::new();
    let mut sanity = Vec::new();
    // モデルの順に、その中で property → contract → composition、各々宣言の順
    for m in &input.models {
        for p in &m.properties {
            if ctx.is_excluded(&p.id) {
                continue;
            }
            let Some(t) = ctx.targets.get(p.id.as_str()) else {
                missing.insert(p.id.clone());
                continue;
            };
            checks.push(property_check(m, p, t));
            sanity.extend(sanity_of(p, t));
        }
        for k in &partitions.contracts {
            if k.model_id != m.model_id || ctx.is_excluded(&k.derived_from) {
                continue;
            }
            let Some(t) = ctx.targets.get(k.id.as_str()) else {
                missing.insert(k.id.clone());
                continue;
            };
            let deps = contract_dependencies(k, partitions, &emitted);
            let id = contract_check_id(&k.id);
            checks.push(target_check(KIND_CONTRACT, id, k, t, deps));
        }
        for c in &partitions.composition_conditions {
            if c.model_id != m.model_id || ctx.is_excluded(&c.derived_from) {
                continue;
            }
            let Some(t) = ctx.targets.get(c.id.as_str()) else {
                missing.insert(c.id.clone());
                continue;
            };
            let deps = emitted_contract_ids(c.depends_on.iter(), &emitted);
            let id = format!("comp-{}", c.id);
            checks.push(target_check(KIND_COMPOSITION, id, c, t, deps));
        }
    }
    check_unique_ids(&checks, &sanity)?;
    // BTreeSet<String> の順は UTF-8 のバイト列の辞書順（order::cmp_ids と同じ）
    let missing_targets = missing.into_iter().collect();
    let out = PlanSkeletonOutput {
        checks,
        sanity,
        missing_targets,
    };
    types::output(&out)
}

/// モデルの性質の id からその性質を引く。id の重なりは CLI の入力の不備。
fn index_properties(
    models: &[SkeletonModel],
) -> Result<BTreeMap<&str, &SkeletonProperty>, InputError> {
    let mut model_ids = BTreeSet::new();
    let mut out = BTreeMap::new();
    for m in models {
        if !model_ids.insert(m.model_id.as_str()) {
            let message = format!("モデルの id {} が重なる", m.model_id);
            return Err(InputError::new(message));
        }
        for p in &m.properties {
            if out.insert(p.id.as_str(), p).is_some() {
                let message = format!("モデルの性質の id {} が重なる", p.id);
                return Err(InputError::new(message));
            }
        }
    }
    Ok(out)
}

/// `target_id` から下書きの要素を引く。
/// 重なれば先の要素を使う（重なりは CLI が下書きの欠陥にする）。
fn index_targets(targets: &[PlanTarget]) -> BTreeMap<&str, &PlanTarget> {
    let mut out = BTreeMap::new();
    for t in targets {
        out.entry(t.target_id.as_str()).or_insert(t);
    }
    out
}

/// 契約と合成の条件の `model_id` は入力のモデルのどれか（CLI はモデルで切って渡す）。
fn check_partition_models(
    models: &[SkeletonModel],
    partitions: &SkeletonPartitions,
) -> Result<(), InputError> {
    let ids: BTreeSet<&str> = models.iter().map(|m| m.model_id.as_str()).collect();
    let contracts = partitions.contracts.iter().map(|k| (&k.id, &k.model_id));
    let conds = partitions.composition_conditions.iter();
    let used = contracts.chain(conds.map(|c| (&c.id, &c.model_id)));
    for (id, model_id) in used {
        if !ids.contains(model_id.as_str()) {
            let message = format!("{id} の model_id {model_id} が入力のモデルに無い");
            return Err(InputError::new(message));
        }
    }
    Ok(())
}

/// 検査・sanity の id は 1 つの名前空間の中で一意（接頭辞が違うので、重なれば入力の不備）。
fn check_unique_ids(checks: &[PlanCheck], sanity: &[PlanSanity]) -> Result<(), InputError> {
    let mut seen = BTreeSet::new();
    let sanity_ids = sanity.iter().map(|s| &s.id);
    for id in checks.iter().map(|c| &c.id).chain(sanity_ids) {
        if !seen.insert(id.as_str()) {
            return Err(InputError::new(format!("検査の id {id} が重なる")));
        }
    }
    Ok(())
}

fn property_check(m: &SkeletonModel, p: &SkeletonProperty, t: &PlanTarget) -> PlanCheck {
    PlanCheck {
        id: format!("prop-{}", p.id),
        kind: KIND_PROPERTY.to_string(),
        target_id: p.id.clone(),
        model_id: m.model_id.clone(),
        input_refs: vec![p.query_ref.clone()],
        expected: EXPECTED.to_string(),
        assumptions: t.assumptions.clone(),
        scope: t.scope.clone(),
        tool_time_limit_seconds: t.tool_time_limit_seconds,
        depends_on: Vec::new(),
    }
}

/// `sanity[]` の要素ごとの sanity。id は 1 始まりの位置で名付け、時間の上限は性質の要素から写す。
fn sanity_of(p: &SkeletonProperty, t: &PlanTarget) -> Vec<PlanSanity> {
    let mut out = Vec::new();
    for (i, s) in p.sanity.iter().enumerate() {
        out.push(PlanSanity {
            id: format!("sanity-{}-{}", p.id, i + 1),
            model_property_id: p.id.clone(),
            input_refs: vec![s.query_ref.clone()],
            tool_time_limit_seconds: t.tool_time_limit_seconds,
        });
    }
    out
}

/// 契約と合成の条件に共通の欄。
trait Target {
    fn id(&self) -> &str;
    fn model_id(&self) -> &str;
    fn query_ref(&self) -> &str;
}

impl Target for PartitionContract {
    fn id(&self) -> &str {
        &self.id
    }
    fn model_id(&self) -> &str {
        &self.model_id
    }
    fn query_ref(&self) -> &str {
        &self.query_ref
    }
}

impl Target for CompositionCondition {
    fn id(&self) -> &str {
        &self.id
    }
    fn model_id(&self) -> &str {
        &self.model_id
    }
    fn query_ref(&self) -> &str {
        &self.query_ref
    }
}

fn target_check(
    kind: &str,
    id: String,
    x: &impl Target,
    t: &PlanTarget,
    depends_on: Vec<String>,
) -> PlanCheck {
    PlanCheck {
        id,
        kind: kind.to_string(),
        target_id: x.id().to_string(),
        model_id: x.model_id().to_string(),
        input_refs: vec![x.query_ref().to_string()],
        expected: EXPECTED.to_string(),
        assumptions: t.assumptions.clone(),
        scope: t.scope.clone(),
        tool_time_limit_seconds: t.tool_time_limit_seconds,
        depends_on,
    }
}

fn contract_check_id(id: &str) -> String {
    format!("contract-{id}")
}

/// 契約 K は、`consumer` が K の部分で、他の部分の保証に頼る境界の契約を待つ（RQ-264-022）。
fn contract_dependencies(
    k: &PartitionContract,
    partitions: &SkeletonPartitions,
    emitted: &BTreeSet<&str>,
) -> Vec<String> {
    let other = schema::role("basis_other_part");
    let mut ids = Vec::new();
    for b in &partitions.boundaries {
        if b.consumer != k.part_id || b.assumption_basis.kind != other {
            continue;
        }
        if let Some(id) = &b.assumption_basis.contract_id {
            ids.push(id);
        }
    }
    emitted_contract_ids(ids.into_iter(), emitted)
}

/// 出した契約の検査の id だけを、id の順に重なりなく返す。
fn emitted_contract_ids<'a>(
    ids: impl Iterator<Item = &'a String>,
    emitted: &BTreeSet<&str>,
) -> Vec<String> {
    let mut out = BTreeSet::new();
    for id in ids {
        if emitted.contains(id.as_str()) {
            out.insert(contract_check_id(id));
        }
    }
    out.into_iter().collect()
}
