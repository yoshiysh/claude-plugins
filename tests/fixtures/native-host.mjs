// native host は agent() / parallel() の境界で値を JSON 往復させる（Map などは空の object に化ける）。
// 模擬側でも同じ往復をかけ、境界を越える値が JSON で表せない形になっていれば全テストで落ちるようにする。
export const roundTrip = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export const hostAgent = (agent) => async (prompt, opts) => roundTrip(await agent(prompt, opts));

// runner と同じく throw を catch しない Promise.all。thunk の throw が run を落とさないことをテスト側で確かめられる。
export const hostParallel = (tasks) => Promise.all(tasks.map((task) => Promise.resolve(task()).then(roundTrip)));
