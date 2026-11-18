// adapter の一覧。CLI が実行できる道具は adapter のある Z3 だけ（artifact-formats.md「plan と mutations」の道具の名前）。
import * as z3 from './z3.mjs';

export const ADAPTERS = Object.freeze({ [z3.ID]: z3 });

export const RUNNABLE_TOOLS = Object.freeze(Object.keys(ADAPTERS));

// 「適した道具が無い」の述語の正本（計画の照合の検査の欠けの免除と、集約の no_suitable_tool）。
// 道具を準備して失敗したか、性質の selection が CLI の実行できない道具を選んだとき。準備していなければ（prepare が null）偽。
export function noSuitableTool(prepare, selection) {
  if (prepare && !prepare.ok) return true;
  return selection !== null && selection !== undefined && !RUNNABLE_TOOLS.includes(selection.chosen.tool);
}
