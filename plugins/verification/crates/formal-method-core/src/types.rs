//! サブコマンドの入出力の型。欄の名前は `core.schema.json` の `$defs` の欄の名前どおりに書く（SP-264-003）。
//! 入力の型は未知の欄を拒む（型に合わない入力を exit 2 にする。SP-264-005）。
//! 列挙の欄は `String` で持ち、値は schema の列挙と照らす（列挙の値を variant の名前に写さない。DD-3）。

use crate::error::InputError;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 入力の JSON を型に読む。
pub fn parse<T: DeserializeOwned>(input: Value) -> Result<T, InputError> {
    serde_json::from_value(input).map_err(type_error)
}

/// 出力の型を JSON の値にする。
pub fn output<T: Serialize>(value: &T) -> Result<Value, InputError> {
    serde_json::to_value(value).map_err(output_error)
}

fn type_error(e: serde_json::Error) -> InputError {
    InputError::new(format!("入力が型に合わない: {e}"))
}

fn output_error(e: serde_json::Error) -> InputError {
    InputError::new(format!("出力を JSON にできない: {e}"))
}

// ---- 共通（`$defs` の同じ名前の型） ----

/// `$defs/SourceRef`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRef {
    pub target_id: String,
    pub file: String,
    pub span: String,
}

/// `$defs/LocationSource`（`kind` は location）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocationSource {
    pub kind: String,
    pub target_id: String,
    pub file: String,
    pub span: String,
}

/// `$defs/Pointer`。kind が location なら `target_id`・`file`・`span`（無くてよい）、他は `id`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Pointer {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<String>,
}

/// `$defs/AssumptionBasis`。kind は `$defs/AssumptionBasisKind` の値で、kind ごとに 1 つの欄を持つ。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssumptionBasis {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_requirement_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `$defs/Part`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Part {
    pub id: String,
    pub model_id: String,
    pub owns_variables: Vec<String>,
    pub transitions: Vec<String>,
}

/// `$defs/Boundary`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Boundary {
    pub edge_id: String,
    pub producer: String,
    pub consumer: String,
    pub shared_symbols: Vec<String>,
    pub assumption: String,
    pub guarantee: String,
    pub assumption_basis: AssumptionBasis,
    pub responsible: Vec<String>,
}

/// `$defs/DraftBoundary`（分割作成役の下書きの境界）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftBoundary {
    pub edge_id: String,
    pub assumption: String,
    pub guarantee: String,
    pub assumption_basis: AssumptionBasis,
    pub responsible: Vec<String>,
}

/// `$defs/PartitionContract`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartitionContract {
    pub id: String,
    pub model_id: String,
    pub derived_from: String,
    pub part_id: String,
    pub statement: String,
    pub query_ref: String,
}

/// `$defs/CompositionCondition`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompositionCondition {
    pub id: String,
    pub model_id: String,
    pub derived_from: String,
    pub statement: String,
    pub query_ref: String,
    pub depends_on: Vec<String>,
}

/// `$defs/Decision`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub candidate_id: String,
    pub adopted: bool,
    pub reason: String,
}

/// `$defs/PlanTarget`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanTarget {
    pub target_id: String,
    pub tool_time_limit_seconds: u64,
    pub assumptions: Vec<String>,
    pub scope: String,
}

/// `$defs/ReviewItem`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewItem {
    pub r#ref: String,
    pub result: String,
}

/// 出所を持つ inventory の要素（mapping-rows・omission-candidates の入力と出力）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourcedElement {
    pub id: String,
    pub source: SourceRef,
}

// ---- partition-models（SP-264-010・011） ----

/// `$defs/PartitionModelsInput`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartitionModelsInput {
    pub properties: Vec<ModelProperty>,
    pub previous: Vec<ModelAssignment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelProperty {
    pub id: String,
    pub source_ids: Vec<String>,
    pub formalizable: bool,
}

/// モデルと性質の割り当て（前回の割り当てと出力のモデル）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelAssignment {
    pub model_id: String,
    pub property_ids: Vec<String>,
}

/// `$defs/PartitionModelsOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PartitionModelsOutput {
    pub models: Vec<ModelAssignment>,
}

// ---- plan-skeleton（SP-264-020） ----

