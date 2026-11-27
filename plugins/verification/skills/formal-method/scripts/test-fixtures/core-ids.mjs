// 実行体 formal-method-core が決める id の期待値（#264）。テストの期待値の側の写しで、実装の規則を確かめる口に使う。
// - model_id（SP-264-011 の規則 3。この変更の CLI は previous: [] を渡すので、どの成分も m-<h>）:
//   成分の性質の id を UTF-8 のバイト列の辞書順に並べ、改行でつないだ SHA-256 の 16 進の先頭 12 文字。
// - モデルの性質の id（SP-264-012）: <model_id>. で始める。harness は <model_id>.<scenario.modelPropPrefix><inventory の性質の id> にする。
// - 計画の検査の id（SP-264-020）: prop-<モデルの性質>・contract-<契約>・comp-<合成の条件>・sanity-<モデルの性質>-<n>。
//   計画を担当が書く形（plan-skeleton の前）でも、harness は同じ id で書く（単位をまたいで期待値を変えないため）。
import { createHash } from 'node:crypto';

const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export const modelIdOf = (propertyIds) => `m-${createHash('sha256').update([...propertyIds].sort(cmpBytes).join('\n'), 'utf8').digest('hex').slice(0, 12)}`;
// component: その性質が属する形式の成分（既定はその性質だけ。harness の性質は既定で出所を共有しない）
export const mpOf = (pid, { prefix = '', component = [pid] } = {}) => `${modelIdOf(component)}.${prefix}${pid}`;
export const checkIds = {
  prop: (mp) => `prop-${mp}`,
  sanity: (mp, n = 1) => `sanity-${mp}-${n}`,
  contract: (id) => `contract-${id}`,
  comp: (id) => `comp-${id}`,
  mutation: (mp) => `MU-${mp}`,
};

// よく使う値: 性質 P1・P2 だけの成分のモデル
export const M1 = modelIdOf(['P1']);
export const M2 = modelIdOf(['P2']);
export const MP1 = mpOf('P1');
export const MP2 = mpOf('P2');
export const C_P1 = checkIds.prop(MP1);
export const C_P2 = checkIds.prop(MP2);
export const S_P1 = checkIds.sanity(MP1);
export const MU_P1 = checkIds.mutation(MP1);
export const C_K_A = checkIds.contract('K-a');
export const C_CC1 = checkIds.comp('CC1');
export const C_CC2 = checkIds.comp('CC2');
