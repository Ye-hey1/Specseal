// 行↔条目转换（design D2）：一行一条——保存时逐行修剪头尾空白、空行涤除，行序即写入顺序。
// 产出规则、审查规则与子代理模型的自订清单共用。

export const entriesToText = (entries: string[]) => entries.join("\n");

export const textToEntries = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** 草稿文本→条目，没编辑的节原样沿用现值（review R3）：文件里手写的多行条目显示成多行，
 * 重新拆行会变成多条——只有用户改过的节才照「一行一条」重切。 */
export const keepUnedited = (text: string, entries: string[]) =>
  text === entriesToText(entries) ? entries : textToEntries(text);