/// `$defs/PlanSkeletonInput`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanSkeletonInput {
    pub models: Vec<SkeletonModel>,
    pub partitions: Option<SkeletonPartitions>,
    pub excluded_property_ids: Vec<String>,
    pub targets: Vec<PlanTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkeletonModel {
    pub model_id: String,
    pub properties: Vec<SkeletonProperty>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkeletonProperty {
    pub id: String,
    pub inventory_property_ids: Vec<String>,
    pub query_ref: String,
    pub sanity: Vec<SanityQuery>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SanityQuery {
    pub query_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkeletonPartitions {
    pub parts: Vec<Part>,
    pub boundaries: Vec<Boundary>,
    pub contracts: Vec<PartitionContract>,
    pub composition_conditions: Vec<CompositionCondition>,
}

/// `$defs/PlanSkeletonOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanSkeletonOutput {
    pub checks: Vec<PlanCheck>,
    pub sanity: Vec<PlanSanity>,
    pub missing_targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanCheck {
    pub id: String,
    pub kind: String,
    pub target_id: String,
    pub model_id: String,
    pub input_refs: Vec<String>,
    pub expected: String,
    pub assumptions: Vec<String>,
    pub scope: String,
    pub tool_time_limit_seconds: u64,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanSanity {
    pub id: String,
    pub model_property_id: String,
    pub input_refs: Vec<String>,
    pub tool_time_limit_seconds: u64,
}

// ---- partition-assemble（SP-264-023） ----

/// `$defs/PartitionAssembleInput`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartitionAssembleInput {
    pub candidates: Vec<Candidate>,
    pub graph_edges: Vec<GraphEdge>,
    pub decisions: Vec<Decision>,
    pub boundaries: Vec<DraftBoundary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub id: String,
    pub nodes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
}

/// `$defs/PartitionAssembleOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PartitionAssembleOutput {
    pub adopted: bool,
    pub parts: Vec<Part>,
    pub boundaries: Vec<Boundary>,
    pub missing_boundaries: Vec<String>,
    pub extra_boundaries: Vec<String>,
}

// ---- mapping-rows（SP-264-025） ----

/// `$defs/MappingRowsInput`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MappingRowsInput {
    pub model_id: String,
    pub properties: Vec<MappingProperty>,
    pub elements: Vec<SourcedElement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MappingProperty {
    pub id: String,
    pub source_ids: Vec<String>,
    pub formalizable: bool,
    pub nonformal_reason: Option<String>,
}

/// `$defs/MappingRowsOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MappingRowsOutput {
    pub rows: Vec<MappingRow>,
}

/// 骨組みの行。`relation`・`reason` は形式化できる性質の行で null。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MappingRow {
    pub row_id: String,
    pub source: LocationSource,
    pub property_id: String,
    pub relation: Option<String>,
    pub reason: Option<String>,
}

// ---- extract-skeleton（SP-264-026） ----

/// `$defs/ExtractSkeletonInput`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtractSkeletonInput {
    pub target_id: String,
    pub files: Vec<TargetFile>,
    pub scope: Vec<ScopeEntry>,
    pub references: Vec<ExternalReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetFile {
    pub path: String,
    pub text: bool,
    pub lines: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeEntry {
    pub file: String,
    pub spans: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalReference {
    pub id: String,
    pub file: String,
    pub line: u64,
}

/// `$defs/ExtractSkeletonOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExtractSkeletonOutput {
    pub scanned: Vec<Scanned>,
    pub external_dependencies: Vec<ExternalDependency>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Scanned {
    pub file: String,
    pub span: Option<String>,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalDependency {
    pub id: String,
    pub text: String,
    pub source: SourceRef,
}

// ---- omission-candidates（SP-264-027） ----

/// `$defs/OmissionCandidatesInput`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OmissionCandidatesInput {
    pub elements: Vec<SourcedElement>,
    pub cited_ids: Vec<String>,
    pub rows: Vec<SourcedRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcedRow {
    pub source: Pointer,
}

/// `$defs/OmissionCandidatesOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OmissionCandidatesOutput {
    pub candidates: Vec<SourcedElement>,
}

// ---- review-tally（SP-264-028） ----

/// `$defs/ReviewTallyInput`。`findings` は件数だけを使う。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewTallyInput {
    pub findings: Vec<Map<String, Value>>,
    pub items: Vec<ReviewItem>,
}

/// `$defs/ReviewTallyOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewTallyOutput {
    pub result: String,
}

// ---- complete-return（SP-264-029） ----

/// `$defs/CompleteReturnInput`。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteReturnInput {
    pub task: ReturnTask,
    pub worklog: Map<String, Value>,
    pub ret: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReturnTask {
    pub task_id: String,
    pub role: String,
    pub stage: String,
    pub target: String,
    pub unit_id: Option<String>,
    pub perspective: Option<String>,
}

/// `$defs/CompleteReturnOutput`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompleteReturnOutput {
    pub worklog: Map<String, Value>,
    pub ret: Map<String, Value>,
    pub problems: Vec<String>,
}
