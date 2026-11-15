// 首次导览的「看过了」状态（server-web-console「首次进入提供可略过的分步导览」）。
//
// 这是浏览器端偏好而非服务器真相——它不影响任何授权或数据，存服务器要添加 identity
// 字段、migration 与 API，为一个一次性提示不值得。代价是换浏览器会再看到一次。
//
// 隐私模式或停用保存时 localStorage 的读写会丢例外，一律吞掉：读失败＝视为未看过
// （导览照常出现），写失败＝不持久化（导览照常结束）。

const KEY = "specseal.tourSeen";
const SEEN = "1";

/** 缺键、值不是 "1"、或保存不可用，一律视为未看过。 */
export function readTourSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === SEEN;
  } catch {
    return false;
  }
}

export function writeTourSeen(seen: boolean): void {
  try {
    if (seen) localStorage.setItem(KEY, SEEN);
    else localStorage.removeItem(KEY);
  } catch {
    // 不持久化即可，不影响本次导览。
  }
}
